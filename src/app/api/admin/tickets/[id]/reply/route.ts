import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody, reqStr } from "@/app/api/admin/_helpers";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/tickets/[id]/reply {body}
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireAdmin();
  const { id } = await ctx.params;
  const payload = await readBody(req);
  const text = reqStr(payload, "body", "body");

  const ticket = await db.supportTicket.findUnique({ where: { id } });
  if (!ticket) throw new ApiError(404, "NOT_FOUND", "Ticket not found");

  const message = await db.supportMessage.create({
    data: { ticketId: id, authorType: "admin", authorLabel: admin.name, body: text },
  });
  // admin reply moves the ticket to pending (awaiting seller)
  const updated = await db.supportTicket.update({ where: { id }, data: { status: "pending" } });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "ticket.reply",
    entityType: "support_ticket",
    entityId: id,
    before: { status: ticket.status },
    after: { status: "pending", messageId: message.id },
  });

  return ok({ message, ticket: updated });
});
