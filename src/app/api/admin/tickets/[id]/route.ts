import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody, str } from "@/app/api/admin/_helpers";
import type { AdminTicketDetailData, AdminTicketMessage, AdminTicketPatchBody, AdminTicketSummary } from "@/lib/types/api-contract";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/admin/tickets/[id] — ticket with full message thread
export const GET = handle(async (req: NextRequest, ctx: Ctx) => {
  await requireAdmin();
  const { id } = await ctx.params;

  const ticket = await db.supportTicket.findUnique({
    where: { id },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  if (!ticket) throw new ApiError(404, "NOT_FOUND", "Ticket not found");

  // store resolved manually (no relation declared on SupportTicket)
  const store = ticket.storeId ? await db.store.findUnique({ where: { id: ticket.storeId }, select: { id: true, name: true, slug: true } }) : null;

  const payload: AdminTicketDetailData = {
    id: ticket.id,
    storeId: ticket.storeId,
    sellerEmail: ticket.sellerEmail,
    subject: ticket.subject,
    status: ticket.status,
    priority: ticket.priority,
    contextType: ticket.contextType,
    contextId: ticket.contextId,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
    messages: ticket.messages.map(
      (m): AdminTicketMessage => ({
        id: m.id,
        ticketId: m.ticketId,
        authorType: m.authorType,
        authorLabel: m.authorLabel,
        body: m.body,
        createdAt: m.createdAt.toISOString(),
      })
    ),
    store,
  };
  return ok(payload);
});

// PATCH /api/admin/tickets/[id] {status?, priority?}
export const PATCH = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireAdmin();
  const { id } = await ctx.params;
  const body = (await readBody(req)) as AdminTicketPatchBody & Record<string, unknown>;

  const ticket = await db.supportTicket.findUnique({ where: { id } });
  if (!ticket) throw new ApiError(404, "NOT_FOUND", "Ticket not found");

  const data: { status?: string; priority?: string } = {};
  const status = str(body, "status");
  if (status != null) {
    if (!["open", "pending", "closed"].includes(status)) throw new ApiError(400, "VALIDATION", "status must be open | pending | closed");
    data.status = status;
  }
  const priority = str(body, "priority");
  if (priority != null) {
    if (!["low", "normal", "high", "urgent"].includes(priority)) throw new ApiError(400, "VALIDATION", "priority must be low | normal | high | urgent");
    data.priority = priority;
  }
  if (Object.keys(data).length === 0) throw new ApiError(400, "VALIDATION", "Nothing to update");

  const updated = await db.supportTicket.update({ where: { id }, data });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "ticket.update",
    entityType: "support_ticket",
    entityId: id,
    before: { status: ticket.status, priority: ticket.priority, subject: ticket.subject },
    after: data,
  });

  const payload: AdminTicketSummary = {
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
  };
  return ok(payload);
});
