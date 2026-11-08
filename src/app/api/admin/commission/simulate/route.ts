import { NextRequest } from "next/server";
import { handle, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { simulateCommission } from "@/lib/commission";
import { readBody, optNum } from "@/app/api/admin/_helpers";
import type { SimulateBody, SimulateData } from "@/lib/types/api-contract";

// POST /api/admin/commission/simulate — pure computation, admin-only
export const POST = handle(async (req: NextRequest) => {
  await requireAdmin();
  const body = (await readBody(req)) as SimulateBody & Record<string, unknown>;

  const result = await simulateCommission({
    priceMinor: Math.round(optNum(body, "priceMinor") ?? 0),
    qty: Math.round(optNum(body, "qty") ?? 1),
    discountMinor: Math.round(optNum(body, "discountMinor") ?? 0),
    shippingMinor: Math.round(optNum(body, "shippingMinor") ?? 0),
    categoryId: typeof body.categoryId === "string" && body.categoryId !== "" ? body.categoryId : null,
    sellerId: typeof body.sellerId === "string" && body.sellerId !== "" ? body.sellerId : null,
    productId: typeof body.productId === "string" && body.productId !== "" ? body.productId : null,
  });

  const payload: SimulateData = result;
  return ok(payload);
});
