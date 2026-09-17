import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { RecommendCircle } from "../api";
import { circleKey } from "../utils/circleKey";

// Locks wheel-tick stepping to one circle per physical notch (or per
// burst of trackpad delta events from the same gesture).
const WHEEL_LOCK_MS = 350;

// Below this threshold, a freshly computed reserve is treated as
// unchanged and the DOM write is skipped. The spacer element this
// drives is itself the last child of the list the ResizeObserver below
// watches, and document.documentElement.scrollHeight (an integer) vs.
// getBoundingClientRect() (a float) round differently from call to
// call - without this threshold, recomputeReserve would never agree
// with itself closely enough to stop, and each write would just
// re-trigger the observer that calls it again.
const RESERVE_EPSILON_PX = 1;

// How long the scrollspy effect waits after the LAST scroll event
// before treating a scroll as settled and resuming passive tracking - a
// debounce rather than a fixed delay, since a smooth scrollIntoView's
// actual duration depends on distance and isn't known in advance.
const PROGRAMMATIC_SCROLL_SETTLE_MS = 120;

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
   * below listens for input (page-wide in compact mode, scoped to the
   * list element in hero mode), and whether the passive scrollspy
   * effect is active at all (compact mode only - see this hook's own
   * doc comment). */
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
 * one is currently active and keeping its section scrolled into view.
 * The list itself has no scrollbar of its own - it's part of the page's
 * normal flow (see RecommendationsPanel.tsx / index.css) - so "scrolled
 * into view" here means scrolling the page itself via scrollIntoView
 * (activateCircle).
 *
 * The active circle changes through two different paths:
 *
 * - explicit input (click, arrow keys, or a wheel tick - see below):
 *   scrolls the chosen section's top edge to the big wheel's own
 *   aligned position (see currentAlignOffset) - "active changed" drives
 *   a scroll.
 * - passive scrollspy, compact header mode only: whichever section's
 *   top edge has reached that same aligned position during ordinary
 *   page scrolling becomes active, without moving the scroll position
 *   itself - "scrolled" drives "active changed". In compact mode the
 *   wheel-tick stepper above already captures every wheel/trackpad
 *   scroll gesture as a discrete step (see its own preventDefault), so
 *   this only ever observes genuine scrolling that bypassed it -
 *   scrollbar dragging, Page Up/Down, Home/End. Hero mode has no
 *   equivalent of this: the big wheel isn't pinned to a fixed on-screen
 *   slot there, so there's no single position to spy against.
 *
 * These two paths are mirror images of each other and would fight
 * indefinitely if left unguarded (a scrollIntoView triggered by the
 * first path would immediately be reinterpreted as user scrolling by
 * the second, and vice versa). suppressScrollSpyRef/
 * beginProgrammaticScroll below shield every scroll this hook itself
 * triggers from being picked up by the scrollspy effect: the effect
 * ignores scroll events while the flag is set, and the flag only clears
 * once scrolling has been quiet for PROGRAMMATIC_SCROLL_SETTLE_MS -
 * i.e. once the triggered scroll has actually finished, whatever that
 * took.
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

  // See this hook's own doc comment above for what this guards against.
  // Set for the duration of any scroll THIS hook triggers; the
  // scrollspy effect below no-ops while it's true, and re-arms the
  // settle timer on every scroll event it sees instead of reacting to
  // it, so a smooth scrollIntoView's whole motion (many scroll events)
  // stays suppressed until it actually stops.
  const suppressScrollSpyRef = useRef(false);
  const scrollSettleTimerRef = useRef<number | undefined>(undefined);

  const beginProgrammaticScroll = useCallback(() => {
    suppressScrollSpyRef.current = true;
    window.clearTimeout(scrollSettleTimerRef.current);
    scrollSettleTimerRef.current = window.setTimeout(() => {
      suppressScrollSpyRef.current = false;
    }, PROGRAMMATIC_SCROLL_SETTLE_MS);
  }, []);

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
      if (appliedReserveRef.current !== 0) {
        spacerEl.style.height = "0px";
        appliedReserveRef.current = 0;
      }
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
 
    // Treat a sub-pixel-scale difference from what's already applied as
    // converged - see RESERVE_EPSILON_PX above for why this is what
    // actually breaks the write -> ResizeObserver -> write cycle,
    // rather than just reducing its amplitude.
    if (Math.abs(reserve - appliedReserveRef.current) < RESERVE_EPSILON_PX) return;

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
    // Shields the scroll about to start from the scrollspy effect below
    // - see this hook's own doc comment.
    beginProgrammaticScroll();
    // "start" (not "nearest") always aligns the section's top edge with
    // the sticky header - matching the main wheel's own top edge - so
    // the activated section lands in the same spot every time,
    // regardless of where it was before. See sticky-layout.css for how
    // every section, including the last, is guaranteed enough room
    // below it to actually reach that position.
    sectionRefs.current.get(key)?.scrollIntoView({ inline: "nearest", block: "start", behavior: "smooth" });
  }, [beginProgrammaticScroll]);

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
        // This is a scroll THIS hook is causing, not the user - shield
        // it from the scrollspy effect below the same way activateCircle
        // does, so re-aligning after a header-mode switch never gets
        // read back as "the user scrolled to a different section".
        beginProgrammaticScroll();
        el.scrollIntoView({ inline: "nearest", block: "start", behavior: "auto" });
        return;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);

    return () => {
      cancelled = true;
    };
  }, [headerCompact, isNarrow, activeKey, recomputeReserve, beginProgrammaticScroll]);

  // The section whose top edge has reached the same aligned position
  // activateCircle scrolls TO (see currentAlignOffset) - the last
  // section, in document order, whose top is still at or above that
  // line. Sections are laid out in the same order as `populated`, so a
  // single forward scan that stops at the first one still below the
  // line is enough.
  const sectionAtAlignOffset = useCallback((): string | null => {
    if (populated.length === 0) return null;
    const offset = currentAlignOffset();
    let candidate: string | null = null;
    for (const circle of populated) {
      const key = circleKey(circle);
      const top = sectionRefs.current.get(key)?.getBoundingClientRect().top;
      if (top === undefined) continue;
      if (top > offset) break;
      candidate = key;
    }
    // Above the very first section (e.g. scrolled all the way back to
    // the top of the page) - falls back to it rather than leaving
    // nothing active.
    return candidate ?? circleKey(populated[0]);
  }, [populated, currentAlignOffset]);

  // Passive scrollspy - compact header mode only (see this hook's own
  // doc comment for why hero mode has no equivalent). rAF-throttled
  // like the other scroll-driven effects in this codebase (see
  // App.tsx's wheel-sizing effect). Every scroll event first checks
  // suppressScrollSpyRef: while a scroll THIS hook triggered is still
  // settling, events only extend that settle window instead of being
  // treated as user scrolling - see beginProgrammaticScroll above.
  useEffect(() => {
    if (isNarrow || !headerCompact || populated.length === 0) return;

    let scheduled = false;
    const onScroll = () => {
      if (suppressScrollSpyRef.current) {
        window.clearTimeout(scrollSettleTimerRef.current);
        scrollSettleTimerRef.current = window.setTimeout(() => {
          suppressScrollSpyRef.current = false;
        }, PROGRAMMATIC_SCROLL_SETTLE_MS);
        return;
      }
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        // A programmatic scroll (e.g. a click that landed while this
        // frame was pending) may have started after onScroll fired but
        // before this callback ran - re-check right before acting.
        if (suppressScrollSpyRef.current) return;
        const key = sectionAtAlignOffset();
        setActiveKey((prev) => (prev === key ? prev : key));
      });
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [isNarrow, headerCompact, populated, sectionAtAlignOffset]);

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