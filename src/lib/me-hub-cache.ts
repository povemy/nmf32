"use client";
// ============================================================================
// Me-hub shared cache — the "Me" page data (profile / wallet / order bucket
// counts / like + viewed counters) in a module-level store, mirroring the
// cart's instant-update philosophy (ui-bits useCart):
//
//   1. PREFETCH ON LOGIN — app-store.refreshMe() calls prefetchMeHub() the
//      moment a shopper session resolves, so by the time the user opens the
//      Me tab the banner data has (usually) already landed — no skeleton.
//   2. PERSISTED SNAPSHOT — the latest payload is mirrored to localStorage
//      per shopper, so even a hard reload paints the banner from cache in
//      the first frame and revalidates in the background (stale-while-
//      revalidate).
//   3. SILENT RE-SYNCS — data-bearing updates never flip a loading flag, so
//      live refreshes never flash skeletons over painted content.
//
// The 45s freshness window keeps boot light: a prefetch right before the Me
// page mounts doesn't duplicate the fetches; force paths (settings save,
// address CRUD, vouchers) always revalidate.
// ============================================================================

import { deviceHeaders } from "./session-client";

// ---------------------------------------------------------------------------
// Types (shared with the Me hub UI)
// ---------------------------------------------------------------------------

export type MeTier = "SILVER" | "GOLD" | "PLATINUM";

export type MeProfile = {
  id: string;
  email: string;
  /** FINAL CLOSURE §2 — false until the shopper proves ownership of their
   *  email (drives the Me-hub verification card; guest-order claiming is
   *  gated on the server by the same proof). */
  emailVerified: boolean;
  fullName: string;
  username: string | null;
  avatarUrl: string | null;
  phone: string | null;
  membershipLevel: MeTier;
  followingCount: number;
  followerCount: number;
  memberSince: string;
  addressCount: number;
  lifetimeSpendMinor: number;
  tierProgress: { nextTier: MeTier; remainingMinor: number; percent: number } | null;
};

export type MeWallet = {
  wallet: {
    balanceMinor: number;
    coinBalance: number;
    payLaterLimitMinor: number;
    payLaterUsedMinor: number;
    payLaterAvailableMinor: number;
    checkInStreak: number;
  };
  vouchers: { available: number; used: number };
  checkIn: { canClaim: boolean; nextClaimAt: string | null };
};

export type MeBucketCounts = Record<string, number>;

export type MeHubSnapshot = {
  shopperId: string | null;
  profile: MeProfile | null;
  wallet: MeWallet | null;
  counts: MeBucketCounts | null;
  likeCount: number;
  viewedCount: number;
  /** Epoch ms of the last successful network fill — null until then. */
  fetchedAt: number | null;
};

// ---------------------------------------------------------------------------
// Module store (useSyncExternalStore-compatible)
// ---------------------------------------------------------------------------

const EMPTY: MeHubSnapshot = {
  shopperId: null,
  profile: null,
  wallet: null,
  counts: null,
  likeCount: 0,
  viewedCount: 0,
  fetchedAt: null,
};

/** Server snapshot — SSR markup always paints the pre-data state; hydration
 *  swaps in the cached snapshot on the client without a mismatch warning
 *  (useSyncExternalStore handles the two-pass render). */
const SERVER_SNAPSHOT = EMPTY;

let state: MeHubSnapshot = EMPTY;
const subs = new Set<() => void>();

function emit() {
  for (const fn of subs) fn();
}

export function subscribeMeHub(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

export function getMeHubSnapshot(): MeHubSnapshot {
  return state;
}

export function getMeHubServerSnapshot(): MeHubSnapshot {
  return SERVER_SNAPSHOT;
}

// ---------------------------------------------------------------------------
// Persistence — one compact payload per browser, keyed by shopper id
// ---------------------------------------------------------------------------

const CACHE_KEY = "sm_me_hub_cache_v1";
/** Skip the network when a same-shopper fill is younger than this. */
const FRESH_MS = 45_000;

type StoredPayload = MeHubSnapshot & { v: 1 };

function persist(shopperId: string) {
  try {
    const payload: StoredPayload = { v: 1, ...state, shopperId };
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    /* storage blocked / quota — cache stays in memory only */
  }
}

function readStored(shopperId: string): Partial<MeHubSnapshot> | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as StoredPayload;
    if (!p || p.v !== 1 || p.shopperId !== shopperId || !p.profile) return null;
    return p;
  } catch {
    return null;
  }
}

/** Seed the store from the persisted snapshot (same shopper only) and paint
 *  it instantly. Returns true when a cached payload was adopted. */
export function hydrateMeHub(shopperId: string): boolean {
  const stored = readStored(shopperId);
  if (!stored) return false;
  state = {
    shopperId,
    profile: stored.profile ?? null,
    wallet: stored.wallet ?? null,
    counts: stored.counts ?? null,
    likeCount: stored.likeCount ?? 0,
    viewedCount: stored.viewedCount ?? 0,
    fetchedAt: stored.fetchedAt ?? 1, // truthy → "not loading", stale-while-revalidate
  };
  emit();
  return true;
}

/** Wipe memory + persisted cache (logout / account switch). */
export function clearMeHubCache(): void {
  state = EMPTY;
  emit();
  try {
    window.localStorage.removeItem(CACHE_KEY);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Network fill — the same five calls the Me page always made, just earlier
// ---------------------------------------------------------------------------

type Envelope<T> = { data?: T; meta?: { total?: number }; error?: { code?: string; message?: string } };

async function getEnvelope<T>(url: string): Promise<{ data: T; meta?: { total?: number } }> {
  const res = await fetch(url, { cache: "no-store", headers: { ...deviceHeaders() } });
  let body: Envelope<T> | null = null;
  try {
    body = (await res.json()) as Envelope<T>;
  } catch {
    /* non-json */
  }
  if (!res.ok || !body || body.error) throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
  return { data: (body.data ?? ({} as T)) as T, meta: body.meta };
}

const DORMANT_WALLET: MeWallet = {
  wallet: { balanceMinor: 0, coinBalance: 0, payLaterLimitMinor: 0, payLaterUsedMinor: 0, payLaterAvailableMinor: 0, checkInStreak: 0 },
  vouchers: { available: 0, used: 0 },
  checkIn: { canClaim: false, nextClaimAt: null },
};

let inflight: Promise<void> | null = null;

/**
 * Fill the store for this shopper. `force` bypasses the 45s freshness window
 * (settings save, address CRUD, explicit refresh). Concurrent calls dedupe
 * into one inflight round-trip.
 */
export function refreshMeHub(shopperId: string, opts?: { force?: boolean }): Promise<void> {
  if (state.shopperId !== shopperId) {
    // first fill for this shopper (or another account was cached) — the new
    // payload only replaces state once it arrives; until then keep whatever
    // hydrateMeHub painted
    state = { ...EMPTY, shopperId };
    emit();
  } else if (!opts?.force && state.fetchedAt !== null && Date.now() - state.fetchedAt < FRESH_MS) {
    return Promise.resolve(); // fresh enough — skip the network
  }
  if (inflight) return inflight;

  inflight = (async () => {
    const [p, w, o, lk, vw] = await Promise.allSettled([
      getEnvelope<MeProfile>("/api/me/profile"),
      getEnvelope<Partial<MeWallet> & { disabled?: boolean }>("/api/me/wallet"),
      getEnvelope<{ bucketCounts: MeBucketCounts }>("/api/me/orders?size=1"),
      getEnvelope<{ activities: unknown[] }>("/api/me/activity?type=LIKE&size=1"),
      getEnvelope<{ activities: unknown[] }>("/api/me/activity?type=VIEWED&size=1"),
    ]);
    if (p.status !== "fulfilled") {
      // profile is the identity anchor — a failure here (401/logout, offline)
      // must not stamp a fresh fetchedAt over another shopper's cache
      if (state.shopperId === shopperId && state.fetchedAt === null) state = { ...state, fetchedAt: 1 };
      emit();
      return;
    }
    // DORMANT SCAFFOLD — NOMO FINANCE: normalize the disabled wallet envelope
    // into the UI shape so kept scaffold cards render inert zeroes.
    const rawW = w.status === "fulfilled" ? w.value.data : null;
    const next: MeHubSnapshot = {
      shopperId,
      profile: p.value.data,
      wallet: rawW
        ? {
            wallet: rawW.wallet ?? DORMANT_WALLET.wallet,
            vouchers: rawW.vouchers ?? DORMANT_WALLET.vouchers,
            checkIn: rawW.checkIn ?? DORMANT_WALLET.checkIn,
          }
        : DORMANT_WALLET,
      counts: o.status === "fulfilled" ? (o.value.data.bucketCounts ?? {}) : state.counts,
      likeCount: lk.status === "fulfilled" ? (lk.value.meta?.total ?? 0) : state.likeCount,
      viewedCount: vw.status === "fulfilled" ? (vw.value.meta?.total ?? 0) : state.viewedCount,
      fetchedAt: Date.now(),
    };
    if (state.shopperId !== shopperId && state.profile) return; // account switched mid-flight — drop
    state = next;
    emit();
    persist(shopperId);
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Fire-and-forget prefetch — called by app-store.refreshMe() the moment a
 *  shopper session resolves (boot, sign-in, register, profile save). */
export function prefetchMeHub(shopperId: string): void {
  void refreshMeHub(shopperId).catch(() => {
    /* offline / auth race — the Me page revalidates on mount */
  });
}
