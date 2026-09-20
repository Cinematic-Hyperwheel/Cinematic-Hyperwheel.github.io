import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { RecItem } from "../api";

/**
 * Which UI surface triggered the recommendation info card - each source
 * anchors and positions the card differently (see
 * components/RecommendationInfoCard.tsx / ActiveRecommendationCard.tsx):
 * "legend" is a row in the big wheel's legend, "list" is a row in the
 * Recommendations panel's list, "point" is a point marker on a wheel
 * (big or small) itself.
 */
export type CardSource = "legend" | "list" | "point";

export interface CardTrigger {
  /** Unique id for this exact hover target (circle + source + item) -
   * lets showCard/hideCard/closeCardNow tell "same target" apart from
   * "a different target should replace it", the same pairing pattern
   * HighlightContext uses for (circleKey, itemId). */
  key: string;
  item: RecItem;
  source: CardSource;
  /** Bounding rect of the hovered/tapped element itself (a legend row,
   * a recommendations list row, or a wheel point) - the card's anchor. */
  rect: DOMRect;
  /** Bounding rect of the big (primary) wheel's own point for this
   * item, when one is currently rendered there - kept clear of the card
   * (see RecommendationInfoCard's avoidOverlap). Only ever set for
   * "legend"/"list" sources; a "point" trigger is already anchored to
   * the point itself, so it needs no separate avoidance target. */
  avoidRect?: DOMRect;
  /** Ordered list of items this trigger belongs to, used by the mobile
   * popup's prev/next buttons (see RecommendationInfoCard.tsx). Only
   * populated by RecommendationsPanel's mobile list rows; other sources
   * (legend, wheel point) leave it undefined, which just hides the
   * buttons. */
  list?: RecItem[];
  /** Rendering style for the card. "tile" pins the card exactly over
   * the trigger's own rect (so a poster-sized rect keeps the poster in
   * place) and grows a compact info panel out of it instead of
   * floating a full popover beside it - used by the big wheel legend's
   * grid layout, where tiles sit edge-to-edge and a regular popover
   * would cover neighboring tiles. Defaults to the regular anchored
   * popover when omitted. */
  cardStyle?: "popover" | "tile";
  /** Swatch color and angle-badge text this tile was drawn with (see
   * WheelStack.tsx's LegendTile) - only used in "tile" mode, to redraw
   * the same badge/scrim look on the floating card so it reads as the
   * tile itself, not a different-looking card replacing it. */
  tileSwatch?: string;
  tileAngleLabel?: string;
}

interface ActiveCardContextValue {
  /** The single card currently shown across the whole app, or null. */
  trigger: CardTrigger | null;
  /** Opens (or replaces) the active card immediately, canceling any
   * pending close - a genuine hover-enter or tap always wins over a
   * previous target's fading-out close timer. */
  showCard: (trigger: CardTrigger) => void;
  /** Requests closing the card identified by `key`, after a short delay
   * that lets the pointer travel onto the card itself (which lives
   * elsewhere in the DOM via a portal) without it flickering shut in
   * between - a no-op if a different target is now active. */
  hideCard: (key: string) => void;
  /** Closes the card identified by `key` immediately, no delay - used
   * by explicit close actions (the card's own close button,
   * click-to-toggle, Escape, window resize, list scroll). */
  closeCardNow: (key: string) => void;
  /** Closes whatever card is currently open, regardless of its key -
   * used when the underlying data it points at is about to be replaced
   * wholesale (a new reference movie or scheme selection). */
  clearCard: () => void;
}

const ActiveCardContext = createContext<ActiveCardContextValue | null>(null);

const HIDE_DELAY_MS = 200;

export function ActiveCardProvider({ children }: { children: ReactNode }) {
  const [trigger, setTrigger] = useState<CardTrigger | null>(null);
  const hideTimerRef = useRef<number | undefined>(undefined);

  const showCard = useCallback((next: CardTrigger) => {
    window.clearTimeout(hideTimerRef.current);
    setTrigger(next);
  }, []);

  const hideCard = useCallback((key: string) => {
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => {
      setTrigger((prev) => (prev && prev.key === key ? null : prev));
    }, HIDE_DELAY_MS);
  }, []);

  const closeCardNow = useCallback((key: string) => {
    window.clearTimeout(hideTimerRef.current);
    setTrigger((prev) => (prev && prev.key === key ? null : prev));
  }, []);

  const clearCard = useCallback(() => {
    window.clearTimeout(hideTimerRef.current);
    setTrigger(null);
  }, []);

  const value = useMemo(
    () => ({ trigger, showCard, hideCard, closeCardNow, clearCard }),
    [trigger, showCard, hideCard, closeCardNow, clearCard]
  );

  return <ActiveCardContext.Provider value={value}>{children}</ActiveCardContext.Provider>;
}

export function useActiveCard(): ActiveCardContextValue {
  const ctx = useContext(ActiveCardContext);
  if (!ctx) throw new Error("useActiveCard must be used within an ActiveCardProvider");
  return ctx;
}