// ============================================================================
// Address-book ownership — ACCOUNT-ONLY. Since guest checkout was removed,
// delivery addresses can only be created and read by a signed-in shopper, and
// the scope is strictly the account (shopperId). Nothing is keyed to the
// browser/device any more, so a guest session can never leak rows into a
// signed-in checkout (the old crossover bug) and switching accounts on one
// device can never expose another person's book.
// ============================================================================
import { cookies, headers } from "next/headers";
import { ApiError } from "@/lib/api";
import { randomToken } from "@/lib/password";
import { requireShopper } from "@/lib/auth";

export const OWNER_COOKIE = "sm_shopper_id";
const OWNER_TTL_S = 60 * 60 * 24 * 365; // 1 year
const OWNER_TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;

const DEVICE_TOKEN_RE_JAR = /^[A-Za-z0-9_-]{8,64}$/;

/** Legacy device token — kept ONLY to fill the Address.ownerToken column on
 *  rows created by signed-in shoppers (legacy rows may still carry it; the
 *  queries below NEVER match on it). */
export async function ensureOwnerToken(): Promise<string> {
  const h = await headers();
  const fromHeader = h.get("x-shopper-token");
  if (fromHeader && OWNER_TOKEN_RE.test(fromHeader)) return fromHeader;

  const jar = await cookies();
  const existing = jar.get(OWNER_COOKIE)?.value;
  if (existing && DEVICE_TOKEN_RE_JAR.test(existing)) return existing;
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

export type AddressOwner = { shopperId: string; ownerToken: string };

/** Where-clause that scopes address queries to the signed-in account. */
export function addressScope(owner: AddressOwner) {
  return { shopperId: owner.shopperId };
}

/**
 * Resolve the address-book owner for this request — the signed-in shopper
 * account. Guests get 401 (carts, checkout and the address book all require
 * sign-in now).
 */
export async function resolveAddressOwner(): Promise<AddressOwner> {
  const me = await requireShopper();
  const ownerToken = await ensureOwnerToken();
  return { shopperId: me.id, ownerToken };
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
