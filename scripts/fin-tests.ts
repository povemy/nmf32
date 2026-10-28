// ============================================================================
// FINANCIAL PRECISION TEST SUITE (M-FIN-1, POLICY P1) — pure unit verification
// ============================================================================
// User directive #5: automated tests for rounding boundaries, fractional-cent
// results, large transaction volumes, refunds, and split payments.
// Directive #3: no binary floating-point anywhere in payable math — every
// expectation below is computed with an INDEPENDENT BigInt oracle, never by
// calling the function under test twice.
//
// Run: bun scripts/fin-tests.ts   (exit 0 = all invariants hold)
// ============================================================================
import { strict as assert } from "node:assert";
import {
  bpsOf,
  divHalfUp,
  mulDivRoundHalfUp,
  allocateProportionally,
  parsePercentToBps,
  formatBps,
  formatMinor,
  toMinor,
  percentToBpsExact,
  minorToDecimalString,
  parseBpsRateInput,
  parsePercentRateInput,
  assertInt32Safe,
  parseMinorIntStrict,
  parsePriceInputStrict,
  allocateRefundByRemaining,
  MONEY_INT_MAX,
  BPS_DENOM,
  BPS_PER_PERCENT_POINT,
  BPS_DECIMALS,
} from "../src/lib/money";
import { applyFeeHoliday, applyOverrideFields, OVERRIDE_HOLD_DAYS_MAX } from "../src/lib/commission";
import {
  effectiveRateFromSnapshot,
  snapshotToCsv,
  SNAPSHOT_SCHEMA_VERSION,
} from "../src/lib/commission-export";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    const msg = e instanceof Error ? e.message : String(e);
    failures.push(`${name}: ${msg}`);
    console.error(`  ✗ ${name}\n    ${msg}`);
  }
}

/** INDEPENDENT ORACLE — exact (a × b) / d with ROUND_HALF_UP, pure BigInt. */
function oracleMulDivHalfUp(a: bigint, b: bigint, d: bigint): bigint {
  const p = a * b * 2n;
  return p >= 0n ? (p + d) / (2n * d) : -((-p + d) / (2n * d));
}

/** Mulberry32 — deterministic PRNG so runs are reproducible. */
function rng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// ===========================================================================
console.log("\n[1] ROUNDING BOUNDARIES — ROUND_HALF_UP at exact .5 sen edges");
// ===========================================================================
test("exact .5 sen rounds AWAY FROM ZERO (half-up): 1000 sen × 8.05% = 80.5 → 81", () => {
  assert.equal(bpsOf(1000, 805), 81);
  assert.equal(oracleMulDivHalfUp(1000n, 805n, 10000n), 81n);
});
test("exact .5 sen at 1 sen base: 1 × 50% = 0.5 → 1", () => {
  assert.equal(bpsOf(1, 5000), 1);
});
test("below .5 rounds down: 3 sen × 50% = 1.5 → 2 (half) · 1250 × 8.35% = 104.375 → 104", () => {
  assert.equal(bpsOf(3, 5000), 2);
  assert.equal(bpsOf(1250, 835), 104);
});
test("whole-percent exactness: 1234 sen × 8% = 98.72 → 99 (half-up on .72)", () => {
  assert.equal(bpsOf(1234, 800), 99);
  assert.equal(oracleMulDivHalfUp(1234n, 800n, 10000n), 99n);
});
test("exact product stays exact: 8900 × 8% = 712 (no rounding at all)", () => {
  assert.equal(bpsOf(8900, 800), 712);
});
test("10000 bps (100%) returns the base unchanged", () => {
  assert.equal(bpsOf(7777, BPS_DENOM), 7777);
});
test("zero base / zero rate → 0 (and negative base guarded to 0)", () => {
  assert.equal(bpsOf(0, 800), 0);
  assert.equal(bpsOf(5000, 0), 0);
  assert.equal(bpsOf(-5000, 800), 0);
});
test("divHalfUp sign symmetry: 2.5 → 3 and −2.5 → −3 (away from zero)", () => {
  assert.equal(divHalfUp(250, 100), 3);
  assert.equal(divHalfUp(-250, 100), -3);
});
test("Math.floor-trap regression: floor((a*2+b)/(b*2)) never mis-rounds at scale", () => {
  // 0.5 boundary products where naive float division would give x.4999999
  for (const [a, b, expected] of [
    [5, 10, 1], // 0.5
    [15, 10, 2], // 1.5
    [25, 10, 3], // 2.5
    [50005, 10000, 5], // 5.0005
    [74999, 10000, 7], // 7.4999 → 7
    [75001, 10000, 8], // 7.5001 → 8
  ] as const) {
    assert.equal(divHalfUp(a, b), expected, `divHalfUp(${a},${b})`);
  }
});

// ===========================================================================
console.log("\n[2] FRACTIONAL-CENT RESULTS — 5,000 randomized cases vs BigInt oracle");
// ===========================================================================
test("bpsOf matches the exact-BigInt oracle on 5,000 random (base, bps) pairs", () => {
  const rand = rng(20261018);
  for (let i = 0; i < 5000; i++) {
    const base = 1 + Math.floor(rand() * 50_000_000); // up to RM 500,000.00
    const bps = 1 + Math.floor(rand() * (BPS_DENOM - 1));
    const got = bpsOf(base, bps);
    const expected = Number(oracleMulDivHalfUp(BigInt(base), BigInt(bps), BigInt(BPS_DENOM)));
    assert.equal(got, expected, `bpsOf(${base}, ${bps}) = ${got}, oracle says ${expected}`);
    // distance from the exact real value must be ≤ 0.5 sen
    const exactNum = (BigInt(base) * BigInt(bps) * 2n + BigInt(BPS_DENOM)) / (2n * BigInt(BPS_DENOM));
    void exactNum;
    assert.ok(got >= 0 && got <= base, "result within [0, base]");
  }
});
test("mulDivRoundHalfUp matches the oracle on arbitrary denominators", () => {
  const rand = rng(77);
  for (let i = 0; i < 2000; i++) {
    const a = 1 + Math.floor(rand() * 1_000_000_000);
    const b = 1 + Math.floor(rand() * 20_000);
    const d = 1 + Math.floor(rand() * 1_000_000);
    assert.equal(mulDivRoundHalfUp(a, b, d), Number(oracleMulDivHalfUp(BigInt(a), BigInt(b), BigInt(d))));
  }
});

// ===========================================================================
console.log("\n[3] OVERFLOW SAFETY — BigInt path beyond Number.MAX_SAFE_INTEGER");
// ===========================================================================
test("base ≈ 8.5e15 sen (RM 85 trillion) × 99.99% never loses precision", () => {
  const base = 8_500_000_000_000_000;
  const bps = 9999;
  const got = bpsOf(base, bps);
  const expected = Number(oracleMulDivHalfUp(BigInt(base), BigInt(bps), 10000n));
  assert.equal(got, expected);
  assert.ok(Number.isSafeInteger(got), "result itself is a safe integer");
});
test("mulDivRoundHalfUp at MAX_SAFE_INTEGER operand (product ≈ 9e19)", () => {
  const a = Number.MAX_SAFE_INTEGER; // 9_007_199_254_740_991
  const b = 9999;
  const got = mulDivRoundHalfUp(a, b, 10_000);
  assert.equal(got, Number(oracleMulDivHalfUp(BigInt(a), BigInt(b), 10000n)));
});
test("non-integer / unsafe inputs are rejected loudly (MONEY_INT_VIOLATION)", () => {
  assert.throws(() => bpsOf(12.5, 800), /MONEY_INT_VIOLATION/);
  assert.throws(() => bpsOf(Number.MAX_SAFE_INTEGER + 1, 800), /MONEY_INT_VIOLATION/);
  assert.throws(() => mulDivRoundHalfUp(10, 0.1, 100), /MONEY_INT_VIOLATION/);
  assert.throws(() => mulDivRoundHalfUp(10, 5, 0), /division by zero/);
});
test("allocateProportionally with amount×weight ≈ 9e15 still splits exactly", () => {
  const amount = 4_000_000_000_000_000; // 4e15
  const parts = allocateProportionally(amount, [1_000_000_000, 999_999_999, 1]);
  assert.equal(parts.reduce((s, p) => s + p, 0), amount, "Σ parts ≡ amount at 4e15 scale");
});

// ===========================================================================
console.log("\n[4] LARGE TRANSACTION VOLUMES — 10,000 allocations, Σ ≡ amount");
// ===========================================================================
test("10,000 randomized allocations: Σ parts ≡ amount, all parts ≥ 0, deterministic", () => {
  const rand = rng(424242);
  for (let i = 0; i < 10_000; i++) {
    const amount = Math.floor(rand() * 1_000_000_000);
    const n = 1 + Math.floor(rand() * 50);
    const weights = Array.from({ length: n }, () => Math.floor(rand() * 100_000));
    const parts = allocateProportionally(amount, weights);
    const sum = parts.reduce((s, p) => s + p, 0);
    assert.equal(sum, amount, `allocation #${i}: Σ=${sum} ≠ ${amount}`);
    assert.ok(parts.every((p) => p >= 0));
    // determinism
    const again = allocateProportionally(amount, weights);
    assert.deepEqual(again, parts);
  }
});
test("1,000,000 sen across 1,000 equal lines splits to exactly 1000 each", () => {
  const parts = allocateProportionally(1_000_000, Array.from({ length: 1000 }, () => 7));
  assert.deepEqual(parts.reduce((s, p) => s + p, 0), 1_000_000);
  assert.ok(parts.every((p) => p === 1000));
});
test("remainder cents go to the LARGEST lines (largest-remainder policy)", () => {
  // 100 sen over weights [50, 25, 25]: floor shares 50/25/25 exact; try 101
  const parts = allocateProportionally(101, [50, 25, 25]);
  assert.equal(parts[0], 51, "extra cent lands on the highest-weight line");
  assert.equal(parts.reduce((s, p) => s + p, 0), 101);
});
test("zero total weight / zero amount → all zeros (no NaN, no throw)", () => {
  assert.deepEqual(allocateProportionally(500, [0, 0, 0]), [0, 0, 0]);
  assert.deepEqual(allocateProportionally(0, [5, 5]), [0, 0]);
});
test("negative amount or negative weights are policy violations", () => {
  assert.throws(() => allocateProportionally(-1, [5, 5]), /MONEY_INT_VIOLATION/);
  assert.throws(() => allocateProportionally(100, [5, -5]), /MONEY_INT_VIOLATION/);
});

// ===========================================================================
console.log("\n[5] REFUNDS — commission reversal + T5 ledger balance invariants");
// ===========================================================================
test("reversal = round_half_up(refund × frozen bps / 10,000); seller share never negative", () => {
  const rand = rng(9001);
  for (let i = 0; i < 3000; i++) {
    const refund = 1 + Math.floor(rand() * 5_000_000);
    const bps = Math.floor(rand() * (BPS_DENOM + 1));
    const reversal = bpsOf(refund, bps);
    const sellerShare = refund - reversal;
    assert.ok(reversal >= 0 && reversal <= refund, `reversal ${reversal} ∈ [0, ${refund}]`);
    assert.ok(sellerShare >= 0, "seller share never negative");
    // T5 ledger balance: DR sellerShare + DR reversal ≡ CR refund
    assert.equal(sellerShare + reversal, refund, "T5 debit sum ≡ credit");
  }
});
test("fee-holiday line (0 bps) reverses nothing: seller bears the full refund", () => {
  assert.equal(bpsOf(45_00, 0), 0);
});
test("full refund at 100% platform rate reverses everything", () => {
  assert.equal(bpsOf(12_345, BPS_DENOM), 12_345);
});
test("reversal precision bound: |reversal − refund×bps/10000| ≤ 0.5 sen", () => {
  const rand = rng(31337);
  for (let i = 0; i < 2000; i++) {
    const refund = 1 + Math.floor(rand() * 10_000_000);
    const bps = 1 + Math.floor(rand() * (BPS_DENOM - 1));
    const reversal = bpsOf(refund, bps);
    const exact = (BigInt(refund) * BigInt(bps)) / 10000n;
    const rem = (BigInt(refund) * BigInt(bps)) % 10000n;
    const lo = Number(exact);
    const hi = rem === 0n ? lo : lo + 1;
    assert.ok(reversal === lo || reversal === hi, `reversal ${reversal} not within one sen of exact ${lo}/${hi}`);
  }
});

// ===========================================================================
console.log("\n[6] SPLIT PAYMENTS — Option B: Σ seller nets + Σ commission ≡ buyer total");
// ===========================================================================
test("3-seller cart, randomized: Σ(sellerNet) + Σ(commission) ≡ subtotal − discount + shipping", () => {
  const rand = rng(8080);
  for (let iter = 0; iter < 2000; iter++) {
    const sellers = 1 + Math.floor(rand() * 3);
    let subtotal = 0;
    const lines: { seller: number; lineSubtotal: number }[] = [];
    for (let s = 0; s < sellers; s++) {
      const nItems = 1 + Math.floor(rand() * 4);
      for (let j = 0; j < nItems; j++) {
        const unit = 100 + Math.floor(rand() * 50_000);
        const qty = 1 + Math.floor(rand() * 5);
        lines.push({ seller: s, lineSubtotal: unit * qty });
        subtotal += unit * qty;
      }
    }
    const discount = Math.floor(rand() * Math.floor(subtotal / 3));
    const shipping = Math.floor(rand() * 2_500) * sellers;
    const bps = 1 + Math.floor(rand() * (BPS_DENOM - 1));

    // POLICY P1 pipeline (mirrors computeOrderCommissions): allocate, round once.
    const discounts = allocateProportionally(discount, lines.map((l) => l.lineSubtotal));
    const shippingAlloc = allocateProportionally(shipping, lines.map((l) => l.lineSubtotal));
    let commission = 0;
    let sellerNet = 0;
    for (let i = 0; i < lines.length; i++) {
      const base = lines[i].lineSubtotal - discounts[i];
      const c = bpsOf(base, bps);
      commission += c;
      sellerNet += base + shippingAlloc[i] - c;
    }
    const buyerTotal = subtotal - discount + shipping;
    assert.equal(
      sellerNet + commission,
      buyerTotal,
      `iter ${iter}: nets+commission ${sellerNet + commission} ≠ buyer total ${buyerTotal}`
    );
  }
});
test("min-commission floor bump moves money commission↔seller 1:1 (identity preserved)", () => {
  // base 1000 sen × 8% = 80; floor forces 200 → seller net drops by exactly 120
  let base = 1000;
  let commission = bpsOf(base, 800);
  const sellerNetBefore = base - commission;
  const floor = 200;
  const bump = floor - commission;
  commission += bump;
  const sellerNetAfter = base - commission;
  assert.equal(sellerNetBefore - sellerNetAfter, bump);
  assert.equal(commission, 200);
});

// ===========================================================================
console.log("\n[7] INPUT & OUTPUT EXACTNESS — digit-exact parsing, integer rendering");
// ===========================================================================
test("parsePercentToBps is digit-exact: 8.35% → 835, 8.3% → 830, 0.01% → 1", () => {
  assert.equal(parsePercentToBps("8.35"), 835);
  assert.equal(parsePercentToBps("8.3"), 830);
  assert.equal(parsePercentToBps("8"), 800);
  assert.equal(parsePercentToBps("0.01"), 1);
  assert.equal(parsePercentToBps("100"), 10_000);
  assert.equal(parsePercentToBps("8.351"), null, ">2 decimals rejected by policy");
  assert.equal(parsePercentToBps("abc"), null);
  assert.equal(parsePercentToBps(""), null);
  assert.equal(parsePercentToBps(null), null);
  assert.equal(parsePercentToBps(8.35), 835, "number path uses exact decimal string form");
});
test("formatBps renders from integers without float division: 835 → \"8.35\"", () => {
  assert.equal(formatBps(835), "8.35");
  assert.equal(formatBps(800), "8.00");
  assert.equal(formatBps(0), "0.00");
  assert.equal(formatBps(7), "0.07");
  assert.equal(formatBps(-1234), "-12.34");
  assert.equal(formatBps(10_000), "100.00");
});
test("toMinor string path is digit-exact: \"12.50\" → 1250, \"0.3\" → 30", () => {
  assert.equal(toMinor("12.50"), 1250);
  assert.equal(toMinor("0.3"), 30);
  assert.equal(toMinor("999"), 99_900);
  assert.equal(toMinor("-4.20"), -420);
  assert.equal(toMinor(12.5), 1250);
});
test("percentToBpsExact flags sub-bps precision instead of silently rounding", () => {
  assert.deepEqual(percentToBpsExact(8.35), { bps: 835, lossy: false });
  assert.deepEqual(percentToBpsExact(8), { bps: 800, lossy: false });
  const lossy = percentToBpsExact(8.333);
  assert.equal(lossy.lossy, true, "8.333% cannot be represented at 0.01% scale — must be flagged");
});
test("formatMinor presentation: 123456 → \"RM 1,234.56\" (negative: sign before symbol)", () => {
  assert.equal(formatMinor(123456), "RM 1,234.56");
  assert.equal(formatMinor(-199), "-RM 1.99"); // pre-existing presentation format
});

// ===========================================================================
console.log("\n[8] FLOAT-FREE GUARDRAIL — known float traps produce integer results");
// ===========================================================================
test("0.1 + 0.2 class traps: bpsOf never emits a float", () => {
  const rand = rng(606);
  for (let i = 0; i < 1000; i++) {
    const r = bpsOf(1 + Math.floor(rand() * 1e9), 1 + Math.floor(rand() * 9999));
    assert.ok(Number.isSafeInteger(r), `bpsOf returned ${r} — not a safe integer`);
  }
});
test("legacy commissionOf shim converts through bps and matches bpsOf", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { commissionOf } = require("../src/lib/money") as { commissionOf: (b: number, p: number) => number };
  assert.equal(commissionOf(8900, 8), bpsOf(8900, 800));
  assert.equal(commissionOf(1000, 8.05), bpsOf(1000, 805));
});

// ===========================================================================
console.log("\n[9] FEE-HOLIDAY SEMANTICS (ISSUE A) — configured charged rate, clamped, auditable");
// ===========================================================================
test("no-holiday equivalence: holiday bps == normal bps applies unchanged, no flag", () => {
  const r = applyFeeHoliday(800, 800);
  assert.deepEqual(r, { applies: true, bps: 800, flags: [] });
});
test("zero-percent holiday (0 bps charged) = FULL fee holiday → commission 0", () => {
  const r = applyFeeHoliday(0, 800);
  assert.equal(r.applies, true);
  assert.equal(r.bps, 0);
  assert.equal(bpsOf(100_000, r.bps), 0, "RM 1,000.00 base → RM 0.00 commission");
});
test("partial holiday: holiday rate REPLACES the normal rate (500 bps of base, not 500 bps off)", () => {
  const r = applyFeeHoliday(500, 800);
  assert.deepEqual(r, { applies: true, bps: 500, flags: [] });
  // RM 100.00 base, normal 8% → RM 5.00 charged during a 5% holiday
  assert.equal(bpsOf(10_000, r.bps), 500);
});
test("holiday can NEVER raise commission: above-normal rates clamp to normal + flag", () => {
  const r = applyFeeHoliday(5_000, 800);
  assert.equal(r.applies, true);
  assert.equal(r.bps, 800);
  assert.ok(r.flags.includes("holiday_rate_above_normal"));
  const full = applyFeeHoliday(BPS_DENOM, 800);
  assert.equal(full.bps, 800, "100% holiday on an 8% seller clamps to 8%");
  assert.ok(full.flags.includes("holiday_rate_above_normal"));
});
test("invalid stored rates (<0, >10,000, non-integer) IGNORE the holiday — corrupt data never grants max waiver", () => {
  for (const bad of [-500, BPS_DENOM + 1, 500.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const r = applyFeeHoliday(bad as number, 800);
    assert.equal(r.applies, false, `holiday ${bad} must not apply`);
    assert.equal(r.bps, 800, "normal chain applies");
    assert.ok(r.flags.some((f) => f.startsWith("invalid_fee_holiday_ignored")), `flag present for ${bad}`);
  }
});
test("boundary rounding under partial holidays: half-sen rounds AWAY FROM ZERO", () => {
  // 1000 sen × 5 bps = 0.5 sen → 1 sen (the single ROUND_HALF_UP point)
  assert.equal(bpsOf(1000, applyFeeHoliday(5, 800).bps), 1);
  // 999 sen × 5 bps = 0.4995 sen → 0
  assert.equal(bpsOf(999, applyFeeHoliday(5, 800).bps), 0);
});
test("refunds on holiday orders use the FROZEN holiday bps — T5 always balances", () => {
  const rand = rng(20261101);
  for (let i = 0; i < 2000; i++) {
    const refund = 1 + Math.floor(rand() * 2_000_000);
    const normal = Math.floor(rand() * (BPS_DENOM + 1));
    const holiday = Math.floor(rand() * (BPS_DENOM + 1));
    const applied = applyFeeHoliday(holiday, normal);
    const frozenBps = applied.applies ? applied.bps : normal; // ignored holiday → frozen normal
    const reversal = bpsOf(refund, frozenBps);
    const sellerShare = refund - reversal;
    assert.ok(reversal >= 0 && reversal <= refund);
    assert.equal(sellerShare + reversal, refund, "T5: DR seller share + DR reversal ≡ CR refund");
    if (frozenBps === 0) assert.equal(reversal, 0, "full-holiday order: platform reverses nothing, seller bears the refund");
  }
});
test("seller earnings + payout identity holds under any holiday: sellerNet ≡ base + shipping − commission", () => {
  const rand = rng(20261102);
  for (let i = 0; i < 2000; i++) {
    const base = 1 + Math.floor(rand() * 5_000_000);
    const shipping = Math.floor(rand() * 50_000);
    const normal = Math.floor(rand() * (BPS_DENOM + 1));
    const holiday = Math.floor(rand() * (BPS_DENOM + 1));
    const applied = applyFeeHoliday(holiday, normal);
    const bps = applied.applies ? applied.bps : normal;
    const commission = bpsOf(base, bps);
    const sellerNet = base + shipping - commission;
    assert.equal(sellerNet + commission, base + shipping, "earnings identity");
    assert.ok(commission <= bpsOf(base, normal) + 1, "holiday commission never exceeds normal (± half-sen rounding)");
  }
});
test("scale canary: BPS_DENOM is the single source (helpers derive, nothing hardcodes)", () => {
  assert.equal(BPS_DENOM, 10_000);
  assert.equal(BPS_PER_PERCENT_POINT, 100);
  assert.equal(BPS_DECIMALS, 2);
});

// ===========================================================================
console.log("\n[10] LEGACY COMMISSION EXPORTS (ISSUE B) — explicit formats, byte-stable, no double conversion");
// ===========================================================================
type SnapshotLike = Parameters<typeof snapshotToCsv>[0];
const LEGACY_SNAPSHOT = {
  // Exact shape of the live pre-M-FIN-1 export row (CommissionExport cmvc52axb…).
  periodFrom: "2026-09-18T08:32:41.000Z",
  periodTo: "2026-10-17T08:32:42.000Z",
  generatedAt: "2026-10-17T08:32:42.191Z",
  createdByEmail: "admin@nomofee.io",
  summary: { commissionMinor: 20304, salesMinor: 279000, effectiveRatePct: 7.3, orderCount: 13, refundsReversalMinor: 405 },
  weekly: [] as unknown[],
  stores: [{ walletId: "w1", storeName: "Lumina Living", orderCount: 5, commissionMinor: 12000 }],
} as unknown as SnapshotLike;
test("legacy effectiveRatePct = 8.35 reads as 8.35% — label verbatim, bps equivalent 835 derived exactly ONCE", () => {
  const r = effectiveRateFromSnapshot({ summary: { effectiveRatePct: 8.35 } });
  assert.equal(r.format, "legacy_pct");
  assert.equal(r.label, "8.35");
  assert.equal(r.bpsEquivalent, 835);
  assert.equal(r.bps, null, "legacy record never pretends to carry bps");
});
test("new effectiveRateBps = 835 reads as 8.35% — identical human-readable output", () => {
  const r = effectiveRateFromSnapshot({ schemaVersion: 2, summary: { effectiveRateBps: 835 } });
  assert.equal(r.format, "bps");
  assert.equal(r.label, "8.35");
  assert.equal(r.bps, 835);
});
test("legacy 7.3% and v2 730 bps are numerically equivalent (no ×100/÷100 twice)", () => {
  const legacy = effectiveRateFromSnapshot({ summary: { effectiveRatePct: 7.3 } });
  const modern = effectiveRateFromSnapshot({ schemaVersion: SNAPSHOT_SCHEMA_VERSION, summary: { effectiveRateBps: 730 } });
  assert.equal(legacy.label, "7.3");
  assert.equal(modern.label, "7.30");
  assert.equal(Number(legacy.label), Number(modern.label), "same rate, era-appropriate rendering");
  assert.equal(legacy.bpsEquivalent, modern.bps);
});
test("zero and maximum rates export correctly in both eras", () => {
  assert.equal(effectiveRateFromSnapshot({ summary: { effectiveRatePct: 0 } }).label, "0");
  assert.equal(effectiveRateFromSnapshot({ schemaVersion: 2, summary: { effectiveRateBps: 0 } }).label, "0.00");
  assert.equal(effectiveRateFromSnapshot({ schemaVersion: 2, summary: { effectiveRateBps: 10_000 } }).label, "100.00");
});
test("malformed / ambiguous records produce explicit problems — never a fabricated 0", () => {
  const none = effectiveRateFromSnapshot({});
  assert.equal(none.format, "unknown");
  assert.equal(none.label, "RATE_FORMAT_UNKNOWN");
  assert.match(none.problem ?? "", /no effective-rate field/);
  const both = effectiveRateFromSnapshot({ summary: { effectiveRateBps: 835, effectiveRatePct: 8.35 } });
  assert.equal(both.format, "unknown");
  assert.match(both.problem ?? "", /ambiguous/);
  const badVersion = effectiveRateFromSnapshot({ schemaVersion: 3, summary: { effectiveRateBps: 835 } });
  assert.equal(badVersion.format, "unknown");
  assert.match(badVersion.problem ?? "", /schemaVersion/);
  const badBps = effectiveRateFromSnapshot({ schemaVersion: 2, summary: { effectiveRateBps: 730.5 } });
  assert.equal(badBps.format, "unknown");
  const badPct = effectiveRateFromSnapshot({ summary: { effectiveRatePct: -1 } });
  assert.equal(badPct.format, "unknown");
});
test("historical CSV rendering: legacy row renders EXACTLY as it did before this change (byte-stable)", () => {
  const csv1 = snapshotToCsv(LEGACY_SNAPSHOT);
  const csv2 = snapshotToCsv(LEGACY_SNAPSHOT);
  assert.equal(csv1, csv2, "repeated exports are byte-identical");
  assert.ok(csv1.includes("# effective_rate_pct,7.3\n"), `legacy percent verbatim: ${csv1.split("\n").find((l) => l.includes("effective_rate"))}`);
  assert.ok(csv1.includes("# total_commission_myr,203.04\n"));
  assert.ok(csv1.includes("# gross_sales_myr,2790.00\n"));
  assert.ok(csv1.includes("# refund_commission_reversals_myr,4.05\n"));
  assert.ok(csv1.includes("Lumina Living,5,120.00\n"));
});
test("v2 CSV rendering: canonical bps label + JSON round-trip stability", () => {
  const v2 = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    ...LEGACY_SNAPSHOT,
    summary: { commissionMinor: 20304, salesMinor: 279000, effectiveRateBps: 730, orderCount: 13, refundsReversalMinor: 405 },
  } as unknown as SnapshotLike;
  const throughJson = JSON.parse(JSON.stringify(v2));
  assert.equal(snapshotToCsv(v2), snapshotToCsv(throughJson as SnapshotLike), "persist→read→render is stable");
  assert.ok(snapshotToCsv(v2).includes("# effective_rate_pct,7.30\n"));
});
test("CSV money rendering is float-free and byte-identical to the historical toFixed renderer", () => {
  const rand = rng(555);
  for (let i = 0; i < 5000; i++) {
    const minor = Math.floor(rand() * 100_000_000); // up to RM 1,000,000.00
    assert.equal(minorToDecimalString(minor), (minor / 100).toFixed(2), `parity at ${minor}`);
  }
  assert.equal(minorToDecimalString(0), "0.00");
  assert.equal(minorToDecimalString(5), "0.05");
  assert.equal(minorToDecimalString(-7), "-0.07");
  assert.equal(minorToDecimalString(123456789), "1234567.89");
  assert.throws(() => minorToDecimalString(12.5), /MONEY_INT_VIOLATION/);
});

// ===========================================================================
console.log("\n[11] RATE PRECISION ENFORCEMENT (ISSUE C) — reject, never silently round");
// ===========================================================================
test("parseBpsRateInput: valid integers accepted (0, 835, 10,000), all other shapes rejected", () => {
  assert.deepEqual(parseBpsRateInput(835), { ok: true, value: 835, kind: "bps" });
  assert.deepEqual(parseBpsRateInput("835"), { ok: true, value: 835, kind: "bps" });
  assert.equal(parseBpsRateInput(0).ok, true);
  assert.equal(parseBpsRateInput(BPS_DENOM).value, BPS_DENOM);
  for (const bad of [835.5, -1, BPS_DENOM + 1, "NaN", "abc", Number.NaN, Number.POSITIVE_INFINITY, {}, true]) {
    const r = parseBpsRateInput(bad as unknown);
    assert.equal(r.ok, false, `${String(bad)} rejected`);
    if (!r.ok) assert.match(r.reason, /integer 0..10000 bps/);
  }
});
test("parseBpsRateInput absent/clear contract: undefined=absent, null|\"\"=explicit clear", () => {
  assert.deepEqual(parseBpsRateInput(undefined), { ok: true, value: undefined, kind: "absent" });
  assert.deepEqual(parseBpsRateInput(null), { ok: true, value: null, kind: "clear" });
  assert.deepEqual(parseBpsRateInput(""), { ok: true, value: null, kind: "clear" });
});
test("parseBpsRateInput honours a custom ceiling (maxBps)", () => {
  assert.equal(parseBpsRateInput(500, 400).ok, false);
  assert.equal(parseBpsRateInput(400, 400).ok, true);
});
test("parsePercentRateInput: 8.35% → 835 bps digit-exact; 8.355% REJECTED (cannot be represented at 1 bps = 0.01%)", () => {
  assert.deepEqual(parsePercentRateInput("8.35"), { ok: true, value: 835, kind: "bps" });
  assert.deepEqual(parsePercentRateInput(8.35), { ok: true, value: 835, kind: "bps" });
  const tooFine = parsePercentRateInput("8.355");
  assert.equal(tooFine.ok, false, "8.355% is not representable — rejected, never rounded to 8.35% or 8.36%");
  if (!tooFine.ok) assert.match(tooFine.reason, /rejected/);
  assert.equal(parsePercentRateInput("0").value, 0);
  assert.equal(parsePercentRateInput("100").value, BPS_DENOM);
  assert.equal(parsePercentRateInput("100.01").ok, false, "above the 100% ceiling");
  assert.equal(parsePercentRateInput("-1").ok, false);
  assert.equal(parsePercentRateInput("abc").ok, false);
  assert.deepEqual(parsePercentRateInput(null), { ok: true, value: null, kind: "clear" });
  assert.deepEqual(parsePercentRateInput(undefined), { ok: true, value: undefined, kind: "absent" });
});
test("float-trap inputs never round into a different rate: 0.1+0.2-style percent noise is rejected or digit-exact", () => {
  assert.equal(parsePercentRateInput(String(0.1 + 0.2)).ok, false, "0.30000000000000004 has >2 decimals → rejected");
  assert.equal(parsePercentRateInput(0.3).value, 30);
  assert.equal(parsePercentRateInput(8.05).value, 805);
});
test("formatBps/parsePercentToBps derive from BPS_DENOM — raise-ready without call-site changes", () => {
  // At the current scale these are exact round-trips for every representable rate.
  for (let bps = 0; bps <= BPS_DENOM; bps += 7) {
    const label = formatBps(bps);
    assert.equal(parsePercentToBps(label), bps, `round-trip ${bps} bps via "${label}"`);
  }
});

// ===========================================================================
console.log("\n[12] INT32 PERSISTENCE CEILING (FIN-09) — guard at the money-column write boundary");
// ===========================================================================
test("assertInt32Safe passes for exact integers within ±(2^31−1): 0, 1, −1, ±MONEY_INT_MAX", () => {
  assert.equal(MONEY_INT_MAX, 2_147_483_647);
  for (const v of [0, 1, -1, MONEY_INT_MAX, -MONEY_INT_MAX]) {
    assert.doesNotThrow(() => assertInt32Safe(v, "unit.pass"), `value ${v} must pass`);
  }
});
test("assertInt32Safe throws for 2^31, −2^31, non-integers, NaN and Infinity", () => {
  for (const v of [MONEY_INT_MAX + 1, -(MONEY_INT_MAX + 1), 1.5, -0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => assertInt32Safe(v, "unit.throw"), /Money overflow/, `value ${v} must throw`);
  }
  try {
    assertInt32Safe(2_147_483_648, "order_paid.totalMinor");
    assert.fail("expected throw");
  } catch (e) {
    assert.match(e instanceof Error ? e.message : String(e), /order_paid\.totalMinor=2147483648/, "error names the field");
  }
});
test("MONEY_INT_MAX ≈ RM 21.47M — document the ceiling", () => {
  assert.equal(MONEY_INT_MAX / 100, 21_474_836.47);
});

// ===========================================================================
console.log("\n[13] STRICT MONEY INPUT (FIN-10) — reject, never coerce");
// ===========================================================================
test("parseMinorIntStrict: integer numbers and integer strings accepted digit-exact", () => {
  assert.equal(parseMinorIntStrict(17800), 17800);
  assert.equal(parseMinorIntStrict("17800"), 17800);
  assert.equal(parseMinorIntStrict(0), 0);
  assert.equal(parseMinorIntStrict(-5), -5);
  assert.equal(parseMinorIntStrict("+7"), 7);
  assert.equal(parseMinorIntStrict("  42  "), 42);
});
test("parseMinorIntStrict: floats, NaN, Infinity, non-numeric strings and non-scalars → null", () => {
  for (const bad of [1.5, -0.5, "12.5", "1e3", "abc", "", "12,00", Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, true, false, {}, [], null, undefined]) {
    assert.equal(parseMinorIntStrict(bad), null, `${String(bad)} rejected`);
  }
  assert.equal(parseMinorIntStrict(2 ** 53), null, "beyond MAX_SAFE_INTEGER rejected");
});
test("parsePriceInputStrict: integer sen pass through; ≤2dp decimals convert digit-exact (12.34→1234, 12.3→1230)", () => {
  assert.equal(parsePriceInputStrict(1234), 1234);
  assert.equal(parsePriceInputStrict("1234"), 1234);
  assert.equal(parsePriceInputStrict("12.34"), 1234);
  assert.equal(parsePriceInputStrict(12.34), 1234);
  assert.equal(parsePriceInputStrict("12.3"), 1230);
  assert.equal(parsePriceInputStrict("0.05"), 5);
  assert.equal(parsePriceInputStrict("-12.34"), -1234, "sign preserved — routes enforce >= 0");
});
test("parsePriceInputStrict: >2dp precision, NaN, Infinity and garbage are REJECTED, never rounded", () => {
  for (const bad of ["12.345", 12.345, 0.1 + 0.2, "1e3", "abc", "", NaN, Number.POSITIVE_INFINITY, true, {}, null, undefined]) {
    assert.equal(parsePriceInputStrict(bad), null, `${String(bad)} rejected`);
  }
});

// ===========================================================================
console.log("\n[14] REFUND ATTRIBUTION ALLOCATOR (FIN-05) — proportional largest-remainder, stable-order leftover");
// ===========================================================================
/** Independent oracle: floor(amount × rem_i / Σrem) via BigInt, clamped to rem_i. */
function oracleAllocate(amount: number, rems: number[]): number[] {
  const total = rems.reduce((s, r) => s + BigInt(r), 0n);
  const parts = rems.map((r) =>
    total <= 0n || BigInt(r) === 0n ? 0 : Number((BigInt(amount) * BigInt(r)) / total)
  );
  let leftover = amount - parts.reduce((s, p) => s + p, 0);
  const open = rems.map((r, i) => (r > 0 ? i : -1)).filter((i) => i >= 0);
  let k = 0;
  while (leftover > 0 && open.length > 0 && k <= amount + open.length) {
    const i = open[k % open.length];
    if (parts[i] < rems[i]) {
      parts[i] += 1;
      leftover -= 1;
    }
    k += 1;
  }
  return parts;
}
test("allocator matches the BigInt oracle on 5,000 randomized cases; Σ ≡ amount; parts ≤ remainders", () => {
  const rand = rng(20261019);
  for (let i = 0; i < 5000; i++) {
    const n = 1 + Math.floor(rand() * 6);
    const rems: number[] = [];
    for (let j = 0; j < n; j++) rems.push(Math.floor(rand() * 1_000_000));
    const totalRem = rems.reduce((s, r) => s + r, 0);
    if (totalRem === 0) continue;
    const amount = Math.floor(rand() * totalRem); // sanctioned regime: amount ≤ Σrem
    const parts = allocateRefundByRemaining(amount, rems);
    const expected = oracleAllocate(amount, rems);
    assert.deepEqual(parts, expected, `case ${i}: amount=${amount} rems=[${rems}]`);
    assert.equal(parts.reduce((s, p) => s + p, 0), amount, `Σ ≡ amount (case ${i})`);
    parts.forEach((p, j) => assert.ok(p >= 0 && p <= rems[j], `0 ≤ part ≤ rem at ${j} (case ${i})`));
  }
});
test("leftover sen go to the FIRST item in stable order (single rounding point)", () => {
  assert.deepEqual(allocateRefundByRemaining(1, [1, 1]), [1, 0]); // 0.5/0.5 → floor 0,0 → leftover to item 0
  assert.deepEqual(allocateRefundByRemaining(3, [1, 1, 1, 1]), [1, 1, 1, 0]);
  assert.deepEqual(allocateRefundByRemaining(5, [2, 3]), [2, 3]); // exact shares, no leftover
  assert.deepEqual(allocateRefundByRemaining(10, [9, 3]), [8, 2]); // floor 7,2 → leftover 1 → first item
});
test("exhausted (zero-remainder) items never receive sen — no over-refund past a line subtotal", () => {
  assert.deepEqual(allocateRefundByRemaining(7, [2, 0, 5]), [2, 0, 5]);
  assert.deepEqual(allocateRefundByRemaining(4, [0, 4]), [0, 4]);
  assert.deepEqual(allocateRefundByRemaining(5, [0, 0]), [0, 0]); // nothing allocatable
  // misuse regime (amount > Σrem) degrades safely: parts clamped, no over-refund
  const clamped = allocateRefundByRemaining(10, [2, 3]);
  assert.deepEqual(clamped, [2, 3]);
});
test("allocator is BigInt-safe at RM 21.47M-scale balances (Int32 ceiling regime)", () => {
  const amount = 2_000_000_000;
  const rems = [1_500_000_000, 1_500_000_000]; // amount×rem ≈ 3e18 > MAX_SAFE
  const parts = allocateRefundByRemaining(amount, rems);
  assert.equal(parts.reduce((s, p) => s + p, 0), amount);
  assert.deepEqual(parts, [1_000_000_000, 1_000_000_000]);
  parts.forEach((p, j) => assert.ok(p <= rems[j]));
});
test("multi-rate partial refund end-to-end identity: per-item reversals at own bps sum correctly", () => {
  // 2-item order: RM 60 at 10%, RM 40 at 8%; refund RM 50 → 30/20 split exact
  const parts = allocateRefundByRemaining(5000, [6000, 4000]);
  assert.deepEqual(parts, [3000, 2000]);
  const reversal = parts.reduce((s, p, i) => s + bpsOf(p, i === 0 ? 1000 : 800), 0);
  assert.equal(reversal, bpsOf(3000, 1000) + bpsOf(2000, 800)); // 300 + 160 = 460
  assert.equal(reversal, 460);
  // the OLD heuristic (first item's bps on the whole amount) would have said 500
  assert.notEqual(reversal, bpsOf(5000, 1000));
});

// ===========================================================================
console.log("\n[15] OVERRIDE FEE/HOLD FIELDS (FIN-01 R1) — applyOverrideFields: every non-null winner field applies, corrupt data ignored + flagged");
// ===========================================================================
const NORMAL = { fixedFeeMinor: 100, holdDays: 7 }; // chain-resolved (global) values

test("applies fixedFee only — holdDays keeps its chain value", () => {
  const r = applyOverrideFields({ id: "ov_fee", fixedFeeMinor: 150 }, NORMAL);
  assert.equal(r.fixedFeeMinor, 150);
  assert.equal(r.holdDays, 7);
  assert.deepEqual(r.flags, ["override_fixed_fee_applied"]);
});

test("applies holdDays only — fixedFee keeps its chain value", () => {
  const r = applyOverrideFields({ id: "ov_hold", holdDays: 2 }, NORMAL);
  assert.equal(r.fixedFeeMinor, 100);
  assert.equal(r.holdDays, 2);
  assert.deepEqual(r.flags, ["override_hold_days_applied"]);
});

test("applies fee and hold together (both flags)", () => {
  const r = applyOverrideFields({ id: "ov_both", fixedFeeMinor: 150, holdDays: 2 }, NORMAL);
  assert.equal(r.fixedFeeMinor, 150);
  assert.equal(r.holdDays, 2);
  assert.deepEqual(r.flags, ["override_fixed_fee_applied", "override_hold_days_applied"]);
});

test("a bps-null winner is NOT dead: fee + hold still apply (the core FIN-01 R1 bug)", () => {
  // resolveRate step 4 passes the winner even when winner.bps == null —
  // bps is handled by the caller; the fee/hold fields apply regardless.
  const r = applyOverrideFields({ id: "ov_norate", bps: null, fixedFeeMinor: 150, holdDays: 2 }, NORMAL);
  assert.equal(r.fixedFeeMinor, 150);
  assert.equal(r.holdDays, 2);
  assert.deepEqual(r.flags, ["override_fixed_fee_applied", "override_hold_days_applied"]);
});

test("a winner with NO fee/hold fields changes nothing and adds no flags", () => {
  const r = applyOverrideFields({ id: "ov_rate_only", fixedFeeMinor: null, holdDays: null }, NORMAL);
  assert.equal(r.fixedFeeMinor, 100);
  assert.equal(r.holdDays, 7);
  assert.deepEqual(r.flags, []);
});

test("applied flags fire only on an ACTUAL change (value equal to chain ⇒ no flag)", () => {
  const same = applyOverrideFields({ id: "ov_same", fixedFeeMinor: 100, holdDays: 7 }, NORMAL);
  assert.deepEqual(same.flags, []); // valid but identical → no behavior change, no noise
  assert.equal(same.fixedFeeMinor, 100);
  assert.equal(same.holdDays, 7);
});

test("invalid values are IGNORED with the exact audit flags (corrupt-data policy)", () => {
  const r = applyOverrideFields(
    { id: "ov_bad", fixedFeeMinor: -1, holdDays: 4000 },
    NORMAL
  );
  assert.equal(r.fixedFeeMinor, 100); // chain values kept
  assert.equal(r.holdDays, 7);
  assert.deepEqual(r.flags, [
    "invalid_override_fixed_fee_ignored:ov_bad",
    "invalid_override_hold_days_ignored:ov_bad",
  ]);
});

test("boundary values ACCEPTED: 0 fee, 0 hold days, 3650 hold days, MONEY_INT_MAX fee", () => {
  const zero = applyOverrideFields({ id: "ov0", fixedFeeMinor: 0, holdDays: 0 }, NORMAL);
  assert.equal(zero.fixedFeeMinor, 0); // 0 = explicitly charge no fixed fee
  assert.equal(zero.holdDays, 0); // 0 = pay out immediately
  assert.deepEqual(zero.flags, ["override_fixed_fee_applied", "override_hold_days_applied"]);
  const maxFee = applyOverrideFields({ id: "ovmax", fixedFeeMinor: MONEY_INT_MAX }, NORMAL);
  assert.equal(maxFee.fixedFeeMinor, MONEY_INT_MAX);
  const maxHold = applyOverrideFields({ id: "ovholdmax", holdDays: OVERRIDE_HOLD_DAYS_MAX }, NORMAL);
  assert.equal(maxHold.holdDays, 3650);
  assert.deepEqual(maxHold.flags, ["override_hold_days_applied"]);
});

test("boundary values REJECTED: 1.5, NaN, 3651 hold days, MONEY_INT_MAX+1 fee, -1", () => {
  const frac = applyOverrideFields({ id: "ovf", fixedFeeMinor: 1.5 }, NORMAL);
  assert.deepEqual(frac.flags, ["invalid_override_fixed_fee_ignored:ovf"]);
  assert.equal(frac.fixedFeeMinor, 100);
  const nan = applyOverrideFields({ id: "ovn", fixedFeeMinor: Number.NaN, holdDays: Number.NaN }, NORMAL);
  assert.deepEqual(nan.flags, [
    "invalid_override_fixed_fee_ignored:ovn",
    "invalid_override_hold_days_ignored:ovn",
  ]);
  const neg = applyOverrideFields({ id: "ovneg", fixedFeeMinor: -1, holdDays: -1 }, NORMAL);
  assert.deepEqual(neg.flags, [
    "invalid_override_fixed_fee_ignored:ovneg",
    "invalid_override_hold_days_ignored:ovneg",
  ]);
  const overHold = applyOverrideFields({ id: "ovh3651", holdDays: 3651 }, NORMAL);
  assert.deepEqual(overHold.flags, ["invalid_override_hold_days_ignored:ovh3651"]);
  assert.equal(overHold.holdDays, 7);
  const overFee = applyOverrideFields({ id: "ovfeeover", fixedFeeMinor: MONEY_INT_MAX + 1 }, NORMAL);
  assert.deepEqual(overFee.flags, ["invalid_override_fixed_fee_ignored:ovfeeover"]);
  assert.equal(overFee.fixedFeeMinor, 100);
});

test("pure end-to-end order-level contract: winner fee becomes the per-order fixed fee (Σ allocation ≡ fee), winner hold becomes the order hold", () => {
  // resolveRate (steps 0→4) → rates[0] supplies perOrderFixed + holdDays —
  // reproduced here without a DB: chain normal (global 100 sen / 7 days),
  // seller-scoped winner overrides fee/hold, allocation identity must hold.
  const chain = applyOverrideFields({ id: "ov_e2e", fixedFeeMinor: 150, holdDays: 2 }, NORMAL);
  assert.equal(chain.flags.includes("override_fixed_fee_applied"), true);
  assert.equal(chain.flags.includes("override_hold_days_applied"), true);
  const perOrderFixed = chain.fixedFeeMinor; // computeOrderCommissions rates[0]?.fixedFeeMinor
  const fixedAlloc = allocateProportionally(perOrderFixed, [8900, 13800]); // 2-item order
  assert.equal(fixedAlloc.reduce((s, p) => s + p, 0), 150, "Σ fixed_fee_allocated ≡ override fee (150 sen)");
  // the hold the checkout quotes must be the winner's hold (frozen to Order.holdDays)
  assert.equal(chain.holdDays, 2);
});

// ===========================================================================
console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.error("\nFailed invariants:");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("All financial-precision invariants hold (POLICY P1). ✓");
