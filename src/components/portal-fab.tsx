"use client";
// NOMOFEE portal switcher — a single draggable floating action button (FAB).
// • Tap the FAB to expand the Market / Seller / Admin switcher.
// • Drag it anywhere on screen (touch + mouse) so it never blocks bottom UI.
// • Position persists across reloads (localStorage, with sandbox-safe try/catch).
//
// The position lives in a tiny module-level external store read via
// useSyncExternalStore: server snapshot = null (render nothing during SSR),
// client snapshot lazily initialises from localStorage/window on first read.
// This avoids both hydration mismatches and set-state-in-effect cascades.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Store, ShoppingBag, ShieldCheck, Layers, X, LocateFixed } from "lucide-react";
import { useApp } from "@/lib/app-store";
import { cn } from "@/lib/utils";

const SURFACES: { key: "shopper" | "seller" | "admin"; label: string; icon: typeof Store }[] = [
  { key: "shopper", label: "Market", icon: ShoppingBag },
  { key: "seller", label: "Seller", icon: Store },
  { key: "admin", label: "Admin", icon: ShieldCheck },
];

const FAB = 48; // button size in px
const MARGIN = 10; // min distance from viewport edge
const GAP = 10; // gap between FAB and expanded menu
const POS_KEY = "sm_portal_fab_pos";
const TAP_THRESHOLD = 7; // px of movement before it counts as a drag

interface Pos {
  x: number;
  y: number;
}

function clampPos(x: number, y: number): Pos {
  const maxX = Math.max(MARGIN, window.innerWidth - FAB - MARGIN);
  const maxY = Math.max(MARGIN, window.innerHeight - FAB - MARGIN);
  return { x: Math.min(Math.max(MARGIN, x), maxX), y: Math.min(Math.max(MARGIN, y), maxY) };
}

function defaultPos(): Pos {
  // Bottom-right corner. On small viewports it sits ABOVE the app-like bottom
  // navigation bar (64px + safe area) so it never covers the Me / Chat items.
  const bottomOffset = window.innerWidth < 768 ? 76 : 18;
  return clampPos(window.innerWidth - FAB - 18, window.innerHeight - FAB - bottomOffset);
}

// --- tiny external store for the FAB position --------------------------------

let fabPos: Pos | null = null;
const fabListeners = new Set<() => void>();

function setFabPos(p: Pos) {
  fabPos = p;
  fabListeners.forEach((l) => l());
}

function subscribeFab(cb: () => void) {
  fabListeners.add(cb);
  return () => {
    fabListeners.delete(cb);
  };
}

function getFabSnapshot(): Pos | null {
  // lazily hydrate on first client read (never runs during SSR)
  if (fabPos === null && typeof window !== "undefined") {
    try {
      const raw = localStorage.getItem(POS_KEY);
      const p = raw ? (JSON.parse(raw) as Partial<Pos>) : null;
      fabPos = p && typeof p.x === "number" && typeof p.y === "number" ? clampPos(p.x, p.y) : defaultPos();
    } catch {
      fabPos = defaultPos(); // storage may be unavailable in sandboxed iframes
    }
  }
  return fabPos;
}

function saveFabPos(p: Pos) {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

// -----------------------------------------------------------------------------

export default function PortalFab() {
  const surface = useApp((s) => s.surface);
  const setSurface = useApp((s) => s.setSurface);
  const pos = useSyncExternalStore(subscribeFab, getFabSnapshot, () => null);
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);

  // keep the FAB inside the viewport when the window is resized
  useEffect(() => {
    const onResize = () => {
      const p = getFabSnapshot();
      if (p) setFabPos(clampPos(p.x, p.y));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const p = getFabSnapshot();
    if (!p) return;
    // capture the pointer so fast drags outside the button still track
    // (defensive: a throw here would abort the tap-to-open flow entirely)
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      /* pointer already released or not capturable — drag still works while
         the pointer stays over the button, and taps are unaffected */
    }
    drag.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, originX: p.x, originY: p.y, moved: false };
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) > TAP_THRESHOLD) {
      d.moved = true;
      setDragging(true);
      setOpen(false);
    }
    if (d.moved) {
      e.preventDefault();
      setFabPos(clampPos(d.originX + dx, d.originY + dy));
    }
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (d.moved) {
      const p = getFabSnapshot();
      if (p) saveFabPos(p);
    } else {
      setOpen((o) => !o); // clean tap → toggle the switcher menu
    }
  }, []);

  const onPointerCancel = useCallback(() => {
    drag.current = null;
    setDragging(false);
  }, []);

  const pick = (key: "shopper" | "seller" | "admin") => {
    setSurface(key);
    setOpen(false);
  };

  const resetPosition = () => {
    const p = defaultPos();
    setFabPos(p);
    saveFabPos(p);
    setOpen(false);
  };

  if (!pos) return null; // SSR snapshot — render nothing, no hydration mismatch

  // menu opens toward the centre of the screen so it never clips off-viewport
  const openUp = pos.y + FAB / 2 > window.innerHeight / 2;
  const alignRight = pos.x + FAB / 2 > window.innerWidth / 2;

  const menuStyle: React.CSSProperties = alignRight
    ? { right: window.innerWidth - pos.x - FAB }
    : { left: pos.x };
  if (openUp) menuStyle.bottom = window.innerHeight - pos.y + GAP;
  else menuStyle.top = pos.y + FAB + GAP;

  return (
    <div className="print:hidden" style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 90 }}>
      {/* click-away layer while the menu is open */}
      {open ? (
        <div
          aria-hidden
          onPointerDown={() => setOpen(false)}
          style={{ position: "fixed", inset: 0, pointerEvents: "auto" }}
          className="bg-foreground/5 transition-opacity animate-in fade-in duration-150"
        />
      ) : null}

      {open ? (
        <div
          role="menu"
          aria-label="Switch portal"
          className="fixed flex flex-col items-stretch gap-1.5 p-1.5 rounded-2xl border bg-background/95 shadow-xl backdrop-blur animate-in fade-in zoom-in-95 duration-150"
          style={{ ...menuStyle, pointerEvents: "auto" }}
        >
          {SURFACES.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              role="menuitemradio"
              aria-checked={surface === key}
              onClick={() => pick(key)}
              className={cn(
                "flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold transition-colors min-h-[36px] text-left",
                surface === key
                  ? "bg-primary text-primary-foreground shadow"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
              {surface === key ? <span className="ml-auto h-1.5 w-1.5 rounded-full bg-current" aria-hidden /> : null}
            </button>
          ))}
          <div className="h-px bg-border mx-1" aria-hidden />
          <button
            onClick={resetPosition}
            className="flex items-center gap-2 rounded-xl px-3 py-2 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors min-h-[32px] text-left"
          >
            <LocateFixed className="h-3.5 w-3.5 shrink-0" />
            Reset position
          </button>
        </div>
      ) : null}

      <button
        type="button"
        aria-label={open ? "Close portal switcher" : "Open portal switcher — tap to switch, drag to move"}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Tap: switch portal · Drag: move me anywhere"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        className={cn(
          "fixed flex items-center justify-center rounded-full shadow-lg border border-white/40 text-white select-none",
          "bg-brand-gradient-deep hover:shadow-xl transition-shadow",
          "touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          dragging ? "cursor-grabbing scale-105 shadow-2xl" : "cursor-grab hover:scale-105",
          "transition-transform animate-in fade-in zoom-in duration-200"
        )}
        style={{ left: pos.x, top: pos.y, width: FAB, height: FAB, pointerEvents: "auto" }}
      >
        {open ? <X className="h-5 w-5" /> : <Layers className="h-5 w-5" />}
        {/* active-portal dot indicator */}
        {!open ? <span className="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-background bg-emerald-500" aria-hidden /> : null}
      </button>
    </div>
  );
}
