import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const shoppers = await db.shopperUser.findMany({ select: { id: true, email: true, status: true } });
console.log(JSON.stringify(shoppers));
await db.$disconnect();
