import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody, str } from "@/app/api/admin/_helpers";

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

  return ok({ ...ticket, store });
});

// PATCH /api/admin/tickets/[id] {status?, priority?}
export const PATCH = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireAdmin();
  const { id } = await ctx.params;
  const body = await readBody(req);

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

  return ok(updated);
});
