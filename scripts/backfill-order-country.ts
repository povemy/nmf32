// Seller Insights — one-time historical backfill for Order.shippingCountryCode.
//
// RULE (docs/seller-insights/metric-definitions.md): historical orders have no
// recorded destination country. The checkout route has ALWAYS validated a
// 5-digit Malaysian postcode, and the buyer UI offered only the 16 Malaysian
// states/territories. Therefore a frozen shippingAddressJson containing BOTH a
// valid 5-digit postcode AND a known MY state is labelled 'MY' with source
// 'backfill' (explicitly marked, never presented as checkout-time data).
// Anything else → 'ZZ' (Unspecified). Idempotent: rows whose
// shippingCountrySource is non-empty are skipped. Never touches customer
// profile addresses — only the order's own frozen snapshot.
import { db } from "../src/lib/db";

const MY_STATES = new Set([
  "Johor", "Kedah", "Kelantan", "Kuala Lumpur", "Labuan", "Melaka", "Negeri Sembilan",
  "Pahang", "Penang", "Perak", "Perlis", "Putrajaya", "Sabah", "Sarawak", "Selangor", "Terengganu",
]);

type Addr = { line1?: unknown; city?: unknown; state?: unknown; postcode?: unknown };

function classify(addr: Addr): "MY" | "ZZ" {
  const state = typeof addr.state === "string" ? addr.state.trim() : "";
  const postcode = typeof addr.postcode === "string" ? addr.postcode.trim() : "";
  if (MY_STATES.has(state) && /^\d{5}$/.test(postcode)) return "MY";
  return "ZZ";
}

const before = await db.order.count();
const pending = await db.order.count({ where: { shippingCountrySource: "" } });
console.log(`orders total=${before}, pending backfill=${pending}`);

let myCount = 0;
let zzCount = 0;
const BATCH = 500;
let cursor: string | null = null;
do {
  const rows = await db.order.findMany({
    where: { shippingCountrySource: "" },
    select: { id: true, shippingAddressJson: true },
    take: BATCH,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    orderBy: { id: "asc" },
  });
  if (rows.length === 0) break;
  cursor = rows[rows.length - 1].id;

  const myIds: string[] = [];
  const zzIds: string[] = [];
  for (const r of rows) {
    let addr: Addr = {};
    try { addr = JSON.parse(r.shippingAddressJson || "{}") as Addr; } catch { /* ZZ */ }
    (classify(addr) === "MY" ? myIds : zzIds).push(r.id);
  }
  if (myIds.length > 0) {
    await db.order.updateMany({ where: { id: { in: myIds } }, data: { shippingCountryCode: "MY", shippingCountrySource: "backfill" } });
    myCount += myIds.length;
  }
  if (zzIds.length > 0) {
    await db.order.updateMany({ where: { id: { in: zzIds } }, data: { shippingCountryCode: "ZZ", shippingCountrySource: "backfill" } });
    zzCount += zzIds.length;
  }
} while (true);

const afterPending = await db.order.count({ where: { shippingCountrySource: "" } });
console.log(`backfill done: MY=${myCount}, ZZ(Unspecified)=${zzCount}, remaining pending=${afterPending}`);
console.log(`row count check: total before=${before}, total after=${await db.order.count()} (must be equal)`);
await db.$disconnect();
