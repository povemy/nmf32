// Task 2-a local helpers — shared by /api/admin/** routes only.
import { NextRequest } from "next/server";
import { ApiError } from "@/lib/api";

export type Body = Record<string, unknown>;

/** Parse a JSON body safely; throws 400 on malformed JSON. */
export async function readBody(req: NextRequest): Promise<Body> {
  try {
    const raw = await req.json();
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw as Body;
  } catch {
    throw new ApiError(400, "BAD_JSON", "Request body must be valid JSON");
  }
}

export function str(body: Body, key: string): string | undefined {
  const v = body[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

export function reqStr(body: Body, key: string, label?: string): string {
  const v = str(body, key);
  if (v == null) throw new ApiError(400, "VALIDATION", `${label ?? key} is required`);
  return v;
}

export function optNum(body: Body, key: string): number | undefined {
  const v = body[key];
  if (v == null || v === "") return undefined;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : undefined;
}

export function reqNum(body: Body, key: string, label?: string): number {
  const v = optNum(body, key);
  if (v == null) throw new ApiError(400, "VALIDATION", `${label ?? key} is required and must be a number`);
  return v;
}

export function optBool(body: Body, key: string): boolean | undefined {
  const v = body[key];
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

export function optDate(body: Body, key: string): Date | undefined | null {
  const v = body[key];
  if (v == null || v === "") return undefined;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new ApiError(400, "VALIDATION", `${key} is not a valid date`);
  return d;
}

/** YYYY-MM-DD key for a date (UTC-stable). */
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86400000);
}

/** Escape a value for CSV output. */
export function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(",");
}

/** Parse a string column that holds JSON, with fallback. */
export function parseMaybeJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Strip password hashes before returning seller rows. Accepts rows WITH or
 *  WITHOUT a passwordHash field — Phase 2.3 explicit selects never fetch it,
 *  so the parameter must not require it (weak-type check) while still
 *  stripping it from any row that carries one. */
export function stripSeller<T extends object>(s: T & { passwordHash?: string }): Omit<T, "passwordHash"> {
  const { passwordHash: _ph, ...rest } = s;
  return rest as Omit<T, "passwordHash">;
}
