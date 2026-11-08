import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody, reqStr } from "@/app/api/admin/_helpers";
import type { AdminTicketReplyBody, AdminTicketReplyData } from "@/lib/types/api-contract";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/tickets/[id]/reply {body}
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireAdmin();
  const { id } = await ctx.params;
  const payload = (await readBody(req)) as AdminTicketReplyBody & Record<string, unknown>;
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

  const result: AdminTicketReplyData = {
    message: {
      id: message.id,
      ticketId: message.ticketId,
      authorType: message.authorType,
      authorLabel: message.authorLabel,
      body: message.body,
      createdAt: message.createdAt.toISOString(),
    },
    ticket: {
      id: updated.id,
      storeId: updated.storeId,
      sellerEmail: updated.sellerEmail,
      subject: updated.subject,
      status: updated.status,
      priority: updated.priority,
      contextType: updated.contextType,
      contextId: updated.contextId,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    },
  };
  return ok(result);
});
