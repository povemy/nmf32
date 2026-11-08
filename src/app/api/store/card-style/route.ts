import { handle, ok, ApiError } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { db } from "@/lib/db";
import { CARD_ALIGNMENTS, CARD_FONT_SIZES, FONT_OPTIONS, fontLabel } from "@/lib/fonts";
import { bustPublicCacheSafe, PUBLIC_CACHE_TAGS } from "@/lib/public-cache";
import type { CardStyleData, CardStyleBody, CardStyleSaveData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

function validFont(v: unknown, field: string): string {
  const id = typeof v === "string" ? v : "";
  if (!FONT_OPTIONS.some((f) => f.id === id)) throw new ApiError(400, "BAD_FONT", `${field} has an unsupported font`);
  return id;
}
function validSize(v: unknown, field: string): string {
  if (typeof v === "string" && CARD_FONT_SIZES.includes(v as (typeof CARD_FONT_SIZES)[number])) return v;
  throw new ApiError(400, "BAD_SIZE", `${field} must be one of: ${CARD_FONT_SIZES.join(", ")}`);
}
function validAlign(v: unknown, field: string): string {
  if (typeof v === "string" && CARD_ALIGNMENTS.includes(v as (typeof CARD_ALIGNMENTS)[number])) return v;
  throw new ApiError(400, "BAD_ALIGN", `${field} must be one of: ${CARD_ALIGNMENTS.join(", ")}`);
}

// GET /api/store/card-style — the seller's product-card typography.
export const GET = handle(async () => {
  const { store } = await requireActiveSellerStore();
  const style = await db.productCardStyle.findUnique({ where: { storeId: store.id } });
  const payload: CardStyleData = {
    style: style
      ? {
          nameFont: style.nameFont,
          nameSize: style.nameSize,
          nameAlign: style.nameAlign,
          priceFont: style.priceFont,
          priceSize: style.priceSize,
          priceAlign: style.priceAlign,
        }
      : null,
    fonts: FONT_OPTIONS.map((f) => ({ id: f.id, label: f.label, kind: f.kind })),
  };
  return ok(payload);
});

// PUT /api/store/card-style — save typography (validated enum vocabularies;
// the vendor form sends friendly ids, never CSS or JSON).
export const PUT = handle(async (req: Request) => {
  const { store } = await requireActiveSellerStore();
  const body = (await req.json().catch(() => ({}))) as CardStyleBody;

  const data = {
    nameFont: validFont(body.nameFont, "Product name font"),
    nameSize: validSize(body.nameSize, "Product name size"),
    nameAlign: validAlign(body.nameAlign, "Product name alignment"),
    priceFont: validFont(body.priceFont, "Price font"),
    priceSize: validSize(body.priceSize, "Price size"),
    priceAlign: validAlign(body.priceAlign, "Price alignment"),
  };

  const saved = await db.productCardStyle.upsert({
    where: { storeId: store.id },
    create: { storeId: store.id, ...data },
    update: data,
  });

  bustPublicCacheSafe(PUBLIC_CACHE_TAGS.stores);
  const payload: CardStyleSaveData = {
    style: {
      nameFont: saved.nameFont,
      nameSize: saved.nameSize,
      nameAlign: saved.nameAlign,
      priceFont: saved.priceFont,
      priceSize: saved.priceSize,
      priceAlign: saved.priceAlign,
    },
    fontLabels: {
      name: fontLabel(saved.nameFont),
      price: fontLabel(saved.priceFont),
    },
  };
  return ok(payload);
});
