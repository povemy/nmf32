import { db } from "../src/lib/db";
const store = await db.store.findFirst({ where: { status: "live" }, select: { id: true, name: true } });
console.log(JSON.stringify(store));
process.exit(0);
