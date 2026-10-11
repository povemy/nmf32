// Connector registry (Phase 5).
import type { MarketplaceConnector, Platform, ResolvedUrl } from "./types";
import { shopeeConnector } from "./shopee";
import { tiktokConnector } from "./tiktok";
import { fixtureConnector } from "./fixture";
import { resolveMarketplaceUrl } from "./resolver";

export { resolveMarketplaceUrl, assertPublicHost, platformLabel } from "./resolver";

const REGISTRY: Record<Platform, MarketplaceConnector> = {
  shopee: shopeeConnector,
  tiktok: tiktokConnector,
  fixture: fixtureConnector,
};

export function getConnector(platform: Platform): MarketplaceConnector {
  return REGISTRY[platform];
}

/** Resolve a pasted URL to its platform connector (throws ApiError for unsupported URLs). */
export async function resolveForConnector(rawUrl: string): Promise<{ connector: MarketplaceConnector; resolved: ResolvedUrl }> {
  const resolved = await resolveMarketplaceUrl(rawUrl);
  return { connector: getConnector(resolved.platform), resolved };
}
