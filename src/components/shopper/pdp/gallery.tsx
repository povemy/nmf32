"use client";
// ============================================================================
// PDP makeover — product media gallery.
//  - Mobile: edge-to-edge horizontal swipe (CSS scroll-snap) + TikTok-style
//    "1/6" position pill; no thumbnail clutter below md.
//  - Desktop (md+): thumbnail strip under the main viewport.
//  - Zoom: double-tap/double-click toggles 2.5× at the tap point; two-finger
//    pinch scales 1–4×; one-finger drag pans while zoomed. touch-action is
//    pan-x/pan-y when at rest (browser owns swipe + page scroll) and none
//    while zoomed (JS owns the pan).
//  - Overlays: real discount badge (coral, promo indicator only), real
//    low-stock chip, wishlist + share rail.
//  - Per-variant imagery: when the selected SKU carries its own imageUrl it
//    becomes slide 1 (deduped) and the gallery auto-scrolls to it.
// ============================================================================
import { useEffect, useMemo, useRef, useState } from "react";
import { Heart, Share2, ZoomOut } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const MAX_SCALE = 4;
const TAP_SCALE = 2.5;
const DOUBLE_TAP_MS = 300;

type Zoom = { scale: number; ox: number; oy: number; dx: number; dy: number };
const NO_ZOOM: Zoom = { scale: 1, ox: 50, oy: 50, dx: 0, dy: 0 };

export function PdpGallery({
  title,
  images,
  variantImageUrl,
  discountOff,
  lowStock,
  liked,
  onToggleLike,
  shareUrl,
  onImageChange,
}: {
  title: string;
  images: string[];
  /** Selected variant's own image (null → product-level gallery). */
  variantImageUrl: string | null;
  /** Real discount percent (null → no badge; never fabricated). */
  discountOff: number | null;
  /** Real stock when it is at/below the seller's threshold (else null). */
  lowStock: number | null;
  liked: boolean;
  onToggleLike: () => void;
  /** Canonical deep link (/?sf=&sp=) — the SPA URL itself stays "/". */
  shareUrl: string;
  /** Fires when the ACTIVE image changes (funnel: view_item_gallery). */
  onImageChange?: (index: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [zoom, setZoom] = useState<Zoom>(NO_ZOOM);
  const [animating, setAnimating] = useState(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ startDist: number; startScale: number } | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);

  // Slide list: the variant's own image first (deduped) when one is set.
  const slides = useMemo(() => {
    const base = images.length > 0 ? images : ["/api/img/fallback?w=900&h=900"];
    if (variantImageUrl && !base.includes(variantImageUrl)) return [variantImageUrl, ...base];
    return base;
  }, [images, variantImageUrl]);

  const resetZoom = () => {
    setAnimating(true);
    setZoom(NO_ZOOM);
  };

  const goTo = (i: number) => {
    const el = trackRef.current;
    if (!el) return;
    el.scrollTo({ left: i * el.clientWidth, behavior: "smooth" });
  };

  // Variant imagery change → jump to that slide and reset zoom.
  useEffect(() => {
    if (!variantImageUrl) return;
    const idx = slides.indexOf(variantImageUrl);
    if (idx >= 0) {
      resetZoom();
      goTo(idx);
    }
  }, [variantImageUrl, slides]);

  // Scroll → active index sync (+ zoom reset on slide change).
  const handleScroll = () => {
    const el = trackRef.current;
    if (!el || el.clientWidth === 0) return;
    const i = Math.max(0, Math.min(slides.length - 1, Math.round(el.scrollLeft / el.clientWidth)));
    if (i !== active) {
      setActive(i);
      if (zoom.scale > 1) resetZoom();
      onImageChange?.(i);
    }
  };

  // ---- zoom/pan/pinch pointer engine --------------------------------------
  const relPos = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    // Capture keeps pan/pinch events flowing to this slide even when the
    // pointer crosses its bounds mid-gesture (pointerup always lands here).
    try {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    } catch {
      /* capture unsupported — events still work within bounds */
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Double-tap / double-click → toggle zoom at the tap point.
    const p = relPos(e);
    const now = Date.now();
    const lt = lastTap.current;
    if (lt && now - lt.t < DOUBLE_TAP_MS && Math.hypot(lt.x - e.clientX, lt.y - e.clientY) < 24 && pointers.current.size === 1) {
      lastTap.current = null;
      setAnimating(true);
      if (zoom.scale > 1) setZoom(NO_ZOOM);
      else setZoom({ scale: TAP_SCALE, ox: (p.x / p.w) * 100, oy: (p.y / p.h) * 100, dx: 0, dy: 0 });
      return;
    }
    lastTap.current = { t: now, x: e.clientX, y: e.clientY };

    // Two pointers → begin pinch.
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { startDist: Math.hypot(a.x - b.x, a.y - b.y), startScale: zoom.scale };
      setAnimating(false);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const mid = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
      const scale = Math.max(1, Math.min(MAX_SCALE, (pinch.current.startDist > 0 ? dist / pinch.current.startDist : 1) * pinch.current.startScale));
      setZoom((z) => ({ ...z, scale, ox: (mid.x / r.width) * 100, oy: (mid.y / r.height) * 100 }));
    } else if (pointers.current.size === 1 && zoom.scale > 1) {
      // Pan while zoomed — delta from the last pointer position.
      const prev = pointers.current.get(e.pointerId)!;
      setZoom((z) => ({
        ...z,
        dx: clamp(z.dx + (e.clientX - prev.x), z.scale),
        dy: clamp(z.dy + (e.clientY - prev.y), z.scale),
      }));
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
  };

  const endPointer = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    // A pinch that relaxed below ~1.1× snaps back out.
    if (pointers.current.size === 0 && zoom.scale > 1 && zoom.scale < 1.1) resetZoom();
  };

  const onShare = async () => {
    const data = { title, url: shareUrl };
    try {
      if (typeof navigator !== "undefined" && navigator.share) {
        await navigator.share(data);
        return;
      }
      await navigator.clipboard.writeText(shareUrl);
      toast.success("Link copied", { description: "Share this product with anyone." });
    } catch {
      /* user dismissed the share sheet — not an error */
    }
  };

  const zoomed = zoom.scale > 1;

  return (
    <div className="space-y-2.5 md:space-y-3">
      <div className="relative aspect-square overflow-hidden bg-muted md:rounded-2xl md:border">
        {/* swipe track */}
        <div
          ref={trackRef}
          onScroll={handleScroll}
          className="absolute inset-0 flex snap-x snap-mandatory overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          role="group"
          aria-label={`${title} — product images, swipe to browse`}
        >
          {slides.map((url, i) => (
            <div
              key={url + i}
              className="relative h-full w-full shrink-0 snap-center overflow-hidden"
              style={{ touchAction: zoomed ? "none" : "pan-x pan-y" }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endPointer}
              onPointerCancel={endPointer}
              onPointerLeave={endPointer}
            >
              <img
                src={url}
                alt={`${title} — image ${i + 1}`}
                loading={i === 0 ? "eager" : "lazy"}
                draggable={false}
                className={cn("h-full w-full select-none object-cover", zoomed ? "cursor-grab active:cursor-grabbing" : "md:cursor-zoom-in")}
                style={{
                  transform: i === active ? `translate(${zoom.dx}px, ${zoom.dy}px) scale(${zoom.scale})` : undefined,
                  transformOrigin: `${zoom.ox}% ${zoom.oy}%`,
                  transition: animating && i === active ? "transform .25s ease-out" : undefined,
                }}
              />
            </div>
          ))}
        </div>

        {/* position indicator — TikTok-style pill */}
        {slides.length > 1 ? (
          <span
            aria-live="polite"
            className="pointer-events-none absolute bottom-3 right-3 rounded-full bg-black/45 px-2.5 py-1 text-[11px] font-bold text-white backdrop-blur-sm"
          >
            {active + 1}/{slides.length}
          </span>
        ) : null}

        {/* top-left badge stack: real discount (coral — promo indicator
            only) + real low-stock urgency (seller's own threshold) */}
        <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-1.5">
          {discountOff != null && discountOff > 0 ? (
            <span className="flex items-baseline gap-0.5 rounded-lg bg-[#FE2C55] px-2 py-1 shadow-md">
              <span className="text-sm font-extrabold leading-none text-white">-{discountOff}%</span>
              <span className="text-[9px] font-bold uppercase tracking-wider text-white/90">off</span>
            </span>
          ) : null}
          {lowStock != null && lowStock > 0 ? (
            <span className="rounded-lg bg-amber-500/95 px-2 py-1 text-[11px] font-bold text-white shadow-md">Only {lowStock} left</span>
          ) : null}
        </div>

        {/* wishlist + share rail */}
        <div className="absolute right-3 top-1/2 flex -translate-y-1/2 flex-col gap-2.5">
          <button
            type="button"
            onClick={onToggleLike}
            aria-pressed={liked}
            aria-label={liked ? "Remove from My Likes" : "Save to My Likes"}
            className="flex h-11 w-11 items-center justify-center rounded-full bg-white/90 shadow-md backdrop-blur-sm transition-transform hover:scale-105 active:scale-95"
          >
            <Heart className={cn("h-5 w-5", liked ? "fill-rose-600 text-rose-600" : "text-neutral-600")} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => void onShare()}
            aria-label="Share this product"
            className="flex h-11 w-11 items-center justify-center rounded-full bg-white/90 shadow-md backdrop-blur-sm transition-transform hover:scale-105 active:scale-95"
          >
            <Share2 className="h-5 w-5 text-neutral-600" aria-hidden="true" />
          </button>
        </div>

        {/* zoom reset affordance while zoomed */}
        {zoomed ? (
          <button
            type="button"
            onClick={resetZoom}
            aria-label="Reset image zoom"
            className="absolute bottom-3 left-3 flex h-9 w-9 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm transition-transform hover:scale-105 active:scale-95"
          >
            <ZoomOut className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {/* thumbnails — desktop/tablet only (mobile swipes + 1/N pill) */}
      {slides.length > 1 ? (
        <div className="hidden gap-2 overflow-x-auto pb-1 md:flex" role="listbox" aria-label="Product images">
          {slides.map((url, i) => (
            <button
              key={url + i}
              type="button"
              role="option"
              aria-selected={i === active}
              aria-label={`Show image ${i + 1}`}
              onClick={() => goTo(i)}
              className={cn(
                "h-16 w-16 shrink-0 overflow-hidden rounded-lg border-2 transition-all",
                i === active ? "border-teal-600" : "border-transparent opacity-70 hover:opacity-100"
              )}
            >
              <img src={url} alt="" loading="lazy" className="h-full w-full object-cover" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Pan clamp — keeps the zoomed image from detaching from the clip window. */
function clamp(v: number, scale: number): number {
  const max = Math.max(0, (scale - 1) * 220);
  return Math.max(-max, Math.min(max, v));
}
