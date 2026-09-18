import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { RecommendCircle } from "../api";
import { circleKey } from "../utils/circleKey";

/**
 * Desktop-only, temporary override of the big central wheel (see
 * App.tsx): hovering an inactive small wheel (RecommendationsPanel.tsx)
 * or an inactive circle's tile in the legend grid (WheelStack.tsx's
 * WheelLegend) previews that circle on the big wheel for the duration of
 * the hover, reverting to the actually active circle once it ends.
 * Lives above both App.tsx and the two trigger surfaces, since neither
 * trigger is an ancestor of the other.
 */
interface HoverCircleContextValue {
  /** The circle currently being hover-previewed, or null when no hover
   * override is active. */
  hoveredCircle: RecommendCircle | null;
  /** Circle key of the hovered circle (see utils/circleKey.ts), for
   * cheap identity comparisons - e.g. RecommendationsPanel highlighting
   * its own matching small wheel without needing the full circle
   * object. */
  hoveredCircleKey: string | null;
  /** Sets (or clears, with null) the circle currently hover-previewed. */
  setHoveredCircle: (circle: RecommendCircle | null) => void;
}

const HoverCircleContext = createContext<HoverCircleContextValue | null>(null);

export function HoverCircleProvider({ children }: { children: ReactNode }) {
  const [hoveredCircle, setHoveredCircle] = useState<RecommendCircle | null>(null);

  const setHoveredCircleCallback = useCallback((circle: RecommendCircle | null) => {
    setHoveredCircle(circle);
  }, []);

  const value = useMemo<HoverCircleContextValue>(
    () => ({
      hoveredCircle,
      hoveredCircleKey: hoveredCircle ? circleKey(hoveredCircle) : null,
      setHoveredCircle: setHoveredCircleCallback,
    }),
    [hoveredCircle, setHoveredCircleCallback]
  );

  return <HoverCircleContext.Provider value={value}>{children}</HoverCircleContext.Provider>;
}

export function useHoverCircle(): HoverCircleContextValue {
  const ctx = useContext(HoverCircleContext);
  if (!ctx) throw new Error("useHoverCircle must be used within a HoverCircleProvider");
  return ctx;
}