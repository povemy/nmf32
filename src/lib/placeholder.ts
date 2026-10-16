// ============================================================================
// Deterministic SVG placeholder builder — shared engine behind the offline
// placeholder pipeline. GET /api/img/{seed} serves the HTTP flavour; the lib
// flavour (data-URLs) lets server code embed the same imagery without a
// network round-trip (e.g. shipment AWB labels, mock proof-of-delivery photos).
// Same palettes + hash as the route so both stay visually identical.
// ============================================================================

export const PLACEHOLDER_PALETTES: [string, string][] = [
  ["#134e4a", "#14b8a6"],
  ["#4c1d95", "#a78bfa"],
  ["#7c2d12", "#fb923c"],
  ["#14532d", "#4ade80"],
  ["#713f12", "#facc15"],
  ["#831843", "#f472b6"],
  ["#1e3a8a", "#60a5fa"],
  ["#3f3f46", "#a1a1aa"],
];

/** FNV-1a 32-bit — stable across processes (no Math.random anywhere here). */
export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export type PlaceholderOptions = {
  seed: string;
  w?: number;
  h?: number;
  label?: string;
};

/** Build the deterministic gradient tile SVG (mirrors /api/img/{seed} output). */
export function placeholderSvg(opts: PlaceholderOptions): string {
  const seed = opts.seed ?? "placeholder";
  const w = Math.min(2400, Math.max(40, Math.round(opts.w ?? 800)));
  const h = Math.min(2400, Math.max(40, Math.round(opts.h ?? 600)));
  const label = opts.label ?? seed.replace(/[-_]/g, " ");
  const palette = PLACEHOLDER_PALETTES[hashStr(seed) % PLACEHOLDER_PALETTES.length];
  const initials = label
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p.charAt(0).toUpperCase())
    .join("");
  const fs = Math.round(Math.min(w, h) / 5);
  const dotR = hashStr(label) % 4;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${palette[0]}"/>
      <stop offset="100%" stop-color="${palette[1]}"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#g)"/>
  <circle cx="${w * 0.82}" cy="${h * 0.2}" r="${Math.min(w, h) * (0.18 + dotR * 0.04)}" fill="#ffffff" opacity="0.08"/>
  <circle cx="${w * 0.16}" cy="${h * 0.82}" r="${Math.min(w, h) * 0.24}" fill="#000000" opacity="0.10"/>
  <text x="50%" y="52%" dominant-baseline="middle" text-anchor="middle" font-family="system-ui,Segoe UI,sans-serif" font-weight="700" font-size="${fs}" fill="#ffffff" opacity="0.92">${initials}</text>
  <text x="50%" y="${52 + fs / 2.2}%" text-anchor="middle" font-family="system-ui,Segoe UI,sans-serif" font-size="${Math.round(fs / 3.4)}" fill="#ffffff" opacity="0.75">${label.replace(/[<>&]/g, "")}</text>
</svg>`;
}

/** Relative URL served by the offline placeholder route (never external hosts). */
export function placeholderUrl(seed: string, opts?: { w?: number; h?: number; label?: string }): string {
  const params = new URLSearchParams();
  if (opts?.w) params.set("w", String(opts.w));
  if (opts?.h) params.set("h", String(opts.h));
  if (opts?.label) params.set("label", opts.label);
  const qs = params.toString();
  return `/api/img/${encodeURIComponent(seed)}${qs ? `?${qs}` : ""}`;
}

/** Inline SVG data-URL — renders offline (no HTTP fetch needed). */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

/** Convenience: deterministic placeholder tile as an inline data-URL. */
export function placeholderDataUrl(opts: PlaceholderOptions): string {
  return svgDataUrl(placeholderSvg(opts));
}
