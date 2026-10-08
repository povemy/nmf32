import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody, reqStr } from "@/app/api/admin/_helpers";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/admin/sellers/[id]/notes
export const GET = handle(async (req: NextRequest, ctx: Ctx) => {
  await requireAdmin();
  const { id } = await ctx.params;
  const notes = await db.sellerNote.findMany({ where: { sellerId: id }, orderBy: { createdAt: "desc" } });
  return ok(notes);
});

// POST /api/admin/sellers/[id]/notes {body}
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireAdmin();
  const { id } = await ctx.params;
  const payload = await readBody(req);
  const text = reqStr(payload, "body", "body");

  const seller = await db.seller.findUnique({ where: { id } });
  if (!seller) throw new ApiError(404, "NOT_FOUND", "Seller not found");

  const note = await db.sellerNote.create({ data: { sellerId: id, author: admin.name, body: text } });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "seller.note.add",
    entityType: "seller",
    entityId: id,
    after: { noteId: note.id, body: text },
  });

  return ok(note);
});
