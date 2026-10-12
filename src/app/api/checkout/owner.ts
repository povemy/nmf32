// ============================================================================
// Guest shopper identity — device token via X-Shopper-Token header (localStorage
// on the client) with the "sm_shopper_id" cookie as fallback. Header-first keeps
// the address book working in cross-site iframes where cookies are dropped.
// The app has no shopper accounts; the address book is owned by this token and
// every address query filters on it (no cross-customer exposure).
// ============================================================================
import { cookies, headers } from "next/headers";
import { ApiError } from "@/lib/api";
import { randomToken } from "@/lib/password";

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
