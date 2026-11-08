"use client";
// ============================================================================
// Market-home client fetcher (work order 14) — request COALESCING so the
// homepage and the header (categories) share ONE /api/market/home request
// per load instead of two. In-flight promise sharing only: concurrent mounts
// during initial render dedupe; once settled, the next mount fetches fresh
// (no stale client cache — the server keeps the 60 s data cache).
// ============================================================================
import { fetchJson } from "./ui-bits";
// HomePayload is derived from the contract's MarketHomeData (GET /api/market/home).
import type { HomePayload } from "./home/types";

let inflight: Promise<HomePayload> | null = null;

export function fetchMarketHome(): Promise<HomePayload> {
  if (!inflight) {
    inflight = fetchJson<HomePayload>("/api/market/home").finally(() => {
      // Release immediately after settle — later navigations re-fetch.
      inflight = null;
    });
  }
  return inflight;
}
