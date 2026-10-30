"use client";

// ---------------------------------------------------------------------------
// TourGuide — reusable in-page coach-mark tour ("documentation overlay").
//
// Renders a dimmed full-screen overlay with a spotlight cut-out around the
// current step's target element (matched via a `data-tour="<id>"` attribute)
// and a popover that explains the feature in detail. The seller steps through
// with Next / Back, can Skip (✕ / Esc / clicking the dim area), and the last
// step finishes the tour.
//
// Design notes:
//   • Targets are plain `data-tour` attributes on existing elements — no
//     ref plumbing. A step without a `target` renders centred (intro/outro).
//   • Each step optionally runs `onEnter` when it becomes active — used by the
//     Campaigns page to expand the create-form and the methodology notes so
//     the tour can point at them.
//   • The step's target is scrolled into view (centred) and re-measured on
//     viewport resize/scroll, so the spotlight follows the page. If a target
//     is not in the DOM after settling (conditional sections), the tour skips
//     forward automatically instead of pointing at nothing.
//   • Keyboard: Esc closes, ← back, → next. Focus lands on the Next button
//     each step, so Enter/Space also advance.
//   • Overlay stacking (z 95/96/97) sits above the portal switcher (z 90) so
//     the whole page is evenly dimmed and non-clickable during the tour.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type TourStep = {
  /** `data-tour` attribute value of the element to spotlight. Omit for a centred, no-target step (intro/outro). */
  target?: string;
  title: string;
  body: ReactNode;
  /** Runs when the step becomes active (e.g. expand a collapsed form so it can be pointed at). */
  onEnter?: () => void;
};

const PAD = 6;
const POPOVER_W = 352;
/** Estimated popover height used for above/below placement decisions. */
const POPOVER_MIN_H = 232;
/** ms to wait for smooth-scroll + conditional mounts before re-measuring. */
const SETTLE_MS = 440;

export function TourGuide({
  steps,
  open,
  onClose,
}: {
  steps: TourStep[];
  open: boolean;
  /** completed=true when the last step's Finish was clicked; false when skipped/closed early. */
  onClose: (completed: boolean) => void;
}) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [vp, setVp] = useState({ w: 0, h: 0 });
  const nextRef = useRef<HTMLButtonElement | null>(null);

  const step = steps[index];
  const last = index >= steps.length - 1;

  // Reset to the first step whenever the tour is (re)opened.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time reset when the tour opens
    if (open) setIndex(0);
  }, [open]);

  const advance = useCallback(() => {
    if (last) onClose(true);
    else setIndex((i) => i + 1);
  }, [last, onClose]);

  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  // Measure the active target: scroll it into view, re-measure now / next
  // frame / after the scroll settles, and keep tracking resize + scroll.
  useLayoutEffect(() => {
    if (!open || !step) return;
    step.onEnter?.();
    const sel = step.target ? `[data-tour="${step.target}"]` : null;

    const measure = () => {
      const el = sel ? document.querySelector<HTMLElement>(sel) : null;
      setRect(el ? el.getBoundingClientRect() : null);
      setVp({ w: window.innerWidth, h: window.innerHeight });
    };

    const el = sel ? document.querySelector<HTMLElement>(sel) : null;
    el?.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    const raf = requestAnimationFrame(measure);
    // After settling: re-measure, and skip forward if the target never
    // appeared (conditional section that isn't rendered right now).
    const t = window.setTimeout(() => {
      const now = sel ? document.querySelector<HTMLElement>(sel) : null;
      if (sel && !now && index < steps.length - 1) {
        setIndex((i) => i + 1);
        return;
      }
      measure();
    }, SETTLE_MS);

    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
    // `steps` is memoised by the caller; `step` identity follows index.
  }, [open, index, steps, step]);

  // Keyboard navigation + focus management.
  useEffect(() => {
    if (!open) return;
    nextRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose(false);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        advance();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        back();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, advance, back, onClose, index]);

  if (!open || !step) return null;

  const w = Math.min(POPOVER_W, Math.max(280, vp.w - 24));

  // --- popover placement ---------------------------------------------------
  let popStyle: CSSProperties = {};
  let sheet = false; // narrow screens with no room above/below → bottom sheet
  if (!rect) {
    popStyle = { left: "50%", top: "50%", transform: "translate(-50%, -50%)", width: w };
  } else {
    const left = Math.min(Math.max(12, rect.left + rect.width / 2 - w / 2), Math.max(12, vp.w - w - 12));
    const spaceBelow = vp.h - rect.bottom;
    if (spaceBelow >= POPOVER_MIN_H + 20) popStyle = { left, top: rect.bottom + 14, width: w };
    else if (rect.top >= POPOVER_MIN_H + 20) popStyle = { left, bottom: vp.h - rect.top + 14, width: w };
    else sheet = true;
  }

  // --- spotlight rect (padded) ----------------------------------------------
  const spot = rect
    ? {
        left: rect.left - PAD,
        top: rect.top - PAD,
        width: rect.width + 2 * PAD,
        height: rect.height + 2 * PAD,
      }
    : null;

  return (
    <>
      {/* click-catcher; dims the page only for centred (no-target) steps —
          otherwise the spotlight's 9999px box-shadow is the dim layer, which
          leaves the target itself bright and legible. */}
      <div
        aria-hidden="true"
        onClick={() => onClose(false)}
        className={cn("fixed inset-0 z-[95]", !rect && "bg-slate-950/60")}
      />

      {spot ? (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed z-[96] rounded-lg ring-2 ring-primary/80 shadow-[0_0_0_9999px_rgba(2,6,23,0.62)] transition-[top,left,width,height] duration-300 ease-out"
          style={spot}
        />
      ) : null}

      {/* popover */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={step.title}
        className={cn(
          "fixed z-[97] rounded-xl border bg-popover p-4 text-popover-foreground shadow-xl outline-none",
          sheet ? "bottom-3 left-3 right-3" : "max-h-[calc(100vh-32px)]"
        )}
        style={popStyle}
      >
        <div className="flex items-start justify-between gap-3">
          <p className="min-w-0 text-sm font-semibold leading-snug">{step.title}</p>
          <button
            type="button"
            onClick={() => onClose(false)}
            aria-label="Skip guide"
            className="-m-1 shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>

        <div className="mt-2 max-h-[38vh] overflow-y-auto pr-0.5 text-xs leading-relaxed text-muted-foreground [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border">
          {step.body}
        </div>

        <div className="mt-3 flex items-center justify-between gap-2 border-t pt-3">
          <span className="shrink-0 text-[10px] font-medium tabular-nums text-muted-foreground">
            Step {index + 1} of {steps.length}
          </span>
          <div className="flex items-center gap-1.5">
            {index > 0 ? (
              <Button variant="outline" size="sm" className="h-8 gap-1 px-2.5 text-xs" onClick={back}>
                <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" /> Back
              </Button>
            ) : null}
            <Button size="sm" ref={nextRef} className="h-8 gap-1 px-3 text-xs" onClick={advance}>
              {last ? (
                <>
                  Finish <Check className="h-3.5 w-3.5" aria-hidden="true" />
                </>
              ) : (
                <>
                  Next <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
