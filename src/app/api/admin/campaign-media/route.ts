import { NextRequest } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { handle, ok, ApiError, auditAdmin } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import type { CampaignMediaData } from "@/lib/types/api-contract";

// ============================================================================
// POST /api/admin/campaign-media — banner/thumbnail uploads for campaigns
// (work order 14, RBAC campaigns.manage).
//
// Design notes (why a local-file endpoint and nothing fancier):
//   • The codebase convention for creative is URL STRINGS (MarketplaceBanner
//     imageUrl, ProductImage.url, store logos) — campaigns now carry
//     bannerDesktopUrl / bannerMobileUrl / thumbnailUrl in the same style.
//   • This endpoint gives admins a genuine upload path that produces exactly
//     such a URL (/uploads/campaigns/<uuid>.<ext>), validated server-side:
//     multipart only, one file, ≤ 3 MB, png/jpeg/webp enforced by MAGIC BYTES
//     (never trust the declared content-type).
//   • Files land in public/uploads/campaigns/ which the dev server serves
//     statically. DEPLOYMENT CAVEAT (documented limitation): a production
//     standalone build snapshots public/ at build time — before a real
//     deployment, uploads must move to object storage (Supabase Storage) or
//     be synced into the image; the URL convention stays identical.
//   • The response NEVER echoes the bytes; the audit log records only the
//     size/kind, never content.
// ============================================================================

const MAX_BYTES = 3 * 1024 * 1024; // 3 MB
const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads", "campaigns");

const ALLOWED: { ext: string; mime: string; sniff: (b: Uint8Array) => boolean }[] = [
  { ext: "png", mime: "image/png", sniff: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a },
  { ext: "jpg", mime: "image/jpeg", sniff: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "webp", mime: "image/webp", sniff: (b) => b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
];

export const POST = handle(async (req: NextRequest) => {
  const admin = await requireCap("campaigns.manage");

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new ApiError(400, "VALIDATION", "Request must be multipart/form-data with a file field");
  }

  const file = form.get("file");
  if (!(file instanceof File)) throw new ApiError(400, "VALIDATION", "file field is required");
  if (file.size === 0) throw new ApiError(400, "VALIDATION", "file is empty");
  if (file.size > MAX_BYTES) throw new ApiError(400, "VALIDATION", `file must be ≤ 3 MB (got ${(file.size / 1024 / 1024).toFixed(1)} MB)`);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = ALLOWED.find((k) => k.sniff(bytes));
  if (!kind) throw new ApiError(400, "VALIDATION", "Only PNG, JPEG or WebP images are accepted");

  // Fresh, unpredictable filename — admins never control the stored path.
  const name = `campaign-${crypto.randomUUID()}.${kind.ext}`;
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.writeFile(path.join(UPLOAD_DIR, name), bytes);

  const url = `/uploads/campaigns/${name}`;

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "campaign.media_upload",
    entityType: "campaign_media",
    entityId: name,
    after: { url, bytes: file.size, mime: kind.mime },
  });

  const payload: CampaignMediaData = { url, bytes: file.size, mime: kind.mime };
  return ok(payload);
});
