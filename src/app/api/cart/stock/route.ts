import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";

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
//
// PHASE 2.2 GUEST CHECKOUT RESTORATION: the probe no longer requires sign-in —
// it is a pure public-data read (stock is already exposed on product pages)
// and the guest cart drawer needs it exactly like the account one.
export const GET = handle(async (req: Request) => {
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
      // seller status rides along for the C1.3 purchasability check below.
      product: { select: { status: true, store: { select: { status: true, seller: { select: { status: true } } } } } },
    },
  });

  const stocks: Record<string, { stock: number; moq: number; purchasable: boolean }> = {};
  for (const v of variants) {
    stocks[v.id] = {
      stock: v.stock,
      moq: Math.max(1, v.moq),
      // C1.3 (seller publication governance): this probe must agree with
      // checkout pricing — only an active product in a live store of an
      // admin-approved seller is purchasable (a null/unlinked seller never is).
      purchasable:
        v.isActive &&
        v.product.status === "active" &&
        v.product.store.status === "live" &&
        v.product.store.seller?.status === "active",
    };
  }

  return ok({ stocks });
});
