// ============================================================================
// rebrand-db.ts — Task 14-d SHOPMESH → NOMOFEE database rebrand (idempotent).
//
// Rewrites the @shopmesh.io (seller/admin) and @shopmesh.test (buyer) email
// domains to @nomofee.io / @nomofee.test everywhere they can persist:
//   • scalar email/label columns (ShopperUser, Seller, AdminUser, Order,
//     CouponRedemption, AdminAuditLog, ActivityLog, NotificationLog,
//     SupportTicket, SupportMessage, KycDocument, SellerNote, Store)
//   • denormalised/JSON text columns that may embed those emails
//     (audit before/after JSON, activity meta, notification data, ledger
//     descriptions/memos, payout statements, webhook payloads)
//
// DO NOT TOUCH (by design — see RECOVERY.md Task 11/12):
//   • password hashes / credentials (nothing here writes password columns)
//   • the `sm_session` cookie name (auth code only — not stored data)
//   • the secretbox dev-key material (src/lib/secretbox.ts)
//
// Safe to re-run: every UPDATE matches only rows still containing the old
// domain, so a second run finds nothing to change.
// Run: bunx tsx scripts/rebrand-db.ts
// ============================================================================
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const MAPS: [RegExp, string][] = [
  [/@shopmesh\.io/gi, "@nomofee.io"],
  [/@shopmesh\.test/gi, "@nomofee.test"],
];

function rebrand(text: string): string {
  let out = text;
  for (const [re, to] of MAPS) out = out.replace(re, to);
  return out;
}

/** Column kinds: "email" = scalar email/label columns; "json" = text/JSON
 *  blobs that may embed emails. Only rows still containing @shopmesh.* are
 *  rewritten (idempotency guard). */
type Col = { table: string; field: string; kind: "email" | "json" };

const COLUMNS: Col[] = [
  { table: "shopperUser", field: "email", kind: "email" },
  { table: "seller", field: "email", kind: "email" },
  { table: "adminUser", field: "email", kind: "email" },
  { table: "order", field: "customerEmail", kind: "email" },
  { table: "couponRedemption", field: "customerEmail", kind: "email" },
  { table: "store", field: "supportEmail", kind: "email" },
  { table: "kycDocument", field: "reviewedBy", kind: "email" },
  { table: "sellerNote", field: "author", kind: "email" },
  { table: "supportTicket", field: "sellerEmail", kind: "email" },
  { table: "supportMessage", field: "authorLabel", kind: "email" },
  { table: "activityLog", field: "actorLabel", kind: "email" },
  { table: "notificationLog", field: "recipient", kind: "email" },
  { table: "adminAuditLog", field: "adminEmail", kind: "email" },
  // JSON / denormalised text blobs that may embed emails
  { table: "adminAuditLog", field: "beforeJson", kind: "json" },
  { table: "adminAuditLog", field: "afterJson", kind: "json" },
  { table: "activityLog", field: "metaJson", kind: "json" },
  { table: "notification", field: "dataJson", kind: "json" },
  { table: "payout", field: "statementJson", kind: "json" },
  { table: "paymentWebhookLog", field: "payloadJson", kind: "json" },
  { table: "webhookDelivery", field: "payloadJson", kind: "json" },
  { table: "ledgerTransaction", field: "description", kind: "json" },
  { table: "ledgerLine", field: "memo", kind: "json" },
];

type Row = { id: string | number } & Record<string, string | null>;

type AnyModel = {
  findMany: (args: unknown) => Promise<Row[]>;
  update: (args: unknown) => Promise<unknown>;
  count: (args: unknown) => Promise<number>;
};

function modelOf(table: string): AnyModel | undefined {
  return (db as unknown as Record<string, AnyModel>)[table];
}

async function rebrandColumn(col: Col): Promise<number> {
  const model = modelOf(col.table);
  if (!model) {
    console.warn(`  ! unknown table ${col.table} — skipped`);
    return 0;
  }
  const rows = await model.findMany({
    where: { [col.field]: { contains: "@shopmesh." } },
    select: { id: true, [col.field]: true },
  });
  let updated = 0;
  for (const r of rows) {
    const v = r[col.field];
    if (typeof v !== "string") continue;
    const next = rebrand(v);
    if (next === v) continue;
    await model.update({ where: { id: r.id }, data: { [col.field]: next } });
    updated++;
  }
  return updated;
}

async function main() {
  console.log("NOMOFEE DB rebrand — rewriting @shopmesh.io/.test emails…");
  let total = 0;
  for (const col of COLUMNS) {
    const n = await rebrandColumn(col);
    if (n > 0) console.log(`  ${col.table}.${col.field}: ${n} row(s) updated`);
    total += n;
  }
  console.log(`done — ${total} row(s) rewritten.`);

  // Post-check: nothing with the old domain may remain in the swept columns.
  let remaining = 0;
  for (const col of COLUMNS) {
    const model = modelOf(col.table);
    if (!model) continue;
    remaining += await model.count({ where: { [col.field]: { contains: "@shopmesh." } } });
  }
  console.log(remaining === 0 ? "verify: no @shopmesh.* emails remain ✓" : `verify: WARNING ${remaining} row(s) still reference @shopmesh.*`);
  await db.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(1);
});
