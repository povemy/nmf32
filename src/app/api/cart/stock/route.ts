import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireShopper } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET /api/cart/stock?ids=variantId1,variantId2 — the cart's live-stock probe.
//
// WHY THIS EXISTS (launch-rush safety): the cart drawer renders from the shared
// client store, which only knows the stock snapshot taken when the cart was
// last fetched. Before the buyer starts changing quantities (or checking out),
// we refresh ONLY the volatile numbers — stock / moq / purchasability — with
// ONE tiny indexed query and a few-hundred-byte payload:
//   • no cart include explosion (no product images/store joins),
//   • no writes, no locks, nothing to scale — Postgres answers it from the PK
//     index in well under a millisecond even mid-launch,
//   • the client then clamps quantities LOCALLY (instant UI, zero extra calls),
//     while checkout/create still runs the authoritative atomic decrement.
// Client clamping + this probe + the conditional UPDATE at checkout = a
// three-layer guard against over-ordering during an influencer drop, with no
// reservation tables or extra services to pay for.
export const GET = handle(async (req: Request) => {
  await requireShopper();

  const url = new URL(req.url);
  const ids = (url.searchParams.get("ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 100); // hard cap — a cart is far smaller than this

  if (ids.length === 0) throw new ApiError(400, "VALIDATION", "ids is required");

  const variants = await db.productVariant.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      stock: true,
      moq: true,
      isActive: true,
      product: { select: { status: true, store: { select: { status: true } } } },
    },
  });

  const stocks: Record<string, { stock: number; moq: number; purchasable: boolean }> = {};
  for (const v of variants) {
    stocks[v.id] = {
      stock: v.stock,
      moq: Math.max(1, v.moq),
      purchasable: v.isActive && v.product.status === "active" && v.product.store.status === "live",
    };
  }

  return ok({ stocks });
});
