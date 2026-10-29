import { db } from "../src/lib/db";
const sellers = await db.seller.findMany({ where: { status: "active" }, select: { id: true, email: true, displayName: true } });
const withPayouts = await db.payout.findMany({ distinct: ["sellerId"], select: { sellerId: true } });
const set = new Set(withPayouts.map((p) => p.sellerId));
const free = sellers.filter((s) => !set.has(s.id)).slice(0, 5);
console.log(JSON.stringify(free.map((s) => ({ email: s.email, name: s.displayName })), null, 1));
process.exit(0);
