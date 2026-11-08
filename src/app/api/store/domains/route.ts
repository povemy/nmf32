import { db } from "@/lib/db";
import { handle, ok, ApiError, notify, logActivity } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import type { SellerDomainRow, SellerDomainBody } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// GET /api/store/domains
export const GET = handle(async () => {
  const { store } = await requireActiveSellerStore();
  const domains = await db.storeDomain.findMany({
    where: { storeId: store.id },
    orderBy: { createdAt: "desc" },
  });
  const payload: SellerDomainRow[] = domains.map((d) => ({
    id: d.id,
    storeId: d.storeId,
    domain: d.domain,
    mode: d.mode,
    status: d.status,
    sslStatus: d.sslStatus,
    isPrimary: d.isPrimary,
    lastCheckedAt: d.lastCheckedAt ? d.lastCheckedAt.toISOString() : null,
    errorReason: d.errorReason,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  }));
  return ok(payload);
});

// POST /api/store/domains {domain, mode: cname|ns}
export const POST = handle(async (req: Request) => {
  const { me, store } = await requireActiveSellerStore();
  const body = (await req.json().catch(() => ({}))) as SellerDomainBody;

  const domain = String(body.domain ?? "").trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    throw new ApiError(400, "VALIDATION", "domain must be a valid hostname (e.g. shop.example.com)");
  }
  const mode = String(body.mode ?? "cname");
  if (!["cname", "ns"].includes(mode)) {
    throw new ApiError(400, "VALIDATION", "mode must be cname or ns");
  }
  const exists = await db.storeDomain.findUnique({ where: { domain } });
  if (exists) throw new ApiError(409, "DOMAIN_TAKEN", "Domain already connected to a store");

  const record = await db.storeDomain.create({
    data: { storeId: store.id, domain, mode, status: "verifying", sslStatus: "pending" },
  });

  await logActivity({
    actorType: "seller",
    actorId: me.id,
    actorLabel: me.email,
    action: "domain.added",
    entityType: "store_domain",
    entityId: record.id,
    meta: { domain, mode },
  });

  const payload: SellerDomainRow = {
    id: record.id,
    storeId: record.storeId,
    domain: record.domain,
    mode: record.mode,
    status: record.status,
    sslStatus: record.sslStatus,
    isPrimary: record.isPrimary,
    lastCheckedAt: record.lastCheckedAt ? record.lastCheckedAt.toISOString() : null,
    errorReason: record.errorReason,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
  return ok(payload, { status: 201 });
});
