// POST /api/import/jobs/[id]/claim/validate — validate a raw claim token and
// return the generated store identity + verification method (public; binding
// happens in /api/claim/bind with an authenticated seller account).
// NOTE (p10-a): handler normalised to the repo-standard `handle(...)` pattern
// (previously returned the wrapped function instead of a Response → 500).
import { NextRequest } from "next/server";
import { handle, ok, ApiError } from "@/lib/api";
import { db } from "@/lib/db";
import { validateClaimToken } from "@/lib/import/runner";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { claimToken?: string };
  if (!body.claimToken) throw new ApiError(400, "MISSING_CLAIM_TOKEN", "Claim token is required.");
  const info = await validateClaimToken(id, body.claimToken);
  const store = await db.store.findUnique({
    where: { id: info.storeId },
    select: { id: true, name: true, slug: true, tagline: true, logoUrl: true, _count: { select: { products: true } } },
  });
  return ok({
    ...info,
    store: store
      ? { id: store.id, name: store.name, slug: store.slug, tagline: store.tagline, logoUrl: store.logoUrl, productCount: store._count.products }
      : null,
  });
});
