// F1 regression — deterministic unit tests for the bounded retry helper
// (src/lib/tx-retry.ts). Uses the injectable runner so no database is needed:
// scripted error sequences prove the retry contract exactly.
//
//   1. success first try → single transaction execution
//   2. P2034 once → whole transaction re-run from the beginning, then succeeds
//   3. P2034 always → bounded attempts, then ApiError 503 PAYMENT_TX_RETRY_EXHAUSTED
//   4. ApiError (business/validation) → NEVER retried
//   5. P2024 / P2028 / P2002 (resource + dedup classes) → NEVER retried
//   6. claim-miss convergence model: a retried attempt against a committed
//      winner observes claim.count === 0 → returns "not claimed" without any
//      money-effect (the exact shape process.ts relies on)
//   7. backoff bounds: every scheduled wait ∈ [0, BACKOFF_MAX] and grows
//   8. classification: isTransientTxConflict true ONLY for P2034
// @ts-nocheck
import { Prisma } from "@prisma/client";
import { withSerializableTxRetry, isTransientTxConflict, conflictBackoffMs } from "../src/lib/tx-retry";
import { ApiError } from "../src/lib/api";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function p2034(): Error {
  return new Prisma.PrismaClientKnownRequestError("Transaction failed due to a write conflict or a deadlock...", {
    code: "P2034",
    clientVersion: "test",
  });
}
function prismaErr(code: string): Error {
  return new Prisma.PrismaClientKnownRequestError("synthetic", { code, clientVersion: "test" });
}

// 1 ── success first try
{
  let runs = 0;
  const r = await withSerializableTxRetry(async () => {
    runs++;
    return "ok";
  }, (fn) => fn({} as never));
  check("1. success first try → 1 execution, value returned", runs === 1 && r === "ok", `runs=${runs}`);
}

// 2 ── transient conflict once, then success (whole tx re-run)
{
  let runs = 0;
  const seenTx: string[] = [];
  const r = await withSerializableTxRetry(async (tx) => {
    runs++;
    seenTx.push(tx.tag);
    if (runs === 1) throw p2034();
    return "recovered";
  }, async (fn) => fn({ tag: `tx#${runs + 1}` } as never));
  check("2. P2034 once → retried whole tx, recovered", r === "recovered" && runs === 2 && seenTx[0] !== seenTx[1], `runs=${runs} tx=${seenTx.join(",")}`);
}

// 3 ── conflicts persist → bounded exhaustion with explicit failure
{
  let runs = 0;
  let thrown: unknown = null;
  const t0 = Date.now();
  try {
    await withSerializableTxRetry(async () => {
      runs++;
      throw p2034();
    }, (fn) => fn({} as never));
  } catch (e) {
    thrown = e;
  }
  const is503 = thrown instanceof ApiError && thrown.status === 503 && thrown.code === "PAYMENT_TX_RETRY_EXHAUSTED";
  const attempts = (thrown as ApiError)?.details?.attempts;
  check("3. persistent P2034 → ApiError 503 PAYMENT_TX_RETRY_EXHAUSTED (never success)", is503, String(thrown));
  check("3a. exhausted after exactly 3 attempts (default budget)", runs === 3 && attempts === 3, `runs=${runs} attempts=${attempts}`);
  const waited = Date.now() - t0;
  check("3b. bounded backoff actually waited (0 < total < 5s)", waited > 0 && waited < 5000, `waited=${waited}ms`);
}

// 4 ── business/validation ApiError never retried
{
  let runs = 0;
  let thrown: unknown = null;
  try {
    await withSerializableTxRetry(async () => {
      runs++;
      throw new ApiError(409, "AMOUNT_MISMATCH", "nope");
    }, (fn) => fn({} as never));
  } catch (e) {
    thrown = e;
  }
  const pass = runs === 1 && thrown instanceof ApiError && thrown.code === "AMOUNT_MISMATCH" && thrown.status === 409;
  check("4. ApiError business failure → immediate, unmodified, no retry", pass, `runs=${runs}`);
}

// 5 ── non-conflict Prisma classes never retried
for (const code of ["P2024", "P2028", "P2002", "P2003"]) {
  let runs = 0;
  let thrown: unknown = null;
  try {
    await withSerializableTxRetry(async () => {
      runs++;
      throw prismaErr(code);
    }, (fn) => fn({} as never));
  } catch (e) {
    thrown = e;
  }
  const pass = runs === 1 && thrown instanceof Prisma.PrismaClientKnownRequestError && (thrown as Error).message === "synthetic";
  check(`5. ${code} → immediate failure, no retry`, pass, `runs=${runs}`);
}

// 6 ── claim-miss convergence model (deterministic two-delivery race)
{
  // Fake store: the claim flips status; a committed winner means the loser's
  // next claim matches 0 rows → process.ts returns "not claimed" → duplicate.
  const store = { status: "pending", t1Postings: 0, notifications: 0 };
  let claimAttempts = 0;
  const winnerRan = { value: false };

  const fakeRunner = (fn: (tx: unknown) => Promise<unknown>) => fn({ storeMode: true });

  const attempt = async () =>
    withSerializableTxRetry(async (tx: { storeMode: boolean }) => {
      claimAttempts++;
      // conditional claim — the loser lands here AFTER the winner committed
      if (store.status !== "succeeded") {
        store.status = "succeeded";
        // winner-only money + side effects (all inside "tx")
        store.t1Postings++;
        store.notifications++;
        winnerRan.value = true;
        return { claimed: true as const };
      }
      return { claimed: false as const };
    }, fakeRunner);

  const winner = await attempt();
  const loser = await attempt(); // delivered after winner committed → claim-miss, NO retry needed
  check("6a. winner claims exactly once", winner.claimed === true && winnerRan.value && store.t1Postings === 1 && store.notifications === 1);
  check("6b. loser converges to not-claimed (duplicate) — zero extra effects", loser.claimed === false && store.t1Postings === 1 && store.notifications === 1, `t1=${store.t1Postings} notif=${store.notifications}`);
  check("6c. loser did not re-run the money path", claimAttempts === 2 && store.t1Postings === 1);
}

// 7 ── backoff bounds + growth
{
  let inBounds = true, grows = true, prev = -1;
  for (let a = 1; a <= 5; a++) {
    const samples = Array.from({ length: 200 }, () => conflictBackoffMs(a));
    if (samples.some((ms) => ms < 0 || ms > 400)) inBounds = false;
    const mean = samples.reduce((s, x) => s + x, 0) / samples.length;
    if (prev >= 0 && mean <= prev) grows = false;
    prev = mean;
  }
  check("7a. backoff always within [0, 400ms] cap", inBounds);
  check("7b. expected wait grows with attempt number (bounded exponential)", grows);
}

// 8 ── classification exactness
{
  check("8a. P2034 classified transient", isTransientTxConflict(p2034()) === true);
  check("8b. P2024/P2028/P2002/ApiError/plain Error NOT transient", ["P2024", "P2028", "P2002"].every((c) => !isTransientTxConflict(prismaErr(c))) && !isTransientTxConflict(new ApiError(409, "X", "x")) && !isTransientTxConflict(new Error("boom")));
}

console.log(failures === 0 ? "\nTX-RETRY UNIT REGRESSION: ALL PASS" : `\nTX-RETRY UNIT REGRESSION: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
