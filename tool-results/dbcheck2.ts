import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const threads = await db.chatThread.count();
const msgs = await db.chatMessage.count();
const cols = await db.$queryRawUnsafe<{ name: string }[]>(`PRAGMA table_info(ChatMessage)`);
console.log("threads:", threads, "messages:", msgs, "chatMessageCols:", cols.map((c) => c.name).join(","));
await db.$disconnect();
