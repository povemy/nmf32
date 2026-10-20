// Supabase clients (SERVER-ONLY) — Supabase is the project's PostgreSQL host
// since the SQLite→Supabase migration. Routine data access flows through
// Prisma (src/lib/db.ts, datasource points at the same Supabase Postgres);
// use these clients only for Supabase-specific capabilities (Storage, Auth
// admin APIs, Realtime channels) or REST access via PostgREST.
//
// NEVER import this module from client components ("use client") — it ships
// the service-role key. The runtime guard below fails fast if that happens.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

if (typeof window !== "undefined") {
  // Blows up immediately if this module ever lands in a browser bundle.
  throw new Error("src/lib/supabase.ts is server-only — do not import it from client code.");
}

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const globalForSupabase = globalThis as unknown as {
  __nomofeeSupabaseAdmin?: SupabaseClient;
  __nomofeeSupabaseAnon?: SupabaseClient;
};

/** Service-role client: bypasses RLS. Server code paths only — never expose. */
export function getSupabaseAdmin(): SupabaseClient {
  if (!url || !serviceKey) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing — check .env");
  }
  globalForSupabase.__nomofeeSupabaseAdmin ??= createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return globalForSupabase.__nomofeeSupabaseAdmin;
}

/** Anon client: subject to RLS policies on the project's tables. */
export function getSupabaseAnon(): SupabaseClient {
  if (!url || !anonKey) {
    throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY missing — check .env");
  }
  globalForSupabase.__nomofeeSupabaseAnon ??= createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return globalForSupabase.__nomofeeSupabaseAnon;
}
