import { db } from "../src/lib/db";
const grouped = await db.voucher.groupBy({ by: ["scope"], _count: { _all: true } });
console.log("voucher scopes:", JSON.stringify(grouped));
const sellerVouchers = await db.voucher.findMany({ where: { scope: "STORE" }, select: { id: true, code: true, isActive: true, storeId: true }, take: 3 });
console.log("sample STORE vouchers:", JSON.stringify(sellerVouchers, null, 1));
process.exit(0);
