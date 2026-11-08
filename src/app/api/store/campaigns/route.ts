import { db } from "@/lib/db";
import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { randomToken } from "@/lib/password";
import { campaignLinkPath } from "@/lib/analytics/attribution";
import type { SellerCampaignRow, SellerCampaignCreateBody } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// ============================================================================
// /api/store/campaigns — seller-generated campaign tracking links
// (Marketing Intelligence). Seller-session scoped: the store always comes from
// requireActiveSellerStore() — a client-supplied storeId is never trusted.
//
// A campaign is a named entity with a short globally-unique `code` that is
// embedded in the shareable storefront link as `nmcl`. The link ALSO carries
// standard UTM parameters so off-platform tools (and the sellers themselves)
// see familiar values. The `nmcl` token is canonical: it resolves server-side
// to this row (store-matched, fail-closed) and survives UTM stripping.
// ============================================================================

const NAME_MAX = 80;
const SOURCE_MAX = 100;
const MEDIUM_MAX = 50;
const MAX_CAMPAIGNS_PER_STORE = 100; // hygiene cap — this is not a bulk tool

function sanitizeText(raw: unknown, maxLen: number): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLen).trim();
  return cleaned === "" ? null : cleaned;
}

/** URL-safe slug from a campaign name (lowercase, ascii letters/digits/dashes). */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "campaign"
  );
}

function toRow(
  storeSlug: string,
  c: { id: string; name: string; slug: string; code: string; status: string; defaultSource: string | null; defaultMedium: string | null; createdAt: Date }
): SellerCampaignRow {
  return {
    id: c.id,
    name: c.name,
    slug: c.slug,
    code: c.code,
    status: c.status,
    defaultSource: c.defaultSource,
    defaultMedium: c.defaultMedium,
    createdAt: c.createdAt.toISOString(),
    linkPath: campaignLinkPath(storeSlug, c),
  };
}

// GET — list the seller's campaigns (any status; archived ones keep reporting).
export const GET = handle(async (req: Request) => {
  rateLimit(req, "campaigns", 60, 60_000);
  const { store } = await requireActiveSellerStore();
  const campaigns = await db.sellerCampaign.findMany({
    where: { storeId: store.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, slug: true, code: true, status: true, defaultSource: true, defaultMedium: true, createdAt: true },
  });
  const payload: SellerCampaignRow[] = campaigns.map((c) => toRow(store.slug, c));
  return ok(payload);
});

// POST — create a campaign (name + optional suggested utm_source/utm_medium).
export const POST = handle(async (req: Request) => {
  rateLimit(req, "campaigns", 20, 60_000);
  const { me, store } = await requireActiveSellerStore();

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as SellerCampaignCreateBody & Record<string, unknown>;
    if (body == null || typeof body !== "object" || Array.isArray(body)) body = {};
  } catch {
    throw new ApiError(400, "VALIDATION", "JSON body required");
  }

  const name = sanitizeText(body.name, NAME_MAX);
  if (!name) throw new ApiError(400, "VALIDATION", `name is required (≤ ${NAME_MAX} characters)`);
  const defaultSource = sanitizeText(body.source, SOURCE_MAX);
  const defaultMedium = sanitizeText(body.medium, MEDIUM_MAX);

  const count = await db.sellerCampaign.count({ where: { storeId: store.id } });
  if (count >= MAX_CAMPAIGNS_PER_STORE) {
    throw new ApiError(400, "CAMPAIGN_LIMIT", `This store already has ${MAX_CAMPAIGNS_PER_STORE} campaigns — archive old ones instead of creating more`);
  }

  // Unique slug per store (append -2, -3… on collision) + globally-unique code.
  const baseSlug = slugify(name);
  let slug = baseSlug;
  for (let i = 2; i < 100; i++) {
    const clash = await db.sellerCampaign.findFirst({ where: { storeId: store.id, slug }, select: { id: true } });
    if (!clash) break;
    slug = `${baseSlug}-${i}`;
  }
  let code = `c${randomToken(5)}`;
  for (let i = 0; i < 5; i++) {
    const clash = await db.sellerCampaign.findFirst({ where: { code }, select: { id: true } });
    if (!clash) break;
    code = `c${randomToken(5)}`;
  }

  const created = await db.sellerCampaign.create({
    data: { storeId: store.id, name, slug, code, defaultSource, defaultMedium, status: "active" },
    select: { id: true, name: true, slug: true, code: true, status: true, defaultSource: true, defaultMedium: true, createdAt: true },
  });

  await logActivity({
    actorType: "seller",
    actorId: me.id,
    actorLabel: me.email,
    action: "campaigns.create",
    entityType: "store",
    entityId: store.id,
    meta: { campaignId: created.id, name, slug, code },
  });

  const payload: SellerCampaignRow = toRow(store.slug, created);
  return ok(payload, { status: 201 });
});
