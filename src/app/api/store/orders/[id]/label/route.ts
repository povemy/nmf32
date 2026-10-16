import { db } from "@/lib/db";
import { ApiError, handle } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// GET /api/store/orders/[id]/label — AWB label stream (SVG) for a platform
// booking. The shipment stores the label as an inline SVG data-URL (offline
// pipeline), so we decode and stream it back as image/svg+xml.
export const GET = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { store } = await requireActiveSellerStore();
  const { id } = await ctx.params;

  const order = await db.order.findFirst({
    where: { OR: [{ id }, { orderNumber: id }], storeId: store.id },
    select: { id: true, orderNumber: true },
  });
  if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");

  const shipment = await db.shipment.findUnique({ where: { orderId: order.id } });
  if (!shipment?.labelUrl?.startsWith("data:image/svg+xml;base64,")) {
    throw new ApiError(404, "LABEL_NOT_FOUND", "No platform shipping label for this order — book one via the ship dialog");
  }

  const svg = Buffer.from(shipment.labelUrl.slice("data:image/svg+xml;base64,".length), "base64").toString("utf8");
  const download = new URL(req.url).searchParams.get("download") === "1";
  return new NextResponse(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="AWB-${shipment.awbNumber ?? order.orderNumber}.svg"`,
      "Cache-Control": "private, max-age=3600",
    },
  });
});
