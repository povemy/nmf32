// Money helpers — all amounts are integer minor units (cents). NEVER floats.
// Currency default: MYR (platform launches local-first, Asia/Kuala_Lumpur).

const SYMBOLS: Record<string, string> = { MYR: "RM", SGD: "S$", IDR: "Rp" };

/** Format minor units into a display string, e.g. 123456 -> "RM 1,234.56" */
export function formatMinor(minor: number | null | undefined, currency = "MYR"): string {
  const value = (minor ?? 0) / 100;
  const sym = SYMBOLS[currency] ?? currency + " ";
  const negative = value < 0;
  const abs = Math.abs(value);
  const formatted = abs.toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${negative ? "-" : ""}${sym} ${formatted}`;
}

/** Parse a user-entered decimal amount string into minor units. "12.50" -> 1250 */
export function toMinor(input: string | number): number {
  const n = typeof input === "number" ? input : parseFloat(String(input) || "0");
  if (Number.isNaN(n)) return 0;
  return Math.round(n * 100);
}

/** Half-up division of positive integers: divHalfUp(250,100)=3? no -> 2.5 rounds to 3. Wait:
 * divHalfUp(250,100) = floor((500+100)/200)=3 → 250/100=2.5 → 3 (half-up). Correct. */
export function divHalfUp(a: number, b: number): number {
  if (b === 0) return 0;
  if (a >= 0) return Math.floor((a * 2 + b) / (b * 2));
  return -Math.floor((-a * 2 + b) / (b * 2));
}

/** commission = round_half_up(base * percent / 100) — M09 math. */
export function commissionOf(base: number, percent: number): number {
  return divHalfUp(Math.round(base * percent * 100), 10000);
}

/** Allocate `amount` across `weights` proportionally, remainder cents to largest weights. */
export function allocateProportionally(amount: number, weights: number[]): number[] {
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0 || amount === 0) return weights.map(() => 0);
  const parts = weights.map((w) => Math.floor((amount * w) / total));
  let remainder = amount - parts.reduce((s, p) => s + p, 0);
  const order = weights
    .map((w, i) => ({ i, w: w }))
    .sort((x, y) => y.w - x.w || x.i - y.i);
  let idx = 0;
  while (remainder > 0 && order.length > 0) {
    parts[order[idx % order.length].i] += 1;
    remainder -= 1;
    idx += 1;
  }
  return parts;
}
