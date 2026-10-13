// ============================================================================
// Guest shopper identity — device token via X-Shopper-Token header (localStorage
// on the client) with the "sm_shopper_id" cookie as fallback. Header-first keeps
// the address book working in cross-site iframes where cookies are dropped.
// Dual ownership: guests scope the book to the device token; a signed-in shopper
// scopes it to their ACCOUNT (shopperId) — the account always wins, so switching
// accounts on one device can never expose another person's address book.
// ============================================================================
import { cookies, headers } from "next/headers";
import { ApiError } from "@/lib/api";
import { randomToken } from "@/lib/password";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";

export const OWNER_COOKIE = "sm_shopper_id";
const OWNER_TTL_S = 60 * 60 * 24 * 365; // 1 year
const OWNER_TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Read or mint the device owner token (route handlers may set cookies). */
export async function ensureOwnerToken(): Promise<string> {
  const h = await headers();
  const fromHeader = h.get("x-shopper-token");
  if (fromHeader && OWNER_TOKEN_RE.test(fromHeader)) return fromHeader;

  const jar = await cookies();
  const existing = jar.get(OWNER_COOKIE)?.value;
  if (existing) return existing;
  const token = `dev_${randomToken(16)}`;
  jar.set(OWNER_COOKIE, token, {
    httpOnly: false,
    sameSite: "none",
    secure: true,
    path: "/",
    maxAge: OWNER_TTL_S,
  });
  return token;
}

/** Read the device owner token from header/cookie WITHOUT minting one
 *  (used at login/register to claim guest rows created on this device). */
export async function readOwnerToken(): Promise<string | null> {
  try {
    const h = await headers();
    const fromHeader = h.get("x-shopper-token");
    if (fromHeader && OWNER_TOKEN_RE.test(fromHeader)) return fromHeader;
  } catch {
    /* headers unavailable in this context */
  }
  try {
    const jar = await cookies();
    return jar.get(OWNER_COOKIE)?.value ?? null;
  } catch {
    return null;
  }
}

export type AddressOwner = { shopperId: string | null; ownerToken: string };

/** Where-clause that scopes address queries to the resolved owner. */
export function addressScope(owner: AddressOwner) {
  return owner.shopperId
    ? { shopperId: owner.shopperId }
    : { ownerToken: owner.ownerToken, shopperId: null };
}

/**
 * Resolve the address-book owner for this request:
 *  - signed-in shopper → the ACCOUNT owns the book (shopperId);
 *    any guest rows still tied to this device are lazily claimed into the
 *    account (covers sessions that predate the claim-on-login deploy);
 *  - guest → the device token, unclaimed rows only.
 */
export async function resolveAddressOwner(): Promise<AddressOwner> {
  const ownerToken = await ensureOwnerToken();
  const sess = await getSession();
  if (sess && sess.userType === "shopper") {
    // Lazy claim — idempotent: only rows with shopperId=null on THIS device move.
    await db.address.updateMany({
      where: { ownerToken, shopperId: null },
      data: { shopperId: sess.userId },
    });
    return { shopperId: sess.userId, ownerToken };
  }
  return { shopperId: null, ownerToken };
}

export type AddressInput = {
  label: string;
  name: string;
  phone: string | null;
  line1: string;
  city: string;
  state: string;
  postcode: string;
};

/** Validate an address payload; returns trimmed fields or throws ApiError. */
export function validateAddressInput(body: Record<string, unknown>): AddressInput {
  const label = String(body.label ?? "Home").trim() || "Home";
  const name = String(body.name ?? "").trim();
  const phoneRaw = body.phone != null ? String(body.phone).trim() : "";
  const line1 = String(body.line1 ?? "").trim();
  const city = String(body.city ?? "").trim();
  const state = String(body.state ?? "").trim();
  const postcode = String(body.postcode ?? "").trim();

  if (name.length < 2) throw new ApiError(400, "VALIDATION", "Recipient name is required");
  if (phoneRaw && !/^[+()\d\s-]{6,20}$/.test(phoneRaw)) throw new ApiError(400, "VALIDATION", "Phone number is invalid");
  if (!line1) throw new ApiError(400, "VALIDATION", "Street address is required");
  if (!city) throw new ApiError(400, "VALIDATION", "City is required");
  if (!state) throw new ApiError(400, "VALIDATION", "State is required");
  if (!/^\d{5}$/.test(postcode)) throw new ApiError(400, "VALIDATION", "Postcode must be a 5-digit Malaysian postcode");

  return { label, name, phone: phoneRaw || null, line1, city, state, postcode };
}
