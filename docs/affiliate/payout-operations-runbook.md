# Affiliate Payout Operations Runbook

**Document status:** Operational procedure — companion to `docs/affiliate/commission-definitions.md` §8.4 and `docs/affiliate/security-and-fraud-rules.md`.
**Scope:** Manual bank-transfer payouts for the NOMOFEE affiliate programme (the only supported payout method at this stage — `method: "manual_bank"`; no automated PSP payout is claimed or wired).
**Applies to roles:** `affiliate.finance` (superadmin, finance) for payout processing; `affiliate.manage` (superadmin, ops) for fraud/hold actions. Capability separation is deliberate and MUST be preserved — the finance cap never grants account-status powers, and the manage cap never completes payouts.

---

## 0. System behaviour this runbook relies on (verified)

| Guarantee | Where enforced |
|---|---|
| Requestable balance = matured `available` entries − recovery offsets, only | `requestAffiliatePayout` (src/lib/affiliate.ts); pending/held/paid entries are never claimable |
| One open payout request per affiliate | Re-checked INSIDE the transaction (`requested/processing` ⇒ 409 `PAYOUT_EXISTS`) |
| Minimum payout threshold (`affiliate.min_payout_minor`, default RM 10.00) | Enforced at request; `BELOW_MIN_PAYOUT` otherwise |
| Entries claimed atomically | `payoutId` binding inside `db.$transaction`; failures roll back the whole claim |
| Statement built from the ACTUAL claimed ledger entries at request time | `statementJson` (builtAt, balances snapshot, entry list with order refs) — never hand-edited |
| Ledger recipes T-A3 / T-A4 / T-A4f with per-payout dedup keys | `affiliate_payout_{initiated,confirmed,failed}:affpayout:{id}` (src/lib/ledger.ts) — duplicate processing attempts are no-ops |
| Paid payouts require a genuine transfer reference | `mark-paid` rejects empty `reference` (400 `REFERENCE_REQUIRED`) |
| Failed payouts release claims | `fail` → T-A4f (DR PAYOUT_CLEARING / CR AFFILIATE_LIABILITY) + claimed entries' `payoutId` cleared → back to `available` |
| Affiliate liability never mixes with seller wallet funds | Distinct `PLATFORM:AFFILIATE_LIABILITY` ledger account |
| Recovery offsets can never create negative balances | `requestableMinor = max(0, available − recovery)` |
| Every admin action audit-logged | `AdminAuditLog` + `ActivityLog` via `auditAdmin` on all process/hold/status routes |

State machine: `requested → approve → processing → mark-paid (paid)` with side exits `fail (failed)` and `reject (rejected)`. Transitions are conditional-claim updates (`updateMany WHERE status=...`) — concurrent/raced requests get 409 `STATE_INVALID`, never double-effects.

---

## 1. Affiliate bank verification (pre-flight)

1. Affiliate records their payout reference in the Hub (Payouts tab → payout reference field; free-text, display-only on the profile — `AffiliateProfile.payoutRef`, `payoutVerifiedAt`).
2. Finance reviews the reference during the FIRST payout request for that affiliate:
   - Name on the bank account should reasonably match the affiliate's verified identity where available; for unverifiable cases, mark the reference "pending confirmation" in the internal tracker and request confirmation via the platform's normal notification channel.
   - The reference is display-only today — there is no automated bank-name verification. Finance judgement + the manual transfer step below are the control.
3. `payoutVerifiedAt` is set (currently an internal record; treat as "finance has sighted and accepted this reference").
4. Mismatched or changed references: require re-verification before the next payout. A changed reference on a repeated payout is a fraud signal (see §8).

## 2. Payout request review (queue triage)

1. Open **Admin Console → Affiliate → Payouts** (capability: `affiliate.finance`).
2. The queue lists requests with status tabs, queue stats, affiliate payout reference and account email.
3. For each `requested` row, open the statement (`statementJson`):
   - Confirm the claimed entries are the affiliate's own (role direct/sponsor), matured (`available`), and not already paid.
   - Sanity-check totals against the Hub's ledger-derived figures (they are built from the same entries — any mismatch is a reconciliation incident, see §7).
4. Cross-check fraud signals (see §8). Suspicious ⇒ hold the underlying commissions FIRST (Commissions → hold, reason ≥10 chars, audited) and reject the payout with a reason (money never moves).

## 3. Manual transfer procedure (approve → mark-paid)

1. **Approve** (T-A3 posts: DR AFFILIATE_LIABILITY / CR PAYOUT_CLEARING). The request moves to `processing`. This is the finance commit point.
2. Perform the bank transfer through the organisation's banking channel (the platform itself never touches bank credentials; two-person integrity at the bank is the bank's own control).
3. Record the bank's transfer reference.
4. **Mark-paid** with the mandatory `reference` (T-A4 posts: DR PAYOUT_CLEARING / CR BANK_MAIN). Entries flip to `paid`; parent commissions advance to `paid` only when every entry is paid/reversed.
5. The platform never silently debits an affiliate's bank account — money only ever flows OUT to the affiliate (refunds after payout become recovery offsets against FUTURE earnings, §7).

## 4. Authorisation and approval (segregation of duties)

| Duty | Capability | Notes |
|---|---|---|
| Fraud review / commission holds / account suspension | `affiliate.manage` (ops) | Cannot complete payouts |
| Payout approve / mark-paid / fail | `affiliate.finance` (finance) | Cannot suspend accounts or hold commissions |
| Programme settings (kill switch, thresholds) | `settings.manage` (superadmin) | Separate again |

Where staffing is thin (single-operator phase): the same human may hold both caps via the superadmin role, but the SYSTEM still forces the two-step sequence (approve ≠ mark-paid) and every step is audit-logged with actor identity. Document the compensating control (bank-side second approver) where practical.

## 5. Failed transfer process

1. Bank rejects the transfer or finance aborts after approval: **Fail** the payout (reason recorded).
2. T-A4f posts automatically (liability released back); claimed entries return to `available`; the affiliate may re-request.
3. A failed transfer NEVER leaves entries claimed — verify the re-request succeeds; if the requestable amount looks wrong, run §7 reconciliation before intervening.

## 6. Reconciliation (routine)

- **Cadence:** daily during the first month of affiliate operations, then weekly (rollout-checklist §7).
- Open **Admin Console → Affiliate → Reconciliation** (capability: `affiliate.finance`) — the 7-point report is computed fresh from the ledger:
  1. `expectedPoolMinor` — Σ commission pools ever posted.
  2. `allocatedMinor` — Σ entry amounts (must equal pools by construction).
  3. `heldMinor` — currently held entries.
  4. `availableMinor` — approved/available net.
  5. `paidOutMinor` — paid payouts.
  6. `reversalsMinor` — refund reversals.
  7. `remainingLiabilityMinor` — live `PLATFORM:AFFILIATE_LIABILITY` balance (credit − debit).
- `invariantOk` must be `true`; the ledger itself must balance (run `bun scripts/verify-ledger.ts` in the sandbox — financial gate: ALL PASS).
- Zero-variance expected. ANY variance: freeze new payout approvals for the affected scope, preserve evidence (export the JSON), escalate to finance lead; do not "fix" by manual adjustment without the audited adjustment process.

## 7. Refund recovery (late refunds after payout)

1. When a refund lands on a commission whose entries are already `paid`, the reversal books as a recovery offset (`reversedMinor` grows on the paid entry; the entry STAYS paid — no claw-back from transferred money).
2. The affiliate's recovery balance offsets their requestable amount at the NEXT payout request (`requestableMinor = max(0, available − recovery)`).
3. Termination with outstanding recovery: the obligation becomes a finance-ops manual item — pursue per legal/ops policy; never auto-debit.
4. Amounts: see commission-definitions §7 — reversals are double-clamped to the remaining reversible pool; combined reversals can never exceed the original allocation.

## 8. Fraud holds

Signals (manual review, no automated enforcement by design — security-and-fraud-rules §9):
- Self-purchase exclusion rate per affiliate (checkout blocks self-purchases; rate signals unusual attempts).
- Sponsor concentration (one sponsor with an implausible referral/sales ratio).
- Refund-rate outliers vs programme norms.
- Near-100% conversion outliers on a link.
- Payout reference changes between payouts.
- 429 telemetry spikes (link-farm pattern).

Actions, in escalating order (all audited):
1. **Hold** the specific commissions (Commissions → hold; direct and sponsor entries freeze; paid entries untouched).
2. **Suspend** the affiliate account (Accounts → status; links deactivate, clocks pause, sponsor shares of in-flight pools hold separately — the direct promoter's 90% is never penalised for their sponsor's review).
3. **Terminate** (recoverable only via finance decision; outstanding recovery handled per §7).
4. Kill switch (`affiliate.enabled`) only for programme-wide incidents — never for single-account fraud.

## 9. Incident quick-reference

| Symptom | First response |
|---|---|
| Duplicate payout request attempts | System-safe by design (one-open-request + dedup keys); no action unless entries look double-claimed → §6 reconciliation |
| `statementJson` mismatch vs Hub figures | §6 reconciliation; freeze approvals for that affiliate |
| Bank transfer succeeded but mark-paid failed (network) | Retry mark-paid with the SAME reference (state machine + dedup make the retry safe) |
| Wrong affiliate paid (wrong reference used) | This is a manual-error incident: record in audit log, contact affiliate per ops policy; do NOT attempt ledger reversal without the audited adjustment process |
| Recovery balance exceeds future earnings realistically | Termination + finance manual item (§7.3) |

## 10. Launch gate

This runbook must be REHEARSED (including one deliberate `fail`-path exercise) and signed off by finance before the affiliate programme launches with payouts enabled — rollout-checklist §3. That rehearsal has NOT yet been performed (see `docs/affiliate/post-implementation-audit.md`).
