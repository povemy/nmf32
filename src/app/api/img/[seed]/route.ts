import { NextRequest, NextResponse } from "next/server";

// Deterministic SVG placeholder image service: /api/img/{seed}?w=800&h=600&label=Ceramic+Vase
// ?icon=product → neutral branded product tile (shopping-bag glyph, soft
// slate-teal gradient) used as the platform-wide fallback for imageless
// products — calmer than the letter tiles and never mistaken for content.
const PALETTES: [string, string][] = [
  ["#134e4a", "#14b8a6"],
  ["#4c1d95", "#a78bfa"],
  ["#7c2d12", "#fb923c"],
  ["#14532d", "#4ade80"],
  ["#713f12", "#facc15"],
  ["#831843", "#f472b6"],
  ["#1e3a8a", "#60a5fa"],
  ["#3f3f46", "#a1a1aa"],
];

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Neutral branded "no product photo" tile — a shopping-bag glyph over a
 *  soft slate gradient. Deliberately quiet so it reads as a placeholder. */
function productGlyphSvg(w: number, h: number): string {
  const cx = w / 2;
  const cy = h / 2;
  const s = Math.min(w, h) / 240; // glyph scale (drawn on a 240-grid)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#eef6f9"/>
      <stop offset="100%" stop-color="#cfe7ee"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#g)"/>
  <circle cx="${w * 0.82}" cy="${h * 0.2}" r="${Math.min(w, h) * 0.22}" fill="#00a8c6" opacity="0.06"/>
  <circle cx="${w * 0.16}" cy="${h * 0.82}" r="${Math.min(w, h) * 0.26}" fill="#004b5c" opacity="0.05"/>
  <g transform="translate(${cx} ${cy}) scale(${s})" fill="none" stroke="#55666c" stroke-width="9" stroke-linejoin="round" stroke-linecap="round" opacity="0.55">
    <path d="M-34 -20 h68 l6 64 h-80 z"/>
    <path d="M-16 -20 v-10 a16 16 0 0 1 32 0 v10"/>
  </g>
</svg>`;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ seed: string }> }) {
  const { seed } = await ctx.params;
  const url = new URL(req.url);
  const w = Math.min(2400, Math.max(40, parseInt(url.searchParams.get("w") ?? "800", 10) || 800));
  const h = Math.min(2400, Math.max(40, parseInt(url.searchParams.get("h") ?? "600", 10) || 600));
  if (url.searchParams.get("icon") === "product") {
    return new NextResponse(productGlyphSvg(w, h), {
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }
  const label = url.searchParams.get("label") ?? seed.replace(/[-_]/g, " ");
  const palette = PALETTES[hashStr(seed) % PALETTES.length];
  const initials = label
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p.charAt(0).toUpperCase())
    .join("");
  const fs = Math.round(Math.min(w, h) / 5);
  const dotR = hashStr(label) % 4;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
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
  return new NextResponse(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
