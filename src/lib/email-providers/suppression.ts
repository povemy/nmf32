// ============================================================================
// email-providers/suppression.ts — shared hard-bounce/complaint suppression
// check (Phase 2.3 transactional email).
//
// The suppression table (EmailSuppression, migration 20261106000000) is
// maintained by the signed provider delivery webhook. Adapters consult it
// BEFORE delivery so a hard-bounced address never receives further attempts
// (protecting the platform's sender reputation — Resend pauses accounts above
// 4% bounce / 0.08% complaint).
//
// BEST-EFFORT by design: when the table does not exist yet (migration not
// applied to this environment), the check degrades to "not suppressed" and
// caches that state per process — one warning, never a per-send error. The
// table-missing condition is the documented pre-migration window, not a
// failure mode the send path should surface to customers.
// ============================================================================
import { db } from "@/lib/db";

let tableMissingLogged = false;
let tableAvailable: boolean | null = null;

/** True when the address is suppressed (hard bounce / complaint). Best-effort:
 *  unknown/missing table ⇒ false. Never throws. */
export async function isSuppressed(email: string): Promise<boolean> {
  if (tableAvailable === false) return false;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  try {
    const row = await db.emailSuppression.findUnique({ where: { email: normalized }, select: { id: true } });
    tableAvailable = true;
    return row !== null;
  } catch {
    tableAvailable = false;
    if (!tableMissingLogged) {
      tableMissingLogged = true;
      console.warn("[email-suppression] EmailSuppression table unavailable (migration 20261106000000 not applied) — bounce suppression is inactive until it lands");
    }
    return false;
  }
}

/** Distinct error class so callers can distinguish "address suppressed"
 * (permanent delivery failure for this recipient) from transient errors. */
export class SuppressedAddressError extends Error {
  constructor(email: string) {
    // Only a redacted hint — never log full addresses in error text that may
    // end up in generic logs; callers that need the address already have it.
    super(`Email delivery suppressed for ${email.slice(0, 2)}***@${email.split("@")[1] ?? "invalid"} (hard bounce or complaint on record)`);
    this.name = "SuppressedAddressError";
  }
}
