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
  /** Marks `key` active and scrolls its section into view if it isn't
   * already fully visible - used for click selection as well as
   * keyboard/wheel-tick stepping. */
  activateCircle: (key: string) => void;
  /** Ref callback for each rendered section - registers/unregisters its
   * DOM node under its circle key so activateCircle can scroll to it. */
  registerSectionRef: (key: string, el: HTMLElement | null) => void;
  /** Moves the active circle one step forward/back through the
   * populated list (clamped at either end), scrolling it into view -
   * used by the arrow-key/wheel-tick handlers below. */
  stepActive: (direction: 1 | -1) => void;
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
    sectionRefs.current.get(key)?.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
  }, []);

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

  return { activeKey, activateCircle, registerSectionRef, stepActive };
}