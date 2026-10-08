// Admin command centre — internal navigation types (no URLs; views are state).
export type AdminParams = Record<string, string>;

export type AdminNav = {
  view: string;
  params: AdminParams;
  navigate: (view: string, params?: AdminParams) => void;
};

/** Build a query string from a filter object (empty/nullish values skipped). */
export function qs(params: Record<string, string | number | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && String(v) !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}
