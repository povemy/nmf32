import { NextRequest } from "next/server";
import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { runLedgerInvariants } from "@/lib/ledger";
import { processPaymentWebhook } from "@/app/api/webhooks/payments/process";
import { rateLimit } from "@/lib/ratelimit";
import { parseMaybeJson } from "@/app/api/admin/_helpers";
import type { AdminSweepData, AdminWalletCacheDrift } from "@/lib/types/api-contract";

// POST /api/admin/payouts/sweep — bounded, repeatable operations sweep (RBAC payouts.manage).
//
// FIN-2a. Five rules baked in:
//   • BOUNDED  — caps: 50 stuck payouts, 25 webhooks per run.
//   • REPEATABLE — stuck payouts alert once (activity-log dedup by payout id);
//     re-running is a no-op until something NEW goes stale.
//   • NO AUTO-RETRY-MONEY — stuck payouts are only DETECTED + alerted; a human
//     decides (mark-paid / fail / reject). No status is ever overwritten here.
//   • PROCESSOR OWNS STATE — unprocessed webhooks are re-run through the shared
//     processor (signature-verified, idempotent via dedupKey); this route never
//     touches PaymentWebhookLog.processed or ledger state by hand. Note: the
//     original unprocessed log rows stay untouched by design — the processor
//     marks its own new rows, duplicates converge on ledger dedupKeys.
//   • VERIFIED — every run ends with runLedgerInvariants() (balance + cache drift).
export const POST = handle(async (req: NextRequest) => {
  const rl = rateLimit(req, { limit: 6, windowMs: 60000 });
  if (!rl.ok) throw new ApiError(429, "RATE_LIMITED", "Too many requests, retry later");

  const admin = await requireCap("payouts.manage");

  // ---------------------------------------------------------------- (a) stuck payouts
  // Setting key `payout.stuck_hours` (default 72) — parsed like the other
  // payout settings (parseMaybeJson).
  const stuckSetting = await db.setting.findUnique({ where: { key: "payout.stuck_hours" } });
  const stuckHours = parseMaybeJson<number>(stuckSetting?.valueJson, 72);
  const stuckCutoff = new Date(Date.now() - stuckHours * 3600000);
  const stuckRows = await db.payout.findMany({
    where: { status: "processing", updatedAt: { lt: stuckCutoff } },
    orderBy: { updatedAt: "asc" },
    take: 50,
    select: { id: true, referenceNo: true, updatedAt: true },
  });

  // Alert-once: skip payouts that already have a stuck_detected activity row.
  const priorAlerts = stuckRows.length
    ? await db.activityLog.findMany({
        where: { action: "payout.stuck_detected", entityId: { in: stuckRows.map((s) => s.id) } },
        select: { entityId: true },
      })
    : [];
  const alertedIds = new Set(priorAlerts.map((a) => a.entityId));

  const stuck: AdminSweepData["stuck"] = [];
  let stuckNewlyDetected = 0;
  for (const p of stuckRows) {
    const hoursStuck = Math.floor((Date.now() - p.updatedAt.getTime()) / 3600000);
    const isNew = !alertedIds.has(p.id);
    if (isNew) {
      await logActivity({
        actorType: "system",
        action: "payout.stuck_detected",
        entityType: "payout",
        entityId: p.id,
        meta: { referenceNo: p.referenceNo, hoursStuck },
      });
      stuckNewlyDetected++;
    }
    stuck.push({ payoutId: p.id, referenceNo: p.referenceNo, hoursStuck, updatedAt: p.updatedAt.toISOString(), alerted: isNew });
  }

  // ---------------------------------------------------------------- (b) unprocessed webhooks
  // Older than 1h, still processed=false, cap 25. signatureValid=false rows are
  // skipped (counted) — replaying an unverified payload is exactly what we must
  // never do. Valid ones go through the shared processor with recovery:true
  // (Phase 1 / E3): the ORIGINAL delivery was signature-verified and persisted —
  // the processor still fully re-verifies the HMAC against the stored payload
  // (a stored event with a tampered/absent sig fails BAD_SIGNATURE), but the
  // ±10-minute freshness window is waived because the event's age is exactly
  // why it needs recovery. Previously this branch re-fed the ORIGINAL ts which
  // always failed STALE_EVENT — the recovery path existed on paper only. The
  // processor owns every state transition + ledger posting (idempotent via
  // claims + dedupKeys): a retry can never create a second financial effect.
  const webhookCutoff = new Date(Date.now() - 3600000);
  const unprocessed = await db.paymentWebhookLog.findMany({
    where: { processed: false, createdAt: { lt: webhookCutoff } },
    orderBy: { createdAt: "asc" },
    take: 25,
  });
  let reprocessed = 0;
  let stillFailing = 0;
  let skipped = 0;
  for (const log of unprocessed) {
    if (!log.signatureValid) {
      skipped++;
      continue;
    }
    try {
      const body = JSON.parse(log.payloadJson) as { providerRef?: string; eventType?: string; amountMinor?: number; ts?: number; sig?: string };
      await processPaymentWebhook({ provider: log.provider, body, rawBody: log.payloadJson, opts: { recovery: true } });
      reprocessed++;
    } catch {
      // BAD_SIGNATURE / UNKNOWN_EVENT / AMOUNT_MISMATCH / unknown ref … — the
      // processor already logged its own row; this attempt stays unprocessed.
      stillFailing++;
    }
  }

  // ---------------------------------------------------------------- (c) ledger invariants
  const invariants = await runLedgerInvariants();

  await logActivity({
    actorType: "admin",
    actorId: admin.id,
    actorLabel: admin.email,
    action: "payout.sweep.run",
    entityType: "system",
    meta: {
      stuckScanned: stuckRows.length,
      stuckNewlyDetected,
      webhooks: { scanned: unprocessed.length, reprocessed, stillFailing, skipped },
      invariantsOk: invariants.ok,
    },
  });

  const payload: AdminSweepData = {
    stuck,
    stuckHours,
    webhooks: { scanned: unprocessed.length, reprocessed, stillFailing, skipped },
    invariants: {
      ok: invariants.ok,
      problems: invariants.problems,
      hardDrift: invariants.hardDrift.map(
        (d): AdminWalletCacheDrift => ({ ...d, lastCacheWriteAt: d.lastCacheWriteAt.toISOString() })
      ),
      timeMaturityStale: invariants.timeMaturityStale.map(
        (d): AdminWalletCacheDrift => ({ ...d, lastCacheWriteAt: d.lastCacheWriteAt.toISOString() })
      ),
      txnCount: invariants.txnCount,
      walletCount: invariants.walletCount,
    },
    ranAt: new Date().toISOString(),
  };
  return ok(payload);
});
