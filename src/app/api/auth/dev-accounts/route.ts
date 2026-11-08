import { handle, ok, fail } from "@/lib/api";
import { db } from "@/lib/db";
import { verifyPasswordAsync } from "@/lib/password";
import type { DevAccountsData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// GET /api/auth/dev-accounts — DEVELOPMENT-ONLY credential reference (P12).
// ---------------------------------------------------------------------------
// Serves the "Development Test Accounts — Sandbox Only" panel at the bottom
// of the unified login modal.
//
// IMPOSSIBLE TO EXPOSE IN PRODUCTION — dual server-side gate, both must hold:
//   1. NODE_ENV === "development"          (next dev; never true in a build)
//   2. NOMOFEE_SHOW_DEV_LOGIN_CREDENTIALS === "true" (explicit opt-in flag)
// When either fails the route responds 404 NOT_FOUND — indistinguishable from
// a non-existent route: no data, no hint, no panel. There is additionally no
// client-side rendering path for the panel unless this endpoint returns 200.
//
// The panel NEVER guesses: every listed account is re-verified against its
// documented dev password (verifyPassword) at request time — a drifted or
// env-overridden account (SEED_*_PASSWORD) is silently omitted rather than
// shown with a wrong credential. Only seeded/demo sandbox identities are
// listed; genuine customer or production credentials are never returned.

type DevAccount = {
  type: "admin" | "seller" | "buyer" | "affiliate";
  label: string;
  email: string;
  password: string;
  note?: string;
};

const DEV_ACCOUNTS: DevAccount[] = [
  { type: "admin", label: "Administrator (superadmin)", email: "admin@nomofee.io", password: "Admin123!" },
  { type: "admin", label: "Operations admin", email: "ops@nomofee.io", password: "Ops12345!" },
  { type: "admin", label: "Finance admin", email: "finance@nomofee.io", password: "Finance123!" },
  { type: "admin", label: "Moderator", email: "moderator@nomofee.io", password: "Mod12345!" },
  { type: "seller", label: "Seller — Lumina Living (active)", email: "lumina@nomofee.io", password: "Seller123!" },
  { type: "seller", label: "Seller — ByteBazaar (active)", email: "byte@nomofee.io", password: "Seller123!" },
  { type: "seller", label: "Seller — Glow Theory (active)", email: "glow@nomofee.io", password: "Seller123!" },
  { type: "seller", label: "Seller — Warung Satu (pending review)", email: "warung@nomofee.io", password: "Seller123!" },
  { type: "seller", label: "Seller — TrailKit Outdoors (onboarding)", email: "trail@nomofee.io", password: "Seller123!" },
  { type: "buyer", label: "Buyer — demo shopper (wallet + vouchers)", email: "aisyah@nomofee.test", password: "NOMOFEE123!" },
  { type: "buyer", label: "Buyer — plain QA shopper", email: "qa.shopper@nomofee.test", password: "Shopper123!" },
  { type: "affiliate", label: "Affiliate — Alpha Promotes (verified sponsor chain)", email: "aff-alpha@verify.nomofee.io", password: "Verify123!" },
];

export const GET = handle(async () => {
  // DUAL GATE — fail closed, indistinguishable from a missing route.
  if (process.env.NODE_ENV !== "development" || process.env.NOMOFEE_SHOW_DEV_LOGIN_CREDENTIALS !== "true") {
    return fail(404, "NOT_FOUND", "Not found");
  }

  // Re-verify every account against its documented dev password before
  // listing it (drifted/env-overridden accounts are omitted, never guessed).
  // Phase 1 (SEC-04): asynchronous scrypt — the 12 verifications run off the
  // event loop (previously ~360 ms of synchronous blocking per panel hit).
  const verified: (DevAccount & { role?: string; status?: string })[] = [];
  for (const acc of DEV_ACCOUNTS) {
    if (acc.type === "admin") {
      const row = await db.adminUser.findUnique({ where: { email: acc.email } });
      if (row && row.isActive && (await verifyPasswordAsync(acc.password, row.passwordHash))) {
        verified.push({ ...acc, role: row.role });
      }
    } else if (acc.type === "seller") {
      // PHASE 2.3 select hygiene (C2.7): explicit fields EXCLUDING the
      // un-migrated Seller.emailVerifiedAt (default select → P2022 pre-
      // migration 20261107000000).
      const row = await db.seller.findUnique({
        where: { email: acc.email },
        select: { id: true, passwordHash: true, status: true },
      });
      if (row && (await verifyPasswordAsync(acc.password, row.passwordHash))) {
        verified.push({ ...acc, status: row.status });
      }
    } else {
      const row = await db.shopperUser.findUnique({ where: { email: acc.email } });
      if (row && row.status === "active" && (await verifyPasswordAsync(acc.password, row.passwordHash))) {
        const affiliate = acc.type === "affiliate"
          ? await db.affiliateProfile.findUnique({ where: { userId: row.id }, select: { status: true } })
          : null;
        if (acc.type !== "affiliate" || affiliate != null) {
          verified.push({ ...acc });
        }
      }
    }
  }

  const payload: DevAccountsData = {
    title: "Development Test Accounts — Sandbox Only",
    accounts: verified.map((a) => ({
      type: a.type,
      label: a.label,
      email: a.email,
      password: a.password,
      role: a.role ?? null,
      status: a.status ?? null,
    })),
  };
  return ok(payload);
});
