"use client";
// Data fetching helpers for the admin command centre.
// Requests carry the session via cookie AND Authorization Bearer header
// (localStorage bridge) so auth works even where cookies are unavailable.
import { useCallback, useEffect, useRef, useState } from "react";
import { authHeaders } from "@/lib/session-client";
import { signalSessionExpired } from "@/lib/session-events";

export type ApiMeta = { page: number; size: number; total: number };

type EnvelopeBody = { data?: unknown; meta?: ApiMeta; error?: { code?: string; message?: string; details?: unknown } };

async function parseBody(res: Response): Promise<EnvelopeBody> {
  try {
    return (await res.json()) as EnvelopeBody;
  } catch {
    return {};
  }
}

function bodyError(body: EnvelopeBody, status: number): string {
  return body.error?.message || `Request failed (${status})`;
}

/** A 401 means the admin session is gone/invalid — surface it so app-root can
 *  re-check identity and the login gate takes over immediately (instead of
 *  leaving a zombie command centre behind). Throttled in the emitter. */
function noteUnauthorized(status: number): void {
  if (status === 401) signalSessionExpired();
}

/** GET with the standard envelope; throws Error(message) on failure. */
export async function apiGet<T>(url: string): Promise<{ data: T; meta?: ApiMeta }> {
  const res = await fetch(url, { cache: "no-store", headers: authHeaders() });
  const body = await parseBody(res);
  if (!res.ok) {
    noteUnauthorized(res.status);
    throw new Error(bodyError(body, res.status));
  }
  return { data: (body.data ?? null) as T, meta: body.meta };
}

/** POST / PATCH / PUT / DELETE with JSON body; resolves with envelope data. */
export async function apiSend<T = unknown>(
  url: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  body?: unknown
): Promise<T> {
  const res = await fetch(url, {
    method,
    cache: "no-store",
    headers: { ...authHeaders(), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const parsed = await parseBody(res);
  if (!res.ok) {
    noteUnauthorized(res.status);
    throw new Error(bodyError(parsed, res.status));
  }
  return (parsed.data ?? null) as T;
}

/**
 * useApi — fetch a JSON endpoint with cache:"no-store".
 * Returns { data, meta, error, loading, refetch }. `refetch` is silent (keeps current data).
 * When `url` changes, previous data is cleared and a skeleton-friendly loading pass runs.
 */
export function useApi<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [meta, setMeta] = useState<ApiMeta | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(url));
  const seq = useRef(0);
  const lastUrl = useRef<string | null>(null);

  const refetch = useCallback(async () => {
    if (!url) return;
    const id = ++seq.current;
    try {
      const body = await apiGet<T>(url);
      if (seq.current !== id) return;
      setData(body.data);
      setMeta(body.meta);
      setError(null);
    } catch (e) {
      if (seq.current !== id) return;
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      if (seq.current === id) setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    if (lastUrl.current !== url) {
      lastUrl.current = url;
      seq.current += 1;
      setData(null);
      setMeta(undefined);
      setError(null);
      setLoading(Boolean(url));
    }
    if (!url) return;
    void refetch();
  }, [refetch, url]);

  return { data, meta, error, loading, refetch };
}

/** Debounce a fast-changing value (used for search boxes and the live simulator). */
export function useDebounced<T>(value: T, delayMs = 400): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

/** Safe JSON parse with fallback (schema JSON columns are strings in SQLite). */
export function parseJsonSafe<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
