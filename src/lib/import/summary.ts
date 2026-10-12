// Shared summary type for import jobs (keeps route + runner in sync).
export type JobSummary = {
  shop?: { name: string; sourceShopId: string; region?: string | null };
  platform?: string;
  platformLabel?: string;
  isFixture?: boolean;
  storeId?: string;
  storeSlug?: string;
  productsOk?: number;
  productsFailed?: number;
  warnings?: string[];
  authorisationRequired?: boolean;
  beginUrl?: string | null;
  missingEnv?: string[];
  claimToken?: string;
  claimExpiresAt?: string;
  claimMethod?: string;
};
