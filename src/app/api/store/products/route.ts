import { db } from "@/lib/db";
import { handle, ok, okPaged, ApiError, getPagination, logActivity } from "@/lib/api";
import { toJson } from "@/lib/json";
import { requireActiveSellerStore } from "@/lib/auth";
import { matchFlags, moderationStatus, uniqueSlug, validateVariants } from "./helpers";

export const dynamic = "force-dynamic";

// GET /api/store/products?search=&status=&page=&size=
export const GET = handle(async (req: Request) => {
  const { store } = await requireActiveSellerStore();
  const url = new URL(req.url);
  const { page, size, skip, take } = getPagination(url);
  const search = url.searchParams.get("search")?.trim();
  const status = url.searchParams.get("status")?.trim();

  const where: Record<string, unknown> = { storeId: store.id };
  if (search) where.title = { contains: search };
  if (status && status !== "all") where.status = status;

  const [rows, total] = await Promise.all([
    db.product.findMany({
      where,
      include: {
        images: { orderBy: { sortOrder: "asc" } },
        variants: { orderBy: { createdAt: "asc" } },
        category: { select: { id: true, name: true, slug: true } },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
    db.product.count({ where }),
  ]);

  return okPaged(rows, { page, size, total });
});

// POST /api/store/products — create with images[] + variants[].
export const POST = handle(async (req: Request) => {
  const { me, store } = await requireActiveSellerStore();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const title = String(body.title ?? "").trim();
  if (!title) throw new ApiError(400, "VALIDATION", "title is required");
  const description = body.description != null ? String(body.description) : null;
  const variants = validateVariants(body.variants);
  const images = Array.isArray(body.images) ? body.images.map((u) => String(u)).filter(Boolean) : [];

  // Moderation: first N products need review; banned keywords force review.
  let status = await moderationStatus(store.id);
  const flags = matchFlags(`${title} ${description ?? ""}`);
  if (flags.length > 0) status = "pending_review";

  const priceMinor = Math.min(...variants.map((v) => v.priceMinor));
  const slug = await uniqueSlug(store.id, title);

  const categoryId = body.categoryId != null ? String(body.categoryId) : null;
  if (categoryId) {
    const cat = await db.category.findUnique({ where: { id: categoryId } });
    if (!cat) throw new ApiError(400, "VALIDATION", "Category not found");
  }

  const product = await db.product.create({
    data: {
      storeId: store.id,
      categoryId,
      title,
      slug,
      description,
      status,
      priceMinor,
      flagsJson: flags.length > 0 ? toJson(flags) : "[]",
      publishedAt: status === "active" ? new Date() : null,
      images: { create: images.map((url, i) => ({ url, sortOrder: i })) },
      variants: { create: variants.map((v) => ({ ...v })) },
    },
    include: {
      images: { orderBy: { sortOrder: "asc" } },
      variants: { orderBy: { createdAt: "asc" } },
      category: { select: { id: true, name: true, slug: true } },
    },
  });

  await logActivity({
    actorType: "seller",
    actorId: me.id,
    actorLabel: me.email,
    action: "product.created",
    entityType: "product",
    entityId: product.id,
    meta: { title, status, flags },
  });

  return ok(product, { status: 201 });
});
