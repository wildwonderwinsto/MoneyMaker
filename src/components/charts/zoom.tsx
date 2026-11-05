"use client";

/**
 * Horizontal zoom + pan for charts, shared by every time-series chart.
 * - Mouse: wheel zooms around the cursor, drag moves when zoomed, double-click resets.
 *   Trackpad: pinch zooms (it arrives as ctrl+wheel), two-finger sideways swipe moves.
 * - Touch: pinch zooms around the fingers, moving both fingers pans, double-tap resets.
 *   One finger still scrubs the tooltip and vertical swipes still scroll the page
 *   (touch-action: pan-y).
 * - Buttons (+ / − / reset) for keyboards and anyone who prefers them.
 * When fully zoomed out, scrolling down passes through to the page so the chart never
 * traps the scroll wheel.
 */
import { cn } from "cn";
import { Minus, Plus, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

export interface ZoomWindow {
  lo: number;
  hi: number;
}

export interface ZoomBounds {
  min: number;
  max: number;
  /** Narrowest window allowed, in the same units as min/max. */
  minSpan: number;
}

/** A window width kept between the minimum span and the full range. */
export function spanWithin(span: number, b: ZoomBounds): number {
  const full = Math.max(0, b.max - b.min);
  return Math.min(full, Math.max(Math.min(b.minSpan, full), span));
}

/** Slide a window back inside the bounds (and clamp its width). */
export function clampWindow(w: ZoomWindow, b: ZoomBounds): ZoomWindow {
  const span = spanWithin(w.hi - w.lo, b);
  const lo = Math.min(Math.max(w.lo, b.min), b.max - span);
  return { lo, hi: lo + span };
}

/** Scale the window by `factor` (< 1 zooms in), keeping the value at `anchor` (0..1) still. */
export function zoomAt(w: ZoomWindow, factor: number, anchor: number, b: ZoomBounds): ZoomWindow {
  const a = Math.min(1, Math.max(0, anchor));
  const x = w.lo + a * (w.hi - w.lo);
  const span = spanWithin((w.hi - w.lo) * factor, b);
  return clampWindow({ lo: x - a * span, hi: x - a * span + span }, b);
}

/** Move the window by `delta` window-widths (positive = later). */
export function panBy(w: ZoomWindow, delta: number, b: ZoomBounds): ZoomWindow {
  const d = delta * (w.hi - w.lo);
  return clampWindow({ lo: w.lo + d, hi: w.hi + d }, b);
}

export const isFullWindow = (w: ZoomWindow, b: ZoomBounds) =>
  w.hi - w.lo >= (b.max - b.min) * 0.999;

type Inset = { left: number; right: number };

export interface ChartZoom {
  lo: number;
  hi: number;
  zoomed: boolean;
  canZoomIn: boolean;
  dragging: boolean;
  /** Width of the wrapped element in px (0 before the first measure). */
  width: number;
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
}

/** `ref` must be attached to the element that wraps the plot. */
export function useChartZoom(
  ref: React.RefObject<HTMLDivElement | null>,
  {
    min,
    max,
    minSpan,
    inset,
  }: {
    min: number;
    max: number;
    minSpan: number;
    /**
     * Pixels between the wrapper's edges and the plot area (y-axis width + margins), or a
     * function of the wrapper's width when the margins change with it.
     */
    inset: Inset | ((width: number) => Inset);
  },
): ChartZoom {
  const [stored, setStored] = useState<ZoomWindow | null>(null);
  const [dragging, setDragging] = useState(false);
  const [width, setWidth] = useState(0);

  const bounds = useMemo(() => ({ min, max, minSpan }), [min, max, minSpan]);
  // Data refreshes move the bounds; keep the user's window, just slid back inside.
  const win = useMemo(
    () => (stored ? clampWindow(stored, bounds) : { lo: min, hi: max }),
    [stored, bounds, min, max],
  );
  const zoomed = max > min && !isFullWindow(win, bounds);
  const canZoomIn = max > min && win.hi - win.lo > spanWithin(0, bounds) * 1.001;

  // Latest values for the native event handlers (registered once).
  const live = useRef({ win, bounds, inset });
  useLayoutEffect(() => {
    live.current = { win, bounds, inset };
  });

  const pending = useRef<ZoomWindow | null>(null);
  const frame = useRef(0);
  const current = useCallback(() => pending.current ?? live.current.win, []);
  /** Coalesce rapid wheel/pointer updates into one render per frame. */
  const commit = useCallback((next: ZoomWindow) => {
    pending.current = next;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const p = pending.current;
      pending.current = null;
      if (p) setStored(isFullWindow(p, live.current.bounds) ? null : p);
    });
  }, []);

  const reset = useCallback(() => {
    pending.current = null;
    setStored(null);
  }, []);
  const zoomIn = useCallback(
    () => commit(zoomAt(current(), 0.5, 0.5, live.current.bounds)),
    [commit, current],
  );
  const zoomOut = useCallback(
    () => commit(zoomAt(current(), 2, 0.5, live.current.bounds)),
    [commit, current],
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const plot = () => {
      const r = el.getBoundingClientRect();
      const inset = live.current.inset;
      const { left, right } = typeof inset === "function" ? inset(r.width) : inset;
      return { x0: r.left + left, w: Math.max(1, r.width - left - right) };
    };
    const frac = (clientX: number) => {
      const p = plot();
      return (clientX - p.x0) / p.w;
    };

    const onWheel = (e: WheelEvent) => {
      const b = live.current.bounds;
      if (!(b.max > b.min)) return;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const dx = e.deltaX * unit;
      const dy = e.deltaY * unit;
      const w = current();
      const full = isFullWindow(w, b);
      if (Math.abs(dx) > Math.abs(dy)) {
        if (full) return;
        e.preventDefault();
        commit(panBy(w, dx / plot().w, b));
        return;
      }
      if (dy === 0 || (dy > 0 && full)) return; // fully zoomed out: let the page scroll
      const next = zoomAt(w, Math.exp(dy * (e.ctrlKey ? 0.01 : 0.0015)), frac(e.clientX), b);
      if (next.lo === w.lo && next.hi === w.hi) return; // at the limit: let the page scroll
      e.preventDefault();
      commit(next);
    };

    // Mouse drag (pan) and touch pinch (zoom + pan around the fingers' midpoint).
    const touches = new Map<number, { x: number; y: number }>();
    let drag: { x: number; w: ZoomWindow } | null = null;
    let pinch: { d: number; x: number; span: number } | null = null;
    const startPinch = () => {
      const pts = [...touches.values()];
      if (pts.length !== 2) {
        pinch = null;
        return;
      }
      const w = current();
      const f = frac((pts[0].x + pts[1].x) / 2);
      pinch = {
        d: Math.max(10, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)),
        x: w.lo + f * (w.hi - w.lo),
        span: w.hi - w.lo,
      };
    };

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse") {
        if (e.button !== 0 || isFullWindow(current(), live.current.bounds)) return;
        e.preventDefault(); // no text selection while dragging
        drag = { x: e.clientX, w: current() };
        setDragging(true);
        return;
      }
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      startPinch();
    };
    const onMove = (e: PointerEvent) => {
      const b = live.current.bounds;
      if (drag && e.pointerType === "mouse") {
        commit(panBy(drag.w, -(e.clientX - drag.x) / plot().w, b));
        return;
      }
      if (!touches.has(e.pointerId)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!pinch || touches.size !== 2) return;
      const [p1, p2] = [...touches.values()];
      const d = Math.max(10, Math.hypot(p1.x - p2.x, p1.y - p2.y));
      const span = spanWithin(pinch.span * (pinch.d / d), b);
      const lo = pinch.x - frac((p1.x + p2.x) / 2) * span;
      commit(clampWindow({ lo, hi: lo + span }, b));
    };
    const onUp = (e: PointerEvent) => {
      if (drag && e.pointerType === "mouse") {
        drag = null;
        setDragging(false);
      }
      if (touches.delete(e.pointerId)) startPinch();
    };
    // Safari: stop the page itself from pinch-zooming while fingers are on the chart.
    const onGesture = (e: Event) => e.preventDefault();

    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("dblclick", reset);
    el.addEventListener("gesturestart", onGesture);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("dblclick", reset);
      el.removeEventListener("gesturestart", onGesture);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [ref, commit, current, reset]);

  return {
    lo: win.lo,
    hi: win.hi,
    zoomed,
    canZoomIn,
    dragging,
    width,
    zoomIn,
    zoomOut,
    reset,
  };
}

/** Classes for the element the zoom ref is attached to. */
export const zoomSurface = (zoom: ChartZoom) =>
  cn("touch-pan-y select-none", zoom.zoomed && (zoom.dragging ? "cursor-grabbing" : "cursor-grab"));

function ZoomButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="text-muted-foreground hover:text-foreground hover:bg-card flex size-8 items-center justify-center rounded transition-colors disabled:pointer-events-none disabled:opacity-40 sm:size-6"
    >
      {children}
    </button>
  );
}

export function ZoomControls({ zoom }: { zoom: ChartZoom }) {
  return (
    <div className="bg-muted flex gap-0.5 rounded-md p-0.5" role="group" aria-label="Zoom">
      <ZoomButton label="Zoom out" onClick={zoom.zoomOut} disabled={!zoom.zoomed}>
        <Minus className="size-3.5" aria-hidden />
      </ZoomButton>
      <ZoomButton label="Zoom in" onClick={zoom.zoomIn} disabled={!zoom.canZoomIn}>
        <Plus className="size-3.5" aria-hidden />
      </ZoomButton>
      <ZoomButton label="Reset zoom" onClick={zoom.reset} disabled={!zoom.zoomed}>
        <RotateCcw className="size-3.5" aria-hidden />
      </ZoomButton>
    </div>
  );
}

/** One-line hint matched to the input device. */
export function ZoomHint() {
  return (
    <p className="text-muted-foreground mt-1 text-right text-[11px]">
      <span className="pointer-coarse:hidden">
        Scroll to zoom · drag to move · double-click to reset
      </span>
      <span className="hidden pointer-coarse:inline">
        Pinch to zoom · move two fingers to pan · double-tap to reset
      </span>
    </p>
  );
}
