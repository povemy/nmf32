# 12 — Provider Checklist (information required before implementation)

**Purpose:** the exact information NOMOFEE needs from the chosen provider **before
adapter implementation can start** (Phase 4.3 deliverable). Context: NOMOFEE is a
Malaysian marketplace operating the Option-B licensed-PSP split model — the provider
collects buyer payments (FPX / DuitNow / cards / e-wallets for MYR), deducts the
platform application fee, and settles sellers; NOMOFEE never takes custody
(`src/lib/psp.ts`). Nothing below presumes any provider's specifics — every item is
a question to be answered **FROM THE CHOSEN PROVIDER'S OFFICIAL DOCUMENTATION**.

## 1. Webhook signing & delivery

- [ ] Exact signing scheme: header names, canonical string construction, MAC/hash
      algorithm, encoding, secret provisioning (single vs dual-active rotation).
- [ ] Timestamp/nonce fields and the provider's own replay guidance (the platform's
      current ±10 min window is an internal policy that must be re-derived).
- [ ] Delivery retry cadence: intervals, backoff, total attempts, at-least-once
      guarantees, ordering guarantees (or their absence).
- [ ] Endpoint registration procedure + IP allowlist requirements, if any.
- [ ] Expected success/failure response contract (what stops retries: 2xx only?
      specific bodies?) and whether a `duplicate` flag is expected.
- [ ] Test-event tooling for signature verification in the provider sandbox.

## 2. Event catalog

- [ ] Complete event catalog with exact `eventType` strings and payload schemas for:
      payment authorized / captured / failed / cancelled / expired / refunded /
      settlement / chargeback-dispute, and (if the provider executes payouts)
      payout-completion events.
- [ ] Which event the platform should treat as THE capture confirmation (the
      platform's money-movement trigger — `11-provider-integration-contract.md` §2.7).
- [ ] Amount/currency fields and rounding/fee-inclusive vs fee-exclusive semantics.

## 3. Status model

- [ ] Full provider payment status enumeration and legal transitions (the platform
      maps these onto `payment.succeeded` / `payment.failed`; unknown statuses must
      never map to a money outcome).
- [ ] Terminal vs intermediate states; expiry semantics for unpaid sessions
      (platform payment window: 30 min — provider-side expiry must align or be
      configurable).
- [ ] Payout/transfer status enumeration for outbound payouts (maps onto
      `requested → processing → paid|failed` via `PspPayoutAdapter`).

## 4. Refund API & idempotency

- [ ] Refund endpoint contract: request fields (payment id, amount, currency,
      reason), response fields, partial-refund support.
- [ ] **Native idempotency-key support** (or verified equivalent): semantics for
      retries with the same key; behavior when key, payment, or amount conflict.
      The platform sends `recon:{caseId}` per refund case (`src/lib/psp-refund.ts`).
- [ ] Refund status query endpoint (pure read) for the authoritative record —
      required by `RefundAdapter.getRefundStatus`.
- [ ] Refund timing (async settlement to buyer?), failure modes, and
      refund-rejection reasons.

## 5. Settlement timing & statements

- [ ] Settlement schedule: when captured funds settle (T2 trigger), statement /
      settlement-report endpoints, format, and frequency.
- [ ] Per-seller settlement confirmation records (for the per-seller split mirror).
- [ ] Application-fee mechanics: fee deducted at payment time vs at settlement;
      per-seller sub-account (connected-account) model; fee caps/rounding rules.
- [ ] Minimum settlement amounts / reserve / rolling-hold policies affecting the
      platform's own hold-day configuration (`CommissionSetting.payoutHoldDays`).

## 6. Sandbox credentials & test matrices

- [ ] Sandbox/test environment credentials and onboarding steps (no credentials
      exist in-repo today — `performance/psp-readiness/preflight.md` §3).
- [ ] Test-payment-method matrices: test cards/bank accounts, deterministic
      success/failure/pending triggers, amount-triggered outcomes if any.
- [ ] Sandbox webhook delivery to a non-public endpoint (tunnel/procedure) —
      required for the staging demonstration (`13-staging-demo-guide.md`).
- [ ] Sandbox→production promotion checklist and go-live requirements.

## 7. Rate limits & operational envelopes

- [ ] API rate limits (payment creation, status reads, refunds, payout submission)
      and burst/quota semantics — the platform must tune its retry cadence inside them.
- [ ] Webhook egress limits (events/sec the platform should expect) — the platform's
      current ingest limit is 60 req/min/IP (`05-webhook-security.md` §4).
- [ ] Timeout guidance for each API family (platform uses bounded timeouts
      everywhere; defaults must not exceed provider SLAs).
- [ ] Status-page / incident-notification channels; maintenance windows.

## 8. Compliance (Malaysia / BNM context)

- [ ] Provider's BNM licensing/registration status for the rails being used
      (the platform's design keeps it outside merchant-acquiring registration scope —
      `src/lib/psp.ts` Option B rationale; verify against provider's guidance).
- [ ] KYC/AML obligations for marketplace sellers/sub-accounts, required documents,
      onboarding timelines (affects seller payout readiness).
- [ ] Data residency / PDPA (Malaysia) constraints on payment data processing and
      storage; what data the provider requires the platform to retain.
- [ ] PCI-DSS scope implications of the chosen integration style (hosted checkout
      vs direct API) — the platform intends hosted/redirect flows (plug-in point 2,
      `src/lib/psp.ts`).
- [ ] SSM business-registration evidence the provider requires from NOMOFEE, and
      contract/pricing documents.

## 9. Marketplace / split product requirements

- [ ] Marketplace product availability and approval process for the platform's
      model (single buyer charge covering N per-seller orders, application fee,
      per-seller settlement).
- [ ] Per-seller sub-account onboarding API or dashboard flow; seller payout
      method options (bank transfer rails, e-wallet payout support).
- [ ] Application-fee limits (min/max fee, percentage caps) relative to the
      platform's commission engine settings (`src/lib/commission.ts`).
- [ ] Multi-currency support roadmap (platform is MYR-only today).
- [ ] Reconciliation tooling the provider offers (statement pull APIs, dispute/
      chargeback webhooks, refund reporting) to complement the platform's internal
      reconciliation (`06`, `07`).

---
All items must be answered from official provider documentation before
implementation; provider-specific values will then populate
`11-provider-integration-contract.md`'s "TO BE MAPPED" placeholders.
