"use client";

// ---------------------------------------------------------------------------
// Conversion Funnel — interactive 3D funnel diagram (HTML5 Canvas) + stage
// streamgraph (recharts, centered "silhouette" stream) for the Insights page.
//
// Data: GET /api/store/insights/funnel?window=today|7d|30d|1y (seller-session
// scoped; stage numbers are server-computed — this component never re-derives
// step rates or drop-off).
//
// Canvas rendering notes:
//   • The funnel is a tapered horizontal ribbon: thickness ∝ stage count
//     (min clamp keeps small stages visible/hoverable). Sections WIDEN when a
//     later stage exceeds an earlier one — the honest mixed-basis case
//     (sessions vs orders), never clamped to fake a funnel shape.
//   • Pseudo-3D: each section gets an extruded top face (lighter tint) and the
//     last section a right cap (darker shade).
//   • Icons are white-stroke SVG data-URL <Image>s drawn on the slab faces.
//   • Callout pointer chips sit above the ribbon (wide viewports); on narrow
//     viewports the count pills on the ribbon + the DOM legend carry the info.
//   • Hover: hit-test rects stored per section → lift + glow + DOM tooltip
//     with count / prev / step rate / drop-off-or-gained.
//   • Animations: thickness/height ease toward targets via requestAnimationFrame
//     (prefers-reduced-motion snaps instantly).
//   • The canvas is aria-hidden; a visually-hidden table mirrors the stage data
//     for screen readers.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import { Info, RefreshCw, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------- contract

export type FunnelViewKey = "daily" | "weekly" | "monthly" | "yearly";

/** Funnel card windows — deliberately independent of the page window so the
 *  diagram can be toggled without refetching the whole Overview payload.
 *  `1y` is accepted by the funnel route ONLY (shared window contract
 *  unchanged for every other insights route). */
export const FUNNEL_WINDOW_PARAM: Record<FunnelViewKey, string> = {
  daily: "today",
  weekly: "7d",
  monthly: "30d",
  yearly: "1y",
};
const VIEW_LABELS: Record<FunnelViewKey, string> = { daily: "Daily", weekly: "Weekly", monthly: "Monthly", yearly: "Yearly" };

export type FunnelData = {
  window: { key: string; from: string; to: string; prevFrom: string; prevTo: string; days: number };
  generatedAt: string;
  freshness: { eventsUpTo: string | null; trackingSince: string | null; note: string | null };
  stages: { key: string; label: string; count: number; prev: number; stepRate: number | null; dropOff: number | null; dropOffPct: number | null }[];
  byDay: { day: string; visits: number; productViews: number; cartAdds: number; checkouts: number; paidOrders: number }[];
  truncated: boolean;
  paymentAttempts: number;
  paymentAttemptsPrev: number;
  basis: string[];
};

export type FunnelApi = {
  data: FunnelData | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
};

// ---------------------------------------------------------------- stage meta

type StageMeta = { key: string; label: string; color: string; icon: string };

/** House palette (teal → emerald → amber → orange → rose; no blue/indigo). */
const STAGE_META: StageMeta[] = [
  {
    key: "store_visit",
    label: "Store visit",
    color: "#0d9488",
    icon: svgIcon("<path d='M3 10.5 12 3l9 7.5'/><path d='M5 9.7V21h14V9.7'/><path d='M9.5 21v-6h5v6'/>"),
  },
  {
    key: "product_view",
    label: "Product view",
    color: "#059669",
    icon: svgIcon("<path d='M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z'/><circle cx='12' cy='12' r='3'/>"),
  },
  {
    key: "add_to_cart",
    label: "Add to cart",
    color: "#d97706",
    icon: svgIcon("<circle cx='9' cy='20.5' r='1'/><circle cx='20' cy='20.5' r='1'/><path d='M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6'/>"),
  },
  {
    key: "begin_checkout",
    label: "Checkout",
    color: "#ea580c",
    icon: svgIcon("<rect x='2' y='5' width='20' height='14' rx='2'/><path d='M2 10h20'/>"),
  },
  {
    key: "purchase",
    label: "Paid order",
    color: "#e11d48",
    icon: svgIcon("<circle cx='12' cy='12' r='9.5'/><path d='m8.3 12.2 2.6 2.6 4.8-5.4'/>"),
  },
];

function svgIcon(paths: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>${paths}</svg>`
  )}`;
}

/** Hex mix toward white (t>0) or black (t<0) — for the 3D face shading. */
function shade(hex: string, t: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const m = t >= 0 ? 255 : 0;
  const k = Math.abs(t);
  const c = (v: number) => Math.round(v + (m - v) * k);
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}
function withAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const FONT = (weight: number, size: number) => `${weight} ${size}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

// ---------------------------------------------------------------- card

export function FunnelCard({ view, onView, api }: { view: FunnelViewKey; onView: (v: FunnelViewKey) => void; api: FunnelApi }) {
  const data = api.data;

  return (
    <Card className="gap-3">
      <CardHeader className="flex-row items-start justify-between space-y-0 pb-0">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-sm">
            <TrendingUp className="h-4 w-4 text-primary" /> Conversion funnel
          </CardTitle>
          <CardDescription className="text-xs">
            Interactive 3D funnel · stage flow over time
            {data?.truncated ? <span className="ml-1 text-amber-700">· sampled (very large window)</span> : null}
          </CardDescription>
        </div>
        <div
          role="group"
          aria-label="Funnel view"
          className="shrink-0 rounded-lg border bg-muted/40 p-0.5"
        >
          {(Object.keys(VIEW_LABELS) as FunnelViewKey[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => onView(k)}
              aria-pressed={view === k}
              className={cn(
                "rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                view === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {VIEW_LABELS[k]}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {api.error ? (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
            <p className="min-w-0">{api.error}</p>
            <Button variant="outline" size="sm" className="h-8 shrink-0 gap-1 text-xs" onClick={api.refetch}>
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </Button>
          </div>
        ) : api.loading || !data ? (
          <div className="space-y-3">
            <div className="h-[300px] animate-pulse rounded-xl bg-muted/60 sm:h-[340px]" />
            <div className="h-[160px] animate-pulse rounded-xl bg-muted/40" />
          </div>
        ) : (
          <>
            <FunnelCanvas stages={data.stages} />

            {/* DOM legend — also the narrow-viewport label carrier */}
            <ul className="flex flex-wrap gap-x-4 gap-y-1.5" aria-label="Funnel stages">
              {data.stages.map((s, i) => (
                <li key={s.key} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: STAGE_META[i]!.color }} aria-hidden="true" />
                  <span className="font-medium text-foreground">{s.label.replace(" (sessions)", "").replace(" (orders)", "")}</span>
                  <span className="tabular-nums">{s.count.toLocaleString("en-MY")}</span>
                </li>
              ))}
            </ul>

            <FunnelStream data={data} view={view} />

            <p className="rounded-md bg-muted/60 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
              Payment sessions (authoritative): <span className="font-semibold text-foreground">{data.paymentAttempts.toLocaleString("en-MY")}</span> in this window
              {data.paymentAttemptsPrev > 0 ? <> · {data.paymentAttemptsPrev.toLocaleString("en-MY")} in the previous window</> : null} — one record per checkout
              payment attempt; a failed-session retry re-opens the same record and is not counted twice.
            </p>
            {data.freshness?.trackingSince == null ? (
              <p className="flex gap-2 text-[11px] leading-relaxed text-amber-800">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {data.freshness?.note ?? "Traffic tracking starts from zero — visitor metrics accrue from now on."}
              </p>
            ) : null}
            <ul className="list-disc space-y-1 pl-5 text-[11px] leading-relaxed text-muted-foreground">
              {data.basis.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
            <p className="text-right text-[10px] text-muted-foreground/70">
              {VIEW_LABELS[view]} view · generated {new Date(data.generatedAt).toLocaleTimeString("en-MY", { hour: "2-digit", minute: "2-digit" })}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- canvas

type StageRow = FunnelData["stages"][number];
type HitRect = { i: number; x0: number; x1: number; y0: number; y1: number };

function FunnelCanvas({ stages }: { stages: StageRow[] }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [tip, setTip] = useState<{ i: number; x: number; y: number } | null>(null);
  const [iconTick, setIconTick] = useState(0);

  const iconsRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const hitRef = useRef<HitRect[]>([]);
  const animRef = useRef<{ thick: number[]; lift: number[]; raf: number | null }>({ thick: [], lift: [], raf: null });
  const hoverRef = useRef<number | null>(null);
  useEffect(() => {
    hoverRef.current = hover;
  }, [hover]);

  const reducedMotion = useMemo(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    []
  );

  // Load the SVG icons once; each completed load triggers a redraw.
  useEffect(() => {
    for (const m of STAGE_META) {
      if (iconsRef.current.has(m.key)) continue;
      const img = new Image();
      img.onload = () => setIconTick((t) => t + 1);
      img.src = m.icon;
      iconsRef.current.set(m.key, img);
    }
  }, []);

  // Responsive width.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(Math.max(280, Math.round(e.contentRect.width)));
    });
    ro.observe(el);
    setWidth(Math.max(280, Math.round(el.getBoundingClientRect().width)));
    return () => ro.disconnect();
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || width < 100) return;
    const wide = width >= 640;
    const H = wide ? 340 : 300;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.height = `${H}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, H);

    // ----- geometry -------------------------------------------------------
    const DX = 24;
    const DY = 12;
    const topPad = wide ? 92 : 16;
    const bottomPad = wide ? 34 : 26;
    const fx0 = 14;
    const fx1 = width - 14 - DX;
    const fy = topPad + (H - topPad - bottomPad) / 2;
    const maxThick = Math.max(60, H - topPad - bottomPad - 20);
    const minThick = 18;

    const counts = stages.map((s) => s.count);
    const maxCount = Math.max(1, ...counts);
    const targets = stages.map((s) => minThick + (s.count / maxCount) * (maxThick - minThick));
    const anim = animRef.current;
    if (anim.thick.length !== stages.length) {
      anim.thick = reducedMotion ? [...targets] : stages.map(() => 0);
      anim.lift = stages.map(() => 0);
    }

    const n = stages.length;
    const cx = (i: number) => fx0 + ((i + 0.5) * (fx1 - fx0)) / n;
    const bound = (i: number) => (i === 0 ? fx0 : i === n ? fx1 : (cx(i - 1) + cx(i)) / 2);

    const empty = counts.every((c) => c === 0);
    const thick = anim.thick;
    const lift = anim.lift;

    // Thickness at a boundary: flat over the owning stage's centre, linear
    // between adjacent stage centres.
    const thAt = (i: number) => {
      if (i <= 0) return thick[0] ?? minThick;
      if (i >= n) return thick[n - 1] ?? minThick;
      return ((thick[i - 1] ?? minThick) + (thick[i] ?? minThick)) / 2;
    };

    hitRef.current = [];

    // ----- draw ------------------------------------------------------------
    for (let i = 0; i < n; i++) {
      const bL = bound(i);
      const bR = bound(i + 1);
      const thL = Math.max(minThick * 0.6, thAt(i));
      const thR = Math.max(minThick * 0.6, thAt(i + 1));
      const meta = STAGE_META[i]!;
      const color = empty ? "#cbd5e1" : meta.color;
      const hov = hoverRef.current === i;
      const ly = -lift[i]!;

      // hit rect (generous: front face + the extruded depth column)
      const maxTh = Math.max(thL, thR);
      hitRef.current.push({ i, x0: bL, x1: bR + DX, y0: fy - maxTh / 2 - 8 + ly, y1: fy + maxTh / 2 + 6 + ly });

      const frontPath = new Path2D();
      frontPath.moveTo(bL, fy - thL / 2 + ly);
      frontPath.lineTo(bR, fy - thR / 2 + ly);
      frontPath.lineTo(bR, fy + thR / 2 + ly);
      frontPath.lineTo(bL, fy + thL / 2 + ly);
      frontPath.closePath();

      const topPath = new Path2D();
      topPath.moveTo(bL, fy - thL / 2 + ly);
      topPath.lineTo(bR, fy - thR / 2 + ly);
      topPath.lineTo(bR + DX, fy - thR / 2 - DY + ly);
      topPath.lineTo(bL + DX, fy - thL / 2 - DY + ly);
      topPath.closePath();

      // shadow under hovered slab
      if (hov) {
        ctx.save();
        ctx.shadowColor = "rgba(15,23,42,0.28)";
        ctx.shadowBlur = 20;
        ctx.shadowOffsetY = 10;
        ctx.fillStyle = shade(color, hov ? 0.08 : -0.12);
        ctx.fill(frontPath);
        ctx.restore();
      }

      // top (3D) face — lighter tint; hovered pops brighter
      const topFill = ctx.createLinearGradient(bL, fy - thL / 2 - DY + ly, bL, fy - thL / 2 + ly);
      topFill.addColorStop(0, shade(color, hov ? 0.62 : 0.45));
      topFill.addColorStop(1, shade(color, hov ? 0.2 : 0.08));
      ctx.fillStyle = topFill;
      ctx.fill(topPath);

      // front face — the stage's colour gradient
      const frontFill = ctx.createLinearGradient(0, fy - thL / 2 + ly, 0, fy + thL / 2 + ly);
      frontFill.addColorStop(0, shade(color, hov ? 0.18 : 0.04));
      frontFill.addColorStop(0.5, color);
      frontFill.addColorStop(1, shade(color, hov ? -0.1 : -0.22));
      ctx.fillStyle = frontFill;
      ctx.fill(frontPath);

      // right cap on the last section (depth shading)
      if (i === n - 1) {
        const capPath = new Path2D();
        capPath.moveTo(bR, fy - thR / 2 + ly);
        capPath.lineTo(bR + DX, fy - thR / 2 - DY + ly);
        capPath.lineTo(bR + DX, fy + thR / 2 - DY + ly);
        capPath.lineTo(bR, fy + thR / 2 + ly);
        capPath.closePath();
        ctx.fillStyle = shade(color, -0.32);
        ctx.fill(capPath);
      }

      // hover outline
      if (hov) {
        ctx.strokeStyle = withAlpha("#ffffff", 0.85);
        ctx.lineWidth = 1.5;
        ctx.stroke(frontPath);
        ctx.stroke(topPath);
      }

      // ----- icon + count on the slab ---------------------------------------
      const icx = cx(i);
      const t = thick[i] ?? minThick;
      const stage = stages[i]!;
      const cnt = stage.count.toLocaleString("en-MY");
      const icon = iconsRef.current.get(meta.key);

      if (t >= 30) {
        ctx.font = FONT(700, 14);
        const tw = ctx.measureText(cnt).width;
        const hasIcon = t >= 38 && icon?.complete;
        const iconW = hasIcon ? 20 : 0;
        const startX = icx - (tw + iconW + (iconW ? 5 : 0)) / 2;
        if (hasIcon && icon) {
          ctx.drawImage(icon, startX, fy - 9 + ly, 18, 18);
        }
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(cnt, startX + iconW + (iconW ? 5 : 0), fy + ly + 1);
      } else {
        // small slab → count pill floating above the ribbon
        ctx.font = FONT(700, 12);
        const tw = ctx.measureText(cnt).width;
        const pillW = tw + 16;
        const pillH = 20;
        const px = icx - pillW / 2;
        const py = fy - t / 2 - pillH - 5 + ly;
        roundRect(ctx, px, py, pillW, pillH, 10);
        ctx.fillStyle = "rgba(255,255,255,0.96)";
        ctx.fill();
        ctx.strokeStyle = withAlpha(color, 0.55);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = shade(color, -0.18);
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(cnt, px + 8, py + pillH / 2 + 1);
        if (icon?.complete) ctx.drawImage(icon, icx - 9, fy - 9 + ly, 18, 18);
      }

      // ----- callout pointer chips (wide viewports) --------------------------
      if (wide && !empty) {
        const level = i % 2 === 0 ? 12 : 45;
        const label = stage.label.replace(" (sessions)", "").replace(" (orders)", "");
        ctx.font = FONT(600, 10.5);
        const lw = ctx.measureText(label).width;
        ctx.font = FONT(700, 12);
        const vw = ctx.measureText(cnt).width;
        ctx.font = FONT(500, 10);
        const stepTxt = stage.stepRate != null ? `${stage.stepRate}%` : "—";
        const sw = ctx.measureText(stepTxt).width;
        const chipW = Math.max(lw, vw + 3 + sw) + 26;
        const chipH = 27;
        let chipX = icx - chipW / 2;
        chipX = Math.max(4, Math.min(width - chipW - 4, chipX));
        const chipY = level;

        // pointer line: chip → slab top edge
        const slabTop = fy - (thick[i] ?? minThick) / 2 + ly;
        ctx.strokeStyle = withAlpha(color, 0.6);
        ctx.lineWidth = 1;
        ctx.beginPath();
        const pxLine = chipX + chipW / 2;
        ctx.moveTo(pxLine, chipY + chipH);
        ctx.lineTo(pxLine, slabTop - 7);
        ctx.stroke();
        // arrowhead
        ctx.beginPath();
        ctx.moveTo(pxLine - 3.5, slabTop - 8);
        ctx.lineTo(pxLine, slabTop - 3);
        ctx.lineTo(pxLine + 3.5, slabTop - 8);
        ctx.closePath();
        ctx.fillStyle = withAlpha(color, 0.75);
        ctx.fill();

        // chip
        roundRect(ctx, chipX, chipY, chipW, chipH, 8);
        ctx.fillStyle = hov ? "#ffffff" : "rgba(255,255,255,0.94)";
        ctx.fill();
        ctx.strokeStyle = withAlpha(color, hov ? 0.95 : 0.5);
        ctx.lineWidth = hov ? 1.6 : 1;
        ctx.stroke();
        // colour dot
        ctx.beginPath();
        ctx.arc(chipX + 10, chipY + chipH / 2, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        // label + value
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        ctx.fillStyle = "#374151";
        ctx.font = FONT(600, 10.5);
        ctx.fillText(label, chipX + 18, chipY + chipH / 2 - 4.5);
        ctx.fillStyle = shade(color, -0.25);
        ctx.font = FONT(700, 12);
        ctx.fillText(cnt, chipX + 18, chipY + chipH / 2 + 6.5);
        ctx.fillStyle = "#6b7280";
        ctx.font = FONT(500, 10);
        ctx.fillText(stepTxt, chipX + 19 + ctx.measureText(cnt).width + 3, chipY + chipH / 2 + 6.5);
      }
    }

    // empty-state caption
    if (empty) {
      ctx.font = FONT(500, 12.5);
      ctx.fillStyle = "#94a3b8";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("No funnel activity in this window yet", width / 2, fy + maxThick / 2 + 16);
    }
  }, [stages, width, reducedMotion, iconTick]);

  // Animation loop — eases thickness toward targets and lift toward hover state.
  useEffect(() => {
    const targets = stages.map((s) => {
      const counts = stages.map((x) => x.count);
      const maxCount = Math.max(1, ...counts);
      const wide = width >= 640;
      const H = wide ? 340 : 300;
      const topPad = wide ? 92 : 16;
      const bottomPad = wide ? 34 : 26;
      const maxThick = Math.max(60, H - topPad - bottomPad - 20);
      return 18 + (s.count / maxCount) * (maxThick - 18);
    });
    const anim = animRef.current;
    if (anim.thick.length !== stages.length) anim.thick = reducedMotion ? [...targets] : stages.map(() => 0);
    if (anim.lift.length !== stages.length) anim.lift = stages.map(() => 0);

    if (reducedMotion) {
      anim.thick = [...targets];
      anim.lift = stages.map((_, i) => (hoverRef.current === i ? 6 : 0));
      draw();
      return;
    }

    const step = () => {
      let moving = false;
      for (let i = 0; i < targets.length; i++) {
        const dt = targets[i]! - (anim.thick[i] ?? 0);
        const dl = (hoverRef.current === i ? 6 : 0) - (anim.lift[i] ?? 0);
        if (Math.abs(dt) > 0.4) {
          anim.thick[i] = (anim.thick[i] ?? 0) + dt * 0.16;
          moving = true;
        } else anim.thick[i] = targets[i]!;
        if (Math.abs(dl) > 0.3) {
          anim.lift[i] = (anim.lift[i] ?? 0) + dl * 0.28;
          moving = true;
        } else anim.lift[i] = hoverRef.current === i ? 6 : 0;
      }
      draw();
      anim.raf = moving ? requestAnimationFrame(step) : null;
    };
    anim.raf = requestAnimationFrame(step);
    return () => {
      if (anim.raf != null) cancelAnimationFrame(anim.raf);
      anim.raf = null;
    };
  }, [stages, width, hover, reducedMotion, draw, iconTick]);

  // Pointer events → hover hit-testing + tooltip.
  const onPointer = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    let found: number | null = null;
    for (const h of hitRef.current) {
      if (x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1) {
        found = h.i;
        break;
      }
    }
    setHover(found);
    setTip(found != null ? { i: found, x: e.clientX - rect.left, y: e.clientY - rect.top } : null);
  }, []);

  const stage = tip != null ? stages[tip.i] : null;
  const meta = tip != null ? STAGE_META[tip.i] : null;

  return (
    <div ref={wrapRef} className="relative w-full">
      <canvas
        ref={canvasRef}
        className="block w-full touch-none select-none"
        style={{ cursor: hover != null ? "pointer" : "default" }}
        aria-hidden="true"
        onPointerMove={onPointer}
        onPointerLeave={() => {
          setHover(null);
          setTip(null);
        }}
      />
      {/* screen-reader mirror of the diagram */}
      <table className="sr-only">
        <caption>Conversion funnel stages for the selected window</caption>
        <thead>
          <tr>
            <th scope="col">Stage</th>
            <th scope="col">Count</th>
            <th scope="col">Previous window</th>
            <th scope="col">Step rate</th>
            <th scope="col">Drop-off</th>
          </tr>
        </thead>
        <tbody>
          {stages.map((s) => (
            <tr key={s.key}>
              <th scope="row">{s.label}</th>
              <td>{s.count}</td>
              <td>{s.prev}</td>
              <td>{s.stepRate == null ? "not computable" : `${s.stepRate}%`}</td>
              <td>{s.dropOff == null ? "—" : s.dropOff > 0 ? `${s.dropOff} (${s.dropOffPct ?? "—"}%)` : s.dropOff < 0 ? `gained ${-s.dropOff}` : "0"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {stage && meta && tip ? (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-10 w-52 rounded-xl border bg-popover/95 p-3 text-xs shadow-lg backdrop-blur"
          style={{
            left: Math.max(6, Math.min(Math.max(280, width) - 216, tip.x + 16)),
            top: Math.max(6, tip.y - 64),
          }}
        >
          <p className="flex items-center gap-1.5 font-semibold">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: meta.color }} aria-hidden="true" />
            {stage.label}
          </p>
          <p className="mt-1 tabular-nums">
            <span className="font-bold" style={{ color: shade(meta.color, -0.15) }}>{stage.count.toLocaleString("en-MY")}</span>
            <span className="text-muted-foreground"> in window · prev {stage.prev.toLocaleString("en-MY")}</span>
          </p>
          <p className="mt-0.5 tabular-nums text-muted-foreground">
            Step {stage.stepRate == null ? "—" : `${stage.stepRate}%`}
            {stage.dropOff != null ? (
              <span className={stage.dropOff > 0 ? "text-rose-600" : stage.dropOff < 0 ? "text-emerald-600" : ""}>
                {stage.dropOff > 0
                  ? ` · drop ${stage.dropOff.toLocaleString("en-MY")}${stage.dropOffPct != null ? ` (${stage.dropOffPct}%)` : ""}`
                  : stage.dropOff < 0
                    ? ` · gained ${(-stage.dropOff).toLocaleString("en-MY")}`
                    : " · drop 0"}
              </span>
            ) : null}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ---------------------------------------------------------------- streamgraph

/** Stage flow over time. Weekly/Monthly/Yearly → centred streamgraph (recharts
 *  stacked areas over an invisible negative-offset base — the "silhouette"
 *  stream). Daily → the window is a single day, so a stacked bar of today's
 *  stages replaces the degenerate one-point stream. */
function FunnelStream({ data, view }: { data: FunnelData; view: FunnelViewKey }) {
  const series = useMemo(
    () =>
      data.byDay.map((d) => {
        const vals = [d.visits, d.productViews, d.cartAdds, d.checkouts, d.paidOrders];
        const total = vals.reduce((a, b) => a + b, 0);
        return { day: d.day, off: -total / 2, v0: d.visits, v1: d.productViews, v2: d.cartAdds, v3: d.checkouts, v4: d.paidOrders, total };
      }),
    [data.byDay]
  );
  const hasFlow = series.some((p) => p.total > 0);

  if (view === "daily") {
    const p = series[series.length - 1];
    const vals = p ? [p.v0, p.v1, p.v2, p.v3, p.v4] : [0, 0, 0, 0, 0];
    const total = vals.reduce((a, b) => a + b, 0);
    return (
      <div>
        <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Today&apos;s stages</p>
        {total === 0 ? (
          <p className="rounded-xl border border-dashed py-6 text-center text-xs text-muted-foreground">No activity today yet.</p>
        ) : (
          <div className="space-y-2">
            <div className="flex h-9 w-full overflow-hidden rounded-lg" role="img" aria-label="Today's funnel stages stacked bar">
              {vals.map((v, i) =>
                v <= 0 ? null : (
                  <div
                    key={i}
                    className="h-full min-w-[4px] transition-[flex-grow] duration-500"
                    style={{ flexGrow: v, backgroundColor: STAGE_META[i]!.color }}
                    title={`${STAGE_META[i]!.label}: ${v}`}
                  />
                )
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {total.toLocaleString("en-MY")} stage events today · segments scale to their share.
            </p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Stage flow over time</p>
      {hasFlow ? (
        <div className="h-[190px] w-full" role="img" aria-label="Funnel stage flow streamgraph by day">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
              {STAGE_META.map((m, i) => (
                <defs key={m.key}>
                  <linearGradient id={`fsGrad${i}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={m.color} stopOpacity={0.72} />
                    <stop offset="100%" stopColor={m.color} stopOpacity={0.28} />
                  </linearGradient>
                </defs>
              ))}
              <XAxis
                dataKey="day"
                tickFormatter={(v: string) => String(v).slice(5)}
                fontSize={10}
                tickLine={false}
                axisLine={false}
                minTickGap={30}
                stroke="currentColor"
                className="text-muted-foreground"
              />
              <Tooltip content={<StreamTip />} />
              {/* invisible negative base centred around zero → silhouette stream */}
              <Area dataKey="off" stackId="s" type="monotone" stroke="none" fill="transparent" isAnimationActive={false} />
              {STAGE_META.map((m, i) => (
                <Area
                  key={m.key}
                  dataKey={`v${i}`}
                  stackId="s"
                  type="monotone"
                  stroke={m.color}
                  strokeWidth={1.4}
                  fill={`url(#fsGrad${i})`}
                  isAnimationActive={false}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="rounded-xl border border-dashed py-6 text-center text-xs text-muted-foreground">
          No stage activity in this window yet — the stream appears as visitor tracking and orders accrue.
        </p>
      )}
    </div>
  );
}

function StreamTip(props: { active?: boolean; payload?: Array<{ payload: { day: string; v0: number; v1: number; v2: number; v3: number; v4: number; total: number } }>; label?: string }) {
  const { active, payload } = props;
  if (!active || !payload?.length) return null;
  const p = payload[0]!.payload;
  const rows = [p.v0, p.v1, p.v2, p.v3, p.v4];
  return (
    <div className="rounded-xl border bg-popover/95 p-3 text-xs shadow-lg backdrop-blur">
      <p className="mb-1.5 font-semibold">{p.day}</p>
      <ul className="space-y-0.5">
        {STAGE_META.map((m, i) => (
          <li key={m.key} className="flex items-center justify-between gap-4 tabular-nums">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: m.color }} aria-hidden="true" />
              {m.label}
            </span>
            <span className="font-medium">{rows[i]!.toLocaleString("en-MY")}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
