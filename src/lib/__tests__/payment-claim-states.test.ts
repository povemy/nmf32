import { describe, expect, test } from "bun:test";
import {
  INTENT_SUCCESS_CLAIMABLE_STATUSES,
  isIntentSuccessClaimable,
} from "@/lib/payment-claim-states";

// V-F1 regression tests (stage-gate verification, Phase 2 final remediation).
//
// The legacy webhook success claim previously used `status: { not: "succeeded" }`,
// which admitted "refunded" intents — a recovery re-feed (admin payouts sweep
// with recovery:true) or re-simulate of a fully-refunded legacy order could
// re-claim the intent and flip the ORDER refunded → paid. These tests pin the
// whitelist semantics so the predicate cannot silently regress to an
// under-constrained "not succeeded" form.

describe("payment-claim-states (V-F1) — intent success-claim whitelist", () => {
  test("the normal lifecycle states are claimable", () => {
    expect(isIntentSuccessClaimable("requires_payment")).toBe(true);
    expect(isIntentSuccessClaimable("failed")).toBe(true);
  });

  test("a succeeded intent is NOT claimable (idempotent duplicate path)", () => {
    expect(isIntentSuccessClaimable("succeeded")).toBe(false);
  });

  test("a REFUNDED intent is NOT claimable — no resurrection of refunded orders (the V-F1 regression)", () => {
    expect(isIntentSuccessClaimable("refunded")).toBe(false);
  });

  test("sweep/terminal order-side states are not intent-claimable (fail closed)", () => {
    expect(isIntentSuccessClaimable("expired")).toBe(false);
    expect(isIntentSuccessClaimable("cancelled")).toBe(false);
    expect(isIntentSuccessClaimable("processing")).toBe(false);
  });

  test("unknown/future statuses fail closed", () => {
    expect(isIntentSuccessClaimable("")).toBe(false);
    expect(isIntentSuccessClaimable("Succeeded")).toBe(false); // case-sensitive by design
    expect(isIntentSuccessClaimable("requires-payment")).toBe(false);
    expect(isIntentSuccessClaimable("anything-else")).toBe(false);
  });

  test("the exported whitelist is exactly the two lifecycle states (no accidental widening)", () => {
    expect([...INTENT_SUCCESS_CLAIMABLE_STATUSES]).toEqual(["requires_payment", "failed"]);
  });

  test("every whitelisted status passes the predicate (internal consistency)", () => {
    for (const s of INTENT_SUCCESS_CLAIMABLE_STATUSES) {
      expect(isIntentSuccessClaimable(s)).toBe(true);
    }
  });
});
