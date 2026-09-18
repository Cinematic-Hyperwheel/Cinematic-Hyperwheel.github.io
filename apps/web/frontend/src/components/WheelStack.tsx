import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Wheel, { RING_PAD } from "./Wheel";
import WheelPointLabels from "./WheelPointLabels";
import { RecAngle, RecItem, RecommendCircle, WheelCircle } from "../api";
import { circleKey } from "../utils/circleKey";
import { colorOnWheel } from "../utils/color";
import { resolvePoster } from "../utils/poster";
import { supportsHover } from "../utils/hover";
import { useHighlight } from "../contexts/HighlightContext";
import { useActiveCard } from "../contexts/ActiveCardContext";
import { useHoverCircle } from "../contexts/HoverCircleContext";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import "./WheelLegend.css";
import "./MovieHighlight.css";

interface Props {
  /** Actual active/primary circle - always drives the legend, and
   * drives the disc too whenever no hover preview is active. */
  circle: WheelCircle | null;
  size: number;
  title?: string;
  /** Overlays for `circle` - always what the legend renders. */
  overlays?: RecAngle[];
  /** Every circle that has at least one recommendation, in the same
   * order the Recommendations list/scrollspy uses (see App.tsx) - only
   * consulted by the grid-layout legend (see WheelLegend below), to
   * fill any empty vertical space left below the active circle's own
   * recommendations with dimmed preview blocks for the circles that
   * follow it. */
  queueCircles?: RecommendCircle[];
  /** Hover-preview override (see contexts/HoverCircleContext.tsx):
   * hovering an inactive small wheel (RecommendationsPanel.tsx) or an
   * inactive circle's tile in the legend grid (WheelLegend below)
   * temporarily shows THIS circle on the disc instead of `circle`. The
   * legend never reflects this - it always stays on `circle` - so
   * hovering never changes what recommendations are listed, only what
   * the disc currently shows. */
  previewCircle?: WheelCircle | null;
  previewOverlays?: RecAngle[];
}

interface DiscLayer {
  id: number;
  key: string; // "{pc_x}-{pc_y}" - axis-pair identity, not object identity
  circle: WheelCircle;
  size: number;
  title?: string;
  overlays?: RecAngle[];
  visible: boolean;
}

// Separate crossfade stack for the legend (see LegendLayer below) - kept
// independent from the disc's own DiscLayer stack since the two can now
// change for different reasons: the disc crossfades on every hover
// preview AND on every real active-circle switch, while the legend only
// ever crossfades on a real active-circle switch (see WheelLegend's own
// doc comment on WheelStack's Props for why hovering never touches it).
interface LegendLayer {
  id: number;
  key: string;
  circle: WheelCircle;
  overlays?: RecAngle[];
  queueCircles?: RecommendCircle[];
  visible: boolean;
}
 
// How long the active circle must stay unchanged before the legend is
// allowed to fetch poster images for it (see settledLegendKey in
// WheelStack below) - comfortably longer than useActiveCircleNav's own
// WHEEL_LOCK_MS, so a sustained burst of wheel-tick steps never counts
// as "settled" partway through.
const POSTER_LOAD_SETTLE_MS = 450;

function refCompassBearing(refX: number, refY: number): number {
  return ((Math.atan2(refY, refX) * 180) / Math.PI + 90 + 360) % 360;
}

/** How the big wheel's legend displays its recommendations: a compact
 * text list (default), or a poster grid. Desktop only - the legend
 * itself is hidden below the mobile breakpoint (see WheelLegend.css). */
type LegendLayoutMode = "list" | "grid";

function ListIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="20" y2="18" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </svg>
  );
}

// Shows the icon/label for the mode a click would switch TO - same
// "describe the destination state" convention as RecommendationsPanel's
// stack/unstack toggle.
function LegendLayoutToggle({ layout, onToggle }: { layout: LegendLayoutMode; onToggle: () => void }) {
  const { t } = useTranslation();
  const label = layout === "grid" ? t("recommendations.legendViewList") : t("recommendations.legendViewGrid");
  return (
    <button
      type="button"
      className="wheel-legend__layout-toggle"
      onClick={onToggle}
      title={label}
      aria-label={label}
    >
      {layout === "grid" ? <ListIcon /> : <GridIcon />}
    </button>
  );
}

interface LegendTileProps {
  item: RecItem;
  /** Only set on the first tile of a scheme-angle group - see the row
   * variant's own angle badge for the same convention. */
  angleLabel?: string;
  swatch: string;
  isHighlighted: boolean;
  onEnter: (el: HTMLElement) => void;
  onLeave: () => void;
  /** Whether this tile's own circle is the currently settled one (see
   * settledLegendKey in WheelStack) - gates the poster fetch below so
   * only the circle the user actually stopped on ever requests poster
   * images, not every circle briefly passed through on the way there. */
  loadPosters: boolean;
}

// Poster tile for the legend's grid layout - same hover/highlight wiring
// as a list row (see LegendTile's callers in WheelLegend), just a
// different visual: a lazily-resolved poster (see utils/poster.ts) with
// a bottom scrim for the title and a corner badge/swatch for the scheme
// angle, instead of a text row.
function LegendTile({ item, angleLabel, swatch, isHighlighted, onEnter, onLeave, loadPosters }: LegendTileProps) {
  const [posterUrl, setPosterUrl] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!loadPosters) return;
    let cancelled = false;
    setPosterUrl(undefined);
    resolvePoster(item.item_id).then((url) => {
      if (!cancelled) setPosterUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [item.item_id, loadPosters]);

  return (
    <div
      className={"wheel-legend__tile" + (isHighlighted ? " wheel-legend__tile--highlighted" : "")}
      onMouseEnter={(e) => onEnter(e.currentTarget)}
      onMouseLeave={onLeave}
    >
      <div className="wheel-legend__tile-poster-wrap">
        {posterUrl === undefined && (
          <div className="wheel-legend__tile-poster wheel-legend__tile-poster--loading" aria-hidden="true" />
        )}
        {posterUrl && <img className="wheel-legend__tile-poster" src={posterUrl} alt="" loading="lazy" />}
        {posterUrl === null && (
          <div className="wheel-legend__tile-poster wheel-legend__tile-poster--empty" aria-hidden="true" />
        )}
        <div className="wheel-legend__tile-scrim" aria-hidden="true" />
        {angleLabel ? (
          <span className="wheel-legend__tile-badge" style={{ borderColor: swatch, color: swatch }}>
            {angleLabel}
          </span>
        ) : (
          <span className="wheel-legend__tile-swatch" style={{ background: swatch, color: swatch }} aria-hidden="true" />
        )}
        <span className="wheel-legend__tile-title">{item.title}</span>
      </div>
    </div>
  );
}

interface WheelLegendProps {
  circle: WheelCircle;
  overlays?: RecAngle[];
  layout: LegendLayoutMode;
  onToggleLayout: () => void;
  /** Forwarded to each LegendTile - see LegendTileProps.loadPosters. */
  loadPosters: boolean;
  /** See Props.queueCircles above. */
  queueCircles?: RecommendCircle[];
  /** Pixel height to cap the legend at - the wheel's own rendered wrap
   * height (size + RING_PAD*2, see WheelStack below), so the legend
   * never grows taller than the disc beside it. Set explicitly rather
   * than relying on the flex row's own stretch behavior: without an
   * explicit cap, content taller than the wheel would make the row (and
   * so the legend's own stretched height) grow to fit itself instead of
   * the other way around - which is what let the grid layout's
   * extra-block fitting effect below always measure "fits" and render
   * every queued circle instead of stopping once the visible area is
   * full. */
  maxHeight: number;
}

// AxisConfig's own color pair shape, duplicated here (rather than
// imported) since both a WheelCircle's and a RecommendCircle's axis
// configs already satisfy it structurally - see renderBlock below,
// which is shared by both the active circle's own block and the extra
// circles sourced from queueCircles.
interface AxisColorPair {
  positive: string;
  negative: string;
}

// Legend rows/tiles for the big/primary wheel. Hovering a row or tile
// cross-highlights the same movie's point on the wheel/other surfaces
// (see HighlightContext.tsx) and, independently, opens the
// recommendation info card anchored to it (see
// contexts/ActiveCardContext.tsx), kept clear of the big wheel's own
// point for this item - the card only ever reacts to its own trigger's
// hover, never to a highlight that originated elsewhere.
//
// In grid layout, once the active circle's own recommendations are
// rendered, any empty vertical space left in the legend's own visible
// area (capped to the wheel's own height via the maxHeight prop passed
// in from WheelStack below) is filled with additional, dimmed preview
// blocks for the circles that follow the active one in `queueCircles` -
// see the fitting effect below. List layout only ever shows the active
// circle, unchanged.
function WheelLegend({ circle, overlays, layout, onToggleLayout, loadPosters, queueCircles, maxHeight }: WheelLegendProps) {
  const cKey = circleKey(circle);
  const { highlighted, setHighlighted, clearHighlighted } = useHighlight();
  const { showCard, hideCard, closeCardNow } = useActiveCard();
  const { setHoveredCircle } = useHoverCircle();
  const openCardKeyRef = useRef<string | null>(null);
  const legendRef = useRef<HTMLDivElement>(null);

  const populated = overlays?.filter((angle) => angle.items.length > 0) ?? [];

  // Circles after the active one, in the same order the Recommendations
  // list/scrollspy uses (see App.tsx) - candidates for the extra preview
  // blocks below. Empty whenever the active circle can't be located in
  // the queue (e.g. the prop wasn't provided), which simply disables the
  // fill-extra-space behavior rather than erroring.
  const activeQueueIndex = queueCircles?.findIndex((c) => circleKey(c) === cKey) ?? -1;
  const extraQueue = activeQueueIndex >= 0 ? queueCircles!.slice(activeQueueIndex + 1) : [];

  // Grid layout only: how many of the circles in `extraQueue` are
  // currently rendered as extra preview blocks.
  const [extraCount, setExtraCount] = useState(0);

  // Closes this instance's own card (if one of its rows currently has
  // one open), and clears any hover-preview override it may have set on
  // the big wheel, when the instance itself unmounts - e.g. the big
  // wheel crossfading to a different circle while a legend tile is
  // still hovered (see WheelStack's crossfade).
  useEffect(() => {
    return () => {
      if (openCardKeyRef.current) closeCardNow(openCardKeyRef.current);
      setHoveredCircle(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A fresh active circle, a layout switch, or the active circle's own
  // recommendation set changing shape (e.g. a scheme switch that
  // doesn't happen to change which axis pair is primary) invalidates
  // any previously fitted extra blocks - always re-measure from scratch
  // rather than growing/shrinking the previous circle's count. Runs
  // pre-paint (useLayoutEffect) together with the fitting effect below,
  // so the reset-then-regrow cycle converges before the user ever sees
  // an intermediate state.
  useLayoutEffect(() => {
    setExtraCount(0);
  }, [cKey, layout, populated.length]);

  // Re-measures from scratch when the legend's own box (not just its
  // content) changes size - a viewport resize, or the wheel growing or
  // shrinking (which changes the legend's own maxHeight cap, passed in
  // from WheelStack below). Content-only height changes (adding a
  // block) are handled by the fitting effect below instead, without a
  // full reset.
  useEffect(() => {
    if (layout !== "grid") return;
    const el = legendRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setExtraCount(0));
    observer.observe(el);
    return () => observer.disconnect();
  }, [layout]);

  // Grows extraCount one circle at a time while the rendered blocks
  // still fit inside the legend's own visible height - i.e. while
  // there's empty space left to fill. This is entirely local to the
  // legend's own box (scrollHeight vs. clientHeight) and never touches
  // window scroll position, so it can't race with either the active
  // circle switching via a click/keyboard/wheel-tick, or with the
  // page's own scrollspy (see useActiveCircleNav.ts) - those two are
  // what drive WHICH circle is active; this effect only ever decides
  // how many blocks to show for whichever circle already is active.
  // The last block added is allowed to overflow past the bottom edge
  // (the legend already scrolls internally - see .wheel-stack__legend)
  // - that's the intended "one extra row may spill past the visible
  // area" allowance, rather than a bug to correct for.
  useLayoutEffect(() => {
    if (layout !== "grid") return;
    const el = legendRef.current;
    if (!el) return;
    if (extraCount >= extraQueue.length) return;
    if (el.scrollHeight <= el.clientHeight) {
      setExtraCount((n) => n + 1);
    }
    // extraQueue is a fresh slice every render; only its length matters
    // for this comparison, and it changes only alongside cKey/populated
    // (both already covered by the reset effect above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, extraCount, extraQueue.length]);

  if (populated.length === 0) return null;

  const bearing = refCompassBearing(circle.z_x, circle.z_y);

  const makeHoverHandlers = (blockKey: string, item: RecItem, cardKey: string) => ({
    onEnter: (el: HTMLElement) => {
      setHighlighted(blockKey, item.item_id);
      const pointEl = el
        .closest<HTMLElement>(".wheel-stack__row")
        ?.querySelector<SVGCircleElement>(`[data-point-item-id="${item.item_id}"]`);
      showCard({
        key: cardKey,
        item,
        source: "legend",
        rect: el.getBoundingClientRect(),
        avoidRect: pointEl?.getBoundingClientRect(),
      });
      openCardKeyRef.current = cardKey;
    },
    onLeave: () => {
      clearHighlighted(blockKey, item.item_id);
      hideCard(cardKey);
    },
  });

  // Renders one circle's own angle groups as either poster tiles (grid)
  // or text rows (list) - shared by the active circle's own block and,
  // in grid layout, the extra preview blocks appended after it.
  // `blockKey` scopes hover-highlight and card triggers to that
  // circle's own key, so an extra block never lights up the active
  // circle's points (or vice versa).
  const renderBlock = (
    blockKey: string,
    angles: RecAngle[],
    blockBearing: number,
    axisXColors: AxisColorPair,
    axisYColors: AxisColorPair,
    blockLoadPosters: boolean
  ) =>
    angles.map((angle) => {
      const swatch = colorOnWheel(
        blockBearing + angle.angle_deg,
        axisXColors.positive,
        axisXColors.negative,
        axisYColors.positive,
        axisYColors.negative
      );
      const angleText = `${Math.round(angle.angle_deg) > 0 ? "+" : ""}${Math.round(angle.angle_deg)}°`;

      return (
        <div className={"rec-angle" + (layout === "grid" ? " rec-angle--grid" : "")} key={angle.angle_deg}>
          <div className={layout === "grid" ? "wheel-legend__tiles" : undefined}>
            {angle.items.map((item, index) => {
              const cardKey = `${blockKey}:legend:${item.item_id}`;
              const isHighlighted = highlighted?.circleKey === blockKey && highlighted.itemId === item.item_id;
              const { onEnter: handleEnter, onLeave: handleLeave } = makeHoverHandlers(blockKey, item, cardKey);

              if (layout === "grid") {
                return (
                  <LegendTile
                    key={item.item_id}
                    item={item}
                    angleLabel={index === 0 ? angleText : undefined}
                    swatch={swatch}
                    isHighlighted={isHighlighted}
                    onEnter={handleEnter}
                    onLeave={handleLeave}
                    loadPosters={blockLoadPosters}
                  />
                );
              }

              return (
                <div
                  className={
                    "rec-row" +
                    (index > 0 ? " rec-row--compact" : "") +
                    (isHighlighted ? " rec-row--highlighted" : "")
                  }
                  key={item.item_id}
                  onMouseEnter={(e) => handleEnter(e.currentTarget)}
                  onMouseLeave={handleLeave}
                >
                  {index === 0 ? (
                    <span
                      className="rec-row__anglebadge"
                      style={{ borderColor: swatch, color: swatch }}
                      aria-hidden="true"
                    >
                      {angleText}
                    </span>
                  ) : (
                    <span
                      className="rec-row__swatch"
                      style={{ background: swatch, color: swatch }}
                      aria-hidden="true"
                    />
                  )}
                  <div className="rec-row__body">
                    <span className="rec-row__title">{item.title}</span>
                    {item.angular_error_deg != null && (
                      <span className="rec-row__meta">
                        Δangle: {item.angular_error_deg.toFixed(1)}°
                        {item.radius_ratio != null && ` · r-ratio: ${item.radius_ratio.toFixed(2)}`}
                      </span>
                    )}
                  </div>
                  <span />
                  <span />
                </div>
              );
            })}
          </div>
        </div>
      );
    });

  const visibleExtraQueue = layout === "grid" ? extraQueue.slice(0, extraCount) : [];

  return (
    <div className="wheel-stack__legend" ref={legendRef} aria-label="Recommendations" style={{ maxHeight }}>
      <div className="wheel-legend__header">
        <LegendLayoutToggle layout={layout} onToggle={onToggleLayout} />
      </div>

      <div className="wheel-legend__group">
        {renderBlock(cKey, populated, bearing, circle.axis_x.colors, circle.axis_y.colors, loadPosters)}
      </div>

      {visibleExtraQueue.map((entry) => {
        const entryKey = circleKey(entry);
        const entryPopulated = entry.angles.filter((a) => a.items.length > 0);
        if (entryPopulated.length === 0) return null;
        const entryBearing = entry.reference ? refCompassBearing(entry.reference.z_x, entry.reference.z_y) : 0;

        return (
          <div
            className="wheel-legend__group wheel-legend__group--dimmed"
            key={entryKey}
            // Hovering any tile in an inactive circle's preview block
            // temporarily shows that circle on the big wheel, and (via
            // the shared hovered-circle key) highlights its own small
            // wheel in the Recommendations list - see
            // RecommendationsPanel.tsx.
            onMouseEnter={() => {
              if (supportsHover()) setHoveredCircle(entry);
            }}
            onMouseLeave={() => {
              if (supportsHover()) setHoveredCircle(null);
            }}
          >
            {renderBlock(entryKey, entryPopulated, entryBearing, entry.axis_x.colors, entry.axis_y.colors, loadPosters)}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Crossfades between successive discs instead of swapping them outright
 * (see discCircle above for what drives which circle is shown).
 * A plain key-based remount (unmount old, mount new at opacity 0, fade in)
 * has a visible gap: the old wheel is gone in the same commit the new one
 * mounts, so for the first frames of the fade-in there's nothing but the
 * page background behind it - a brief, unpleasant flash every time the
 * shown circle changes (e.g. scrolling through the Recommendations list -
 * see RecommendationsPanel.tsx's scrollspy).
 *
 * Same fix as HeroBackdrop.tsx uses for the hero image: keep the outgoing
 * wheel mounted and fully visible underneath, mount the new one on top at
 * opacity 0, fade it in, and only remove the old one once the new one has
 * fully faded in - so there's always something fully opaque on screen.
 * Layers stack via CSS grid (all layers in one cell - see .wheel-stack in
 * index.css), not absolute positioning, so the container doesn't need an
 * explicitly tracked pixel size for the overlap to work.
 *
 * A circle with the SAME axis pair as the current top layer (e.g. only
 * its overlay recommendation points changed, from a scheme switch) is not
 * treated as a new layer - its data is updated in place, so unrelated
 * prop changes never trigger an unnecessary fade.
 *
 * Point/legend hover highlighting (see contexts/HighlightContext.tsx) is
 * scoped per circle key, so an outgoing layer (a stale, different circle
 * key) never cross-lights with the incoming one - no special-casing
 * needed here beyond each layer rendering its own circle's key.
 */
export default function WheelStack({
  circle,
  size,
  title,
  overlays,
  queueCircles,
  previewCircle,
  previewOverlays,
}: Props) {
  const [discLayers, setDiscLayers] = useState<DiscLayer[]>([]);
  const nextDiscId = useRef(0);
  const [legendLayers, setLegendLayers] = useState<LegendLayer[]>([]);
  const nextLegendId = useRef(0);
  const [legendLayout, setLegendLayout] = useState<LegendLayoutMode>("grid");

  // What the disc (Wheel + WheelPointLabels) actually renders - the
  // hover-preview circle when one is set, otherwise the real active
  // circle. The legend is intentionally NOT derived from this - it
  // always tracks `circle`/`overlays` directly (see legendLayers' own
  // effect below), so hovering a small wheel or a legend tile never
  // changes what the legend lists.
  const discCircle = previewCircle ?? circle;
  const discOverlays = previewCircle ? previewOverlays : overlays;

  // Gates poster loading for BOTH the disc's hover-preview legend data
  // (not applicable here) and the legend's own crossfade below - a
  // pending legend layer only starts fetching posters, and is only
  // allowed to start fading in, once the real active circle has stayed
  // the same for POSTER_LOAD_SETTLE_MS. This is what keeps a fast
  // sequence of active-circle changes (e.g. a wheel-tick burst) from
  // firing a poster request - or starting a crossfade - for every
  // circle briefly passed through; only the one actually settled on
  // ever does either.
  const settledLegendKey = useDebouncedValue(
    circle ? circleKey(circle) : null,
    POSTER_LOAD_SETTLE_MS
  );

  // --- Disc crossfade: same technique as before, now scoped to the
  // disc only (see discCircle above). ---
  useEffect(() => {
    if (!discCircle) return;
    const key = circleKey(discCircle);
    setDiscLayers((prev) => {
      if (prev.length > 0 && prev[prev.length - 1].key === key) {
        const updated = [...prev];
        updated[updated.length - 1] = { ...updated[updated.length - 1], circle: discCircle, size, title, overlays: discOverlays };
        return updated;
      }
      const id = ++nextDiscId.current;
      return [...prev, { id, key, circle: discCircle, size, title, overlays: discOverlays, visible: false }];
    });
    // discCircle/size/title/discOverlays are fresh objects/arrays every
    // parent render regardless of whether they logically changed -
    // intentional: the branch above makes re-running this a harmless
    // no-op update rather than an extra fade, so depending on
    // primitives only isn't needed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discCircle, size, title, discOverlays]);

  useEffect(() => {
    const pending = discLayers.find((l) => !l.visible);
    if (!pending) return;
    let cancelled = false;
    // Two rAFs: the layer must actually paint at opacity 0 first, or the
    // browser coalesces the initial and final style and the opacity
    // transition never runs (same reasoning as HeroBackdrop.tsx).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (cancelled) return;
        setDiscLayers((prev) => prev.map((l) => (l.id === pending.id ? { ...l, visible: true } : l)));
      });
    });
    return () => {
      cancelled = true;
    };
  }, [discLayers]);

  const handleDiscTransitionEnd = (id: number) => {
    setDiscLayers((prev) => {
      const idx = prev.findIndex((l) => l.id === id);
      if (idx === -1 || idx !== prev.length - 1) return prev;
      return prev.slice(idx);
    });
  };

  // --- Legend crossfade: keyed on the real active circle only, never
  // on the hover preview. A rapid sequence of active-circle changes
  // collapses onto the most recent one (rather than stacking a third
  // layer) by overwriting a still-invisible trailing layer in place,
  // instead of pushing another one behind it. ---
  useEffect(() => {
    if (!circle) return;
    const key = circleKey(circle);
    setLegendLayers((prev) => {
      if (prev.length === 0) {
        const id = ++nextLegendId.current;
        return [{ id, key, circle, overlays, queueCircles, visible: false }];
      }
      const last = prev[prev.length - 1];
      if (last.key === key) {
        const updated = [...prev];
        updated[updated.length - 1] = { ...last, circle, overlays, queueCircles };
        return updated;
      }
      if (!last.visible) {
        const updated = [...prev];
        updated[updated.length - 1] = { ...last, key, circle, overlays, queueCircles };
        return updated;
      }
      const id = ++nextLegendId.current;
      return [...prev, { id, key, circle, overlays, queueCircles, visible: false }];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [circle, overlays, queueCircles]);

  // A pending legend layer only starts fading in once it's also the
  // settled key - i.e. once its posters have started loading (see
  // loadPosters below) - so the previous, already fully-loaded layer
  // stays on screen for the whole settle window instead of the new one
  // fading in still empty.
  useEffect(() => {
    const pending = legendLayers.find((l) => !l.visible);
    if (!pending || pending.key !== settledLegendKey) return;
    let cancelled = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (cancelled) return;
        setLegendLayers((prev) => prev.map((l) => (l.id === pending.id ? { ...l, visible: true } : l)));
      });
    });
    return () => {
      cancelled = true;
    };
  }, [legendLayers, settledLegendKey]);

  const handleLegendTransitionEnd = (id: number) => {
    setLegendLayers((prev) => {
      const idx = prev.findIndex((l) => l.id === id);
      if (idx === -1 || idx !== prev.length - 1) return prev;
      return prev.slice(idx);
    });
  };

  if (!circle || discLayers.length === 0 || legendLayers.length === 0) return null;

  return (
    <div className="wheel-stack">
      {/* Disc and legend sit side by side in a flex row (see
          .wheel-stack__row in WheelLegend.css), each with its own
          independent crossfade - see discCircle/settledLegendKey above
          for what drives each one. */}
      <div className="wheel-stack__row">
        <div className="wheel-stack__crossfade">
          {discLayers.map((l) => (
            <div
              key={l.id}
              className={"wheel-stack__crossfade-layer" + (l.visible ? " wheel-stack__crossfade-layer--visible" : "")}
              onTransitionEnd={() => handleDiscTransitionEnd(l.id)}
            >
              <div className="wheel-stack__disc-wrap">
                <Wheel circle={l.circle} size={l.size} title={l.title} overlays={l.overlays} />
                <WheelPointLabels
                  circle={l.circle}
                  size={l.size}
                  title={l.title}
                  overlays={l.overlays}
                  circleKey={l.key}
                />
              </div>
            </div>
          ))}
        </div>

        <div className="wheel-stack__crossfade wheel-stack__legend-crossfade">
          {legendLayers.map((l) => (
            <div
              key={l.id}
              className={"wheel-stack__crossfade-layer" + (l.visible ? " wheel-stack__crossfade-layer--visible" : "")}
              onTransitionEnd={() => handleLegendTransitionEnd(l.id)}
            >
              <WheelLegend
                circle={l.circle}
                overlays={l.overlays}
                layout={legendLayout}
                onToggleLayout={() => setLegendLayout((m) => (m === "list" ? "grid" : "list"))}
                loadPosters={l.key === settledLegendKey}
                queueCircles={l.queueCircles}
                maxHeight={size + RING_PAD * 2 + 40}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}