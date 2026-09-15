import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { RecommendCircle } from "../api";
import { circleKey } from "../utils/circleKey";

// Re-armed on every scroll event while active (see the scroll effect
// below) - keeps a programmatic scrollIntoView from being mistaken for
// a hand-dragged scrollbar for its whole duration, however long that
// animation actually takes, and clears shortly after it settles.
const PROGRAMMATIC_SCROLL_SETTLE_MS = 150;
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
  /** Scrollable list element whose sections are being tracked - shared
   * with the rest of the panel (e.g. section-wheel sizing), so it's
   * owned and rendered by the caller rather than created here. */
  listRef: RefObject<HTMLElement>;
  /** Mirrors the active circle up to the parent whenever it changes -
   * drives the big central wheel in App.tsx. Only meaningful on
   * desktop, where that wheel actually exists. */
  onActiveCircleChange?: (circle: RecommendCircle | null) => void;
}

interface UseActiveCircleNavResult {
  activeKey: string | null;
  /** Marks `key` active and scrolls its section into view if it isn't
   * already fully visible - used for click selection as well as
   * keyboard/wheel-tick stepping. */
  activateCircle: (key: string) => void;
  /** Ref callback for each rendered section - registers/unregisters its
   * DOM node under its circle key so activateCircle can scroll to it. */
  registerSectionRef: (key: string, el: HTMLElement | null) => void;
  /** Moves the active circle one step forward/back through the
   * populated list (clamped at either end), scrolling it into view -
   * shared by the arrow-key/wheel-tick handlers below and the panel's
   * own prev/next buttons (see RecommendationsPanel.tsx). */
  stepActive: (direction: 1 | -1) => void;
}

/**
 * Drives the "active" Recommendations circle/section on desktop: which
 * one is currently active (click, arrow keys, wheel-tick, or a
 * hand-dragged scrollbar all update it) and keeping its section
 * scrolled into view. The list itself is a horizontally scrolling strip
 * pinned to the bottom of the viewport (see RecommendationsPanel.tsx /
 * index.css) - "scrolled into view" here means scrolled along that
 * strip's own horizontal axis, not the page.
 *
 * There is no scroll-position tracking that DERIVES the active circle
 * from a "closest to the strip's center" search; instead scrolling
 * always FOLLOWS activeKey via scrollIntoView (activateCircle), and the
 * one case where scroll happens independently of it - the list's own
 * scrollbar dragged by hand, since mouse-wheel/trackpad input over the
 * list is already fully hijacked into the stepper below - steps the
 * active circle to whichever adjacent section just left the visible
 * area (see the scroll effect below), never a list-wide search.
 */
export function useActiveCircleNav({
  populated,
  isNarrow,
  listRef,
  onActiveCircleChange,
}: UseActiveCircleNavOptions): UseActiveCircleNavResult {
  // --- Active circle (desktop only) -------------------------------
  // The active circle is plain state, set explicitly by clicking a
  // section, stepping with the arrow keys, or a wheel tick (see below) -
  // there is no scroll-position tracking; scrolling instead follows the
  // active circle via scrollIntoView.
  // sectionRefs: DOM node for each rendered .rec-circle section, keyed by
  // circleKey (see utils/circleKey.ts) - populated via the ref callback
  // in the desktop render branch below, used to scroll a newly activated
  // section into view.
  const sectionRefs = useRef<Map<string, HTMLElement>>(new Map());
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // Mirrors activeKey for the scroll-walk effect below, so that effect
  // doesn't need activeKey in its dependency array - re-subscribing on
  // every step-by-step update would tear down and recreate its
  // requestAnimationFrame chain mid-walk.
  const activeKeyRef = useRef<string | null>(null);
  useEffect(() => {
    activeKeyRef.current = activeKey;
  }, [activeKey]);
  // Distinguishes a scroll WE just triggered (activateCircle's own
  // scrollIntoView) from one the user just did by hand (dragging the
  // scrollbar thumb - the list's wheel handler above already swallows
  // trackpad/mouse-wheel input into the stepper, so that's the only
  // other way this list's scroll position can change). See
  // armProgrammaticScroll below.
  const programmaticScrollRef = useRef(false);
  const programmaticScrollSettleRef = useRef<number | undefined>(undefined);

  // Marks the list's scroll position as "about to change programmatically"
  // for PROGRAMMATIC_SCROLL_SETTLE_MS - re-armed on every subsequent
  // scroll event while it's still active (see the listener effect
  // below), so it stays set for the whole duration of a smooth
  // scrollIntoView animation and clears shortly after it actually
  // settles, however long that takes.
  const armProgrammaticScroll = useCallback(() => {
    programmaticScrollRef.current = true;
    window.clearTimeout(programmaticScrollSettleRef.current);
    programmaticScrollSettleRef.current = window.setTimeout(() => {
      programmaticScrollRef.current = false;
    }, PROGRAMMATIC_SCROLL_SETTLE_MS);
  }, []);

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
  const activateCircle = useCallback(
    (key: string) => {
      setActiveKey((prev) => (prev === key ? prev : key));
      armProgrammaticScroll();
      sectionRefs.current.get(key)?.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
    },
    [armProgrammaticScroll]
  );

  const registerSectionRef = useCallback((key: string, el: HTMLElement | null) => {
    if (el) sectionRefs.current.set(key, el);
    else sectionRefs.current.delete(key);
  }, []);

  // The list is a horizontally self-scrolling strip (see
  // RecommendationsPanel.tsx / index.css's desktop-only overflow-x:
  // auto override) - dragging its own scrollbar by hand is the one way
  // a section can leave view without going through activateCircle
  // (mouse-wheel/trackpad input over the list is already fully
  // hijacked into the stepper below). When that happens, step the
  // active circle to the section immediately ADJACENT (by list index)
  // to the one that just left the visible area - never a list-wide
  // "closest to the strip's horizontal center" search, which
  // structurally tends to land 2+ sections away from the one that
  // actually left view (individual sections are usually much narrower
  // than the strip, so its center sits far from the edge where the
  // outgoing section just disappeared) and would skip right past a
  // perfectly visible immediate neighbour regardless of how slowly the
  // user scrolls. Ignored while programmaticScrollRef is set (see
  // armProgrammaticScroll) so this never fights activateCircle's own
  // scrollIntoView.
  useEffect(() => {
    if (isNarrow || populated.length <= 1) return;

    const container = listRef.current;
    if (!container) return;

    let scheduled = false;

    const isFullyVisible = (rect: DOMRect, left: number, right: number) =>
+      rect.left >= left && rect.right <= right;

    const recompute = () => {
      scheduled = false;
      if (programmaticScrollRef.current) {
        armProgrammaticScroll();
        return;
      }
      const key = activeKeyRef.current;
      if (!key) return;

      const containerRect = container.getBoundingClientRect();

      let idx = populated.findIndex((c) => circleKey(c) === key);
      if (idx === -1) return;

      // Steps one adjacent index at a time; only loops past 1 step when
      // a single scroll event covered a large distance (e.g. a
      // scrollbar-track click) - for ordinary drag/wheel scrolling this
      // always resolves in exactly one step.
      while (true) {
        const el = sectionRefs.current.get(circleKey(populated[idx]));
        if (!el) break;
        const rect = el.getBoundingClientRect();
        if (isFullyVisible(rect, containerRect.left, containerRect.right)) break;

        let nextIdx = idx;
        if (rect.left < containerRect.left) nextIdx = idx + 1; // scrolled toward later sections
        else if (rect.right > containerRect.right) nextIdx = idx - 1; // scrolled toward earlier sections
        if (nextIdx === idx || nextIdx < 0 || nextIdx >= populated.length) break;
        idx = nextIdx;
      }

      const nextKey = circleKey(populated[idx]);
      if (nextKey !== key) setActiveKey(nextKey);
    };

    const onScroll = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(recompute);
    };

    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      window.clearTimeout(programmaticScrollSettleRef.current);
    };
  }, [isNarrow, populated, armProgrammaticScroll, listRef]);

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

  // Wheel ticks over the list step the active circle instead of freely
  // scrolling it - locked for a short window per step so a single
  // physical notch (or a burst of trackpad delta events from the same
  // gesture) only advances one circle at a time.
  useEffect(() => {
    if (isNarrow || populated.length <= 1) return;
    const el = listRef.current;
    if (!el) return;

    let locked = false;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) < 1) return;
      e.preventDefault();
      if (locked) return;
      locked = true;
      stepActive(e.deltaY > 0 ? 1 : -1);
      window.setTimeout(() => {
        locked = false;
      }, WHEEL_LOCK_MS);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [isNarrow, populated, stepActive, listRef]);

  // Mirror the active circle up to the parent whenever it changes.
  useEffect(() => {
    if (!onActiveCircleChange) return;
    onActiveCircleChange(populated.find((c) => circleKey(c) === activeKey) ?? null);
  }, [activeKey, populated, onActiveCircleChange]);

  return { activeKey, activateCircle, registerSectionRef, stepActive };
}