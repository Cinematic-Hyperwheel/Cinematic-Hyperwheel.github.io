import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { RecommendCircle } from "../api";
import { circleKey } from "../utils/circleKey";

// Locks wheel-tick stepping to one circle per physical notch (or per
// burst of trackpad delta events from the same gesture).
const WHEEL_LOCK_MS = 350;

interface UseActiveCircleNavOptions {
  /** Circles that actually have at least one recommendation (see
   * RecommendationsPanel's `populated`) - the ordered set this hook
   * steps/scrolls through. */
  populated: RecommendCircle[];
  /** Mobile has no notion of an active circle - the hook stays inert
   * (activeKey null, activateCircle/registerSectionRef no-ops) while
   * this is true. */
  isNarrow: boolean;
  /** List element whose sections are being tracked - shared with the
   * rest of the panel (e.g. section-wheel sizing), so it's owned and
   * rendered by the caller rather than created here. The list itself
   * has no scrollbar of its own (see RecommendationsPanel.tsx) - this
   * ref is used for section lookups and, in hero mode, as the wheel-tick
   * listener's target (see `headerCompact` below). */
  listRef: RefObject<HTMLElement>;
  /** Desktop only: whether the app header is currently in compact mode
   * (see useHeaderMode.ts). Determines where the wheel-tick stepper
   * below listens for input: page-wide in compact mode (the pinned
   * main wheel fills most of the viewport, so a tick anywhere should
   * work), scoped to the list element in hero mode. */
  headerCompact: boolean;
  /** Mirrors the active circle up to the parent whenever it changes -
   * drives the big central wheel in App.tsx. Only meaningful on
   * desktop, where that wheel actually exists. */
  onActiveCircleChange?: (circle: RecommendCircle | null) => void;
}

interface UseActiveCircleNavResult {
  activeKey: string | null;
  /** Marks `key` active and scrolls the page so that section's top edge
   * aligns with the sticky header - the same position the main wheel
   * occupies (see sticky-layout.css's .rec-circle scroll-margin-top) -
   * used for click selection as well as keyboard/wheel-tick stepping.
   * Every section, including the very last one, can reach that aligned
   * position - see .rec-panel__list--reserve-align's bottom padding in
   * sticky-layout.css. */
  activateCircle: (key: string) => void;
  /** Ref callback for each rendered section - registers/unregisters its
   * DOM node under its circle key so activateCircle can scroll to it. */
  registerSectionRef: (key: string, el: HTMLElement | null) => void;
  /** Moves the active circle one step forward/back through the
   * populated list (clamped at either end), scrolling it into view -
   * used by the arrow-key/wheel-tick handlers below. */
  stepActive: (direction: 1 | -1) => void;
  /** Ref callback for an empty spacer element rendered as the LAST
   * child of the list (desktop only) - its height is kept in sync,
   * imperatively, with exactly how much extra blank scroll room the
   * page needs so activateCircle/scroll-align can bring the LAST
   * section's top edge flush with the sticky header, even when the
   * page's own natural content wouldn't otherwise scroll that far (see
   * recomputeReserve below). Computed from real measured geometry each
   * time, never a fixed guess - so it's always exactly as large as
   * needed and never lets the page scroll further than that, which
   * would push the last section back off the top of the viewport. */
  spacerRef: (el: HTMLElement | null) => void;
}

/**
 * Drives the "active" Recommendations circle/section on desktop: which
 * one is currently active (click, arrow keys, or a wheel tick - see
 * below) and keeping its section scrolled into view. The list itself
 * has no scrollbar of its own - it's part of the page's normal flow
 * (see RecommendationsPanel.tsx / index.css) - so "scrolled into view"
 * here means scrolling the page itself via scrollIntoView
 * (activateCircle).
 *
 * The active circle is plain state, changed only by explicit input
 * (click, arrow keys, wheel tick) - there is no scroll-position
 * tracking that derives it from "closest to the viewport center" or
 * any similar passive observation of page scroll.
 */
export function useActiveCircleNav({
  populated,
  isNarrow,
  listRef,
  headerCompact,
  onActiveCircleChange,
}: UseActiveCircleNavOptions): UseActiveCircleNavResult {
  // sectionRefs: DOM node for each rendered .rec-circle section, keyed by
  // circleKey (see utils/circleKey.ts) - populated via the ref callback
  // in the desktop render branch below, used to scroll a newly activated
  // section into view.
  const sectionRefs = useRef<Map<string, HTMLElement>>(new Map());
  const [activeKey, setActiveKey] = useState<string | null>(null);
    const spacerElRef = useRef<HTMLElement | null>(null);
  // Mirrors whatever height is currently applied to the spacer, so
  // recomputeReserve can back its own previous contribution out of a
  // fresh scrollHeight measurement and always converge on the true,
  // current deficit rather than compounding an earlier estimate.
  const appliedReserveRef = useRef(0);

  // Same offset `.rec-circle`'s own scroll-margin-top is built from
  // (see sticky-layout.css) - read directly from the CSS custom
  // properties App.tsx keeps in sync, so this always agrees with
  // wherever a section's top edge actually lands once aligned.
  const currentAlignOffset = useCallback((): number => {
    const styles = getComputedStyle(document.documentElement);
    const header = parseFloat(styles.getPropertyValue("--app-header-height")) || 0;
    const controls = parseFloat(styles.getPropertyValue("--app-controls-height")) || 0;
    return header + controls + 12;
  }, []);

  // Recomputes exactly how much blank space (if any) the page needs
  // below the list so the LAST populated section can still reach the
  // aligned position - the section furthest down the page is always
  // the binding case, since every section targets the same fixed
  // on-screen offset. Applied directly to the spacer element's own
  // style (not via React state) so it's visible to the very next
  // synchronous layout read - in particular the scrollIntoView call
  // right after it in the effect below.
  const recomputeReserve = useCallback(() => {
    const spacerEl = spacerElRef.current;
    if (!spacerEl) return;
    if (isNarrow || populated.length === 0) {
      spacerEl.style.height = "0px";
      appliedReserveRef.current = 0;
      return;
    }
    const lastEl = sectionRefs.current.get(circleKey(populated[populated.length - 1]));
    if (!lastEl) return;

    const requiredScrollY = window.scrollY + lastEl.getBoundingClientRect().top - currentAlignOffset();
    // The page's own max scroll WITHOUT the reserve currently applied -
    // subtracting it back out is what makes this self-correcting
    // regardless of what the reserve happened to be before this call.
    const naturalMaxScrollY =
      document.documentElement.scrollHeight - window.innerHeight - appliedReserveRef.current;
    const reserve = Math.max(0, requiredScrollY - naturalMaxScrollY);

    spacerEl.style.height = `${reserve}px`;
    appliedReserveRef.current = reserve;
  }, [isNarrow, populated, currentAlignOffset]);

  // Keeps the reserve correct as anything that can move the last
  // section's position changes: viewport resize, the populated list
  // itself (new reference movie/scheme), or the list's own height (e.g.
  // a "+N more" row expanding/collapsing elsewhere in it).
  useEffect(() => {
    recomputeReserve();
    window.addEventListener("resize", recomputeReserve);

    const listEl = listRef.current;
    let scheduled = false;
    const onListResize = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        recomputeReserve();
      });
    };
    const resizeObserver = listEl ? new ResizeObserver(onListResize) : null;
    if (listEl) resizeObserver?.observe(listEl);

    return () => {
      window.removeEventListener("resize", recomputeReserve);
      resizeObserver?.disconnect();
    };
  }, [recomputeReserve, listRef]);

  // Defaults the active circle to the first one whenever the populated
  // list changes (new reference movie or scheme). useLayoutEffect so
  // this is settled before paint - no one-frame flash of "no circle
  // active".
  useLayoutEffect(() => {
    if (isNarrow || populated.length === 0) {
      setActiveKey(null);
      return;
    }
    setActiveKey(circleKey(populated[0]));
  }, [populated, isNarrow]);

  // Marks `key` active and scrolls its section into view if it isn't
  // already fully visible (e.g. it was scrolled past, or sits further
  // down the list than the current viewport) - covers click selection
  // as well as keyboard/wheel stepping.
  const activateCircle = useCallback((key: string) => {
    setActiveKey((prev) => (prev === key ? prev : key));
    // "start" (not "nearest") always aligns the section's top edge with
    // the sticky header - matching the main wheel's own top edge - so
    // the activated section lands in the same spot every time,
    // regardless of where it was before. See sticky-layout.css for how
    // every section, including the last, is guaranteed enough room
    // below it to actually reach that position.
    sectionRefs.current.get(key)?.scrollIntoView({ inline: "nearest", block: "start", behavior: "smooth" });
  }, []);

  // Header height changes discretely the moment hero<->compact flips
  // (see useHeaderMode.ts / App.tsx) - shifting where "top edge aligned
  // with the sticky header" sits, even though the active section's own
  // on-screen position doesn't move on its own (already handled by
  // useHeaderMode's own spacerHeight compensation). Re-aligns the
  // active section, and refreshes the scroll reserve for the new
  // offset, right after the switch.
  //
  // The switch also kicks off several cascading, differently-timed side
  // effects elsewhere (AppHeader's own ResizeObserver report cycle, the
  // animated max-width transition on .layout3__center in index.css)
  // that keep nudging layout for a little while afterwards. Rather than
  // guessing a fixed delay, this polls the active section's own
  // getBoundingClientRect() across animation frames and only acts once
  // its position has stopped moving for a few consecutive frames - i.e.
  // once layout has actually settled, whatever that took.
  const headerCompactMounted = useRef(false);
  useEffect(() => {
    if (!headerCompactMounted.current) {
      headerCompactMounted.current = true;
      return;
    }
    if (isNarrow || !activeKey) return;

    const STABLE_FRAMES_REQUIRED = 3;
    const MAX_FRAMES = 60; // ~1s safety cap at 60fps, in case something never settles
    let cancelled = false;
    let lastTop: number | null = null;
    let stableCount = 0;
    let frame = 0;

    const check = () => {
      if (cancelled) return;
      const el = sectionRefs.current.get(activeKey);
      if (!el) return;

      const top = el.getBoundingClientRect().top;
      stableCount = lastTop !== null && Math.abs(top - lastTop) < 0.5 ? stableCount + 1 : 0;
      lastTop = top;
      frame += 1;

      if (stableCount >= STABLE_FRAMES_REQUIRED || frame >= MAX_FRAMES) {
        // Reserve is refreshed for the new offset BEFORE scrolling -
        // both are synchronous DOM writes, so the scroll below already
        // sees the up-to-date geometry.
        recomputeReserve();
        el.scrollIntoView({ inline: "nearest", block: "start", behavior: "auto" });
        return;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);

    return () => {
      cancelled = true;
    };
  }, [headerCompact, isNarrow, activeKey, recomputeReserve]);

  const registerSectionRef = useCallback((key: string, el: HTMLElement | null) => {
    if (el) sectionRefs.current.set(key, el);
    else sectionRefs.current.delete(key);
  }, []);

  // Moves the active circle one step forward/back through `populated`
  // (clamped at either end) - shared by the arrow-key and wheel-tick
  // handlers below.
  const stepActive = useCallback(
    (direction: 1 | -1) => {
      if (populated.length === 0) return;
      const currentIndex = populated.findIndex((c) => circleKey(c) === activeKey);
      const nextIndex = Math.min(
        Math.max((currentIndex === -1 ? 0 : currentIndex) + direction, 0),
        populated.length - 1
      );
      activateCircle(circleKey(populated[nextIndex]));
    },
    [populated, activeKey, activateCircle]
  );

  // Up/down arrow keys step the active circle - ignored while a text
  // input/select elsewhere on the page has focus (e.g. the search box),
  // so this never hijacks normal typing.
  useEffect(() => {
    if (isNarrow || populated.length <= 1) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        stepActive(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        stepActive(-1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isNarrow, populated, stepActive]);

  // Wheel ticks step the active circle instead of freely scrolling -
  // locked for a short window per step so a single physical notch (or a
  // burst of trackpad delta events from the same gesture) only advances
  // one circle at a time. In compact header mode the pinned main wheel
  // fills most of the viewport, so the listener is attached to the
  // whole page instead of just the list - a tick anywhere switches the
  // active circle. In hero mode the listener stays scoped to the list
  // element itself.
  useEffect(() => {
    if (isNarrow || populated.length <= 1) return;
    const target: Window | HTMLElement | null = headerCompact ? window : listRef.current;
    if (!target) return;

    let locked = false;
    const onWheel = ((e: WheelEvent) => {
      if (Math.abs(e.deltaY) < 1) return;
      e.preventDefault();
      if (locked) return;
      locked = true;
      stepActive(e.deltaY > 0 ? 1 : -1);
      window.setTimeout(() => {
        locked = false;
      }, WHEEL_LOCK_MS);
    }) as EventListener;
    target.addEventListener("wheel", onWheel, { passive: false });
    return () => target.removeEventListener("wheel", onWheel);
  }, [isNarrow, populated, stepActive, listRef, headerCompact]);

  // Mirror the active circle up to the parent whenever it changes.
  useEffect(() => {
    if (!onActiveCircleChange) return;
    onActiveCircleChange(populated.find((c) => circleKey(c) === activeKey) ?? null);
  }, [activeKey, populated, onActiveCircleChange]);

  return {
    activeKey,
    activateCircle,
    registerSectionRef,
    stepActive,
    spacerRef: useCallback((el: HTMLElement | null) => {
      spacerElRef.current = el;
    }, []),
  };
}