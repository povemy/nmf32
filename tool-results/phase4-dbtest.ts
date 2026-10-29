import { db } from "../src/lib/db";
// reproduce the sentinel query
try {
  const rows = await db.commissionOverride.findMany({
    where: { OR: [{ scope: "product", productId: "\u0000none" }, { scope: "category", categoryId: { in: ["\u0000none"] } }] },
  });
  console.log("NUL sentinel query OK, rows:", rows.length);
} catch (e) {
  console.log("NUL sentinel query FAILED:", (e as Error).message.slice(0, 200));
}
try {
  const rows = await db.commissionOverride.findMany({
    where: { OR: [{ scope: "product", productId: "__none__" }, { scope: "category", categoryId: { in: ["__none__"] } }] },
  });
  console.log("plain sentinel query OK, rows:", rows.length);
} catch (e) {
  console.log("plain sentinel query FAILED:", (e as Error).message.slice(0, 200));
}
process.exit(0);
