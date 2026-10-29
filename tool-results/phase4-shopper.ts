import { db } from "../src/lib/db";
const shoppers = await db.shopperUser.findMany({ orderBy: { createdAt: "desc" }, select: { id: true, email: true, fullName: true, createdAt: true }, take: 6 });
console.log(JSON.stringify(shoppers, null, 1));
process.exit(0);
