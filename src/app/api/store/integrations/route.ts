import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { toJson } from "@/lib/json";
import { requireActiveSellerStore } from "@/lib/auth";
import { parseJson } from "@/lib/json";
import type { SellerIntegrationRow, IntegrationBody, IntegrationSaveData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

const PROVIDERS = ["meta_pixel", "ga4", "tiktok_pixel", "gtm"] as const;

// GET /api/store/integrations — all supported providers with current config.
export const GET = handle(async () => {
  const { store } = await requireActiveSellerStore();
  const rows = await db.storeIntegration.findMany({ where: { storeId: store.id } });
  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  const integrations: SellerIntegrationRow[] = PROVIDERS.map((provider) => {
    const row = byProvider.get(provider);
    return {
      provider,
      config: row ? parseJson<Record<string, unknown>>(row.configJson, {}) : {},
      isEnabled: row?.isEnabled ?? false,
      updatedAt: row ? row.updatedAt.toISOString() : null,
    };
  });
  return ok(integrations);
});

// PUT /api/store/integrations {provider, config, isEnabled} — upsert per provider.
export const PUT = handle(async (req: Request) => {
  const { me, store } = await requireActiveSellerStore();
  const body = (await req.json().catch(() => ({}))) as IntegrationBody;

  const provider = String(body.provider ?? "");
  if (!PROVIDERS.includes(provider as (typeof PROVIDERS)[number])) {
    throw new ApiError(400, "VALIDATION", `provider must be one of: ${PROVIDERS.join(", ")}`);
  }
  const config = typeof body.config === "string" ? body.config : toJson(body.config ?? {});
  const isEnabled = body.isEnabled === undefined ? false : !!body.isEnabled;

  const existing = await db.storeIntegration.findUnique({
    where: { storeId_provider: { storeId: store.id, provider } },
  });

  const integration = existing
    ? await db.storeIntegration.update({
        where: { id: existing.id },
        data: { configJson: config, isEnabled },
      })
    : await db.storeIntegration.create({
        data: { storeId: store.id, provider, configJson: config, isEnabled },
      });

  const payload: IntegrationSaveData = {
    provider: integration.provider,
    config: parseJson<Record<string, unknown>>(integration.configJson, {}),
    isEnabled: integration.isEnabled,
  };
  return ok(payload);
});
