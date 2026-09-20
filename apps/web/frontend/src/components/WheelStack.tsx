import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Wheel, { RING_PAD } from "./Wheel";
import WheelPointLabels from "./WheelPointLabels";
import { RecAngle, RecItem, RecommendCircle, StarfieldItem, WheelCircle } from "../api";
import { circleKey } from "../utils/circleKey";
import { colorOnWheel } from "../utils/color";
import { resolvePoster } from "../utils/poster";
import { supportsHover } from "../utils/hover";
import { useHighlight } from "../contexts/HighlightContext";
import { useActiveCard } from "../contexts/ActiveCardContext";
import { useHoverCircle } from "../contexts/HoverCircleContext";
import "./WheelLegend.css";
import "./MovieHighlight.css";

interface Props {
  /** Actual active/primary circle - always drives the legend, and
   * drives the disc too whenever no hover preview is active. */
  circle: WheelCircle | null;
  size: number;
  title?: string;
  /** Overlays for `circle`. Only used as a fallback source for the
   * legend when `queueCircles` isn't provided (see legendCircles). */
  overlays?: RecAngle[];
  /** Background star field for `circle`'s own plane - see Wheel.tsx.
   * Only used as a fallback source when `queueCircles` isn't provided,
   * same as `overlays`. */
  starfield?: StarfieldItem[];
  /** Every circle that has at least one recommendation, in the same
   * order the Recommendations list/scrollspy uses (see App.tsx). This
   * is the legend's own content: one block per circle, all of them
   * mounted at once as a single vertical track that scrolls the active
   * circle's block to the top (see WheelLegend below). */
  queueCircles?: RecommendCircle[];
  /** Hover-preview override (see contexts/HoverCircleContext.tsx):
   * hovering an inactive small wheel (RecommendationsPanel.tsx) or an
   * inactive circle's block in the legend temporarily shows THIS circle
   * on the disc instead of `circle`. The legend never reflects this -
   * it always stays anchored on `circle` - so hovering never changes
   * what recommendations are listed, only what the disc currently
   * shows. */
  previewCircle?: WheelCircle | null;
  previewOverlays?: RecAngle[];
  /** Star field for `previewCircle` - swapped in alongside
   * previewOverlays whenever a hover preview is active. */
  previewStarfield?: StarfieldItem[];
}

interface DiscLayer {
  id: number;
  key: string; // "{pc_x}-{pc_y}" - axis-pair identity, not object identity
  circle: WheelCircle;
  size: number;
  title?: string;
  overlays?: RecAngle[];
  starfield?: StarfieldItem[];
  visible: boolean;
}

// How far outside the legend's own visible area a poster tile starts
// resolving its image - enough to have the next row or two ready before
// they're scrolled to, without speculatively fetching the whole track.
const POSTER_PRELOAD_MARGIN_PX = 300;
// How long the track must stay put before newly-visible tiles are
// allowed to fetch. While the track is sliding, every block between the
// old and new position sweeps through the viewport; without this, a
// single step would request posters for all of them. Comfortably longer
// than the track's own transition (see .wheel-legend__track) and than
// useActiveCircleNav's WHEEL_LOCK_MS, so a burst of wheel-tick steps
// never settles partway through.
const POSTER_SLIDE_SETTLE_MS = 500;
// Small coalescing delay for intersection updates while the track is
// already at rest (a resize, a layout switch, posters changing tile
// heights) - keeps one flush per burst instead of one per entry.
const POSTER_IDLE_FLUSH_MS = 120;

function refCompassBearing(refX: number, refY: number): number {
  return ((Math.atan2(refY, refX) * 180) / Math.PI + 90 + 360) % 360;
}

/** How the big wheel's legend displays its recommendations: a compact
 * text list, or a poster grid (default). Desktop only - the legend
 * itself is hidden below the mobile breakpoint (see WheelLegend.css). */
type LegendLayoutMode = "list" | "grid";

// AxisConfig's own color pair shape, duplicated here (rather than
// imported) since both a WheelCircle's and a RecommendCircle's axis
// configs already satisfy it structurally.
interface AxisColorPair {
  positive: string;
  negative: string;
}

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

interface LegendItemProps {
  /** Circle key this item belongs to - scopes hover highlighting and
   * the info card to that circle's own surfaces, so an inactive block
   * never lights up the active circle's points (or vice versa). */
  blockKey: string;
  item: RecItem;
  /** Only set on the first item of a scheme-angle group. */
  angleLabel?: string;
  swatch: string;
  isHighlighted: boolean;
  onEnter: (blockKey: string, item: RecItem, el: HTMLElement) => void;
  onLeave: (blockKey: string, item: RecItem) => void;
}

interface LegendTileProps extends LegendItemProps {
  /** Identity of this tile within the whole track - block-scoped, since
   * the same movie can be recommended by more than one circle. */
  tileKey: string;
  /** Registers this tile's own element with the legend's shared
   * visibility observer (see WheelLegend), which is what decides when
   * `loadPosters` flips on. */
  registerTile: (tileKey: string, el: HTMLElement | null) => void;
  /** Whether this tile is close enough to the visible area to resolve
   * its poster. False for everything else in the track, which is what
   * keeps mounting every block from costing a request per tile. */
  loadPosters: boolean;
}

// Poster tile for the grid layout. Memoized with stable callbacks: every
// block of the track is mounted at once, so a single hover anywhere in
// the legend must not re-render hundreds of tiles.
const LegendTile = memo(function LegendTile({
  blockKey,
  tileKey,
  item,
  angleLabel,
  swatch,
  isHighlighted,
  onEnter,
  onLeave,
  registerTile,
  loadPosters,
}: LegendTileProps) {
  const [posterUrl, setPosterUrl] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    setPosterUrl(undefined);
  }, [item.item_id]);

  // A resolved poster is kept even once this tile leaves the visible
  // window - dropping it would make a block visibly empty out again the
  // moment the user steps past it and back. resolvePoster is itself
  // cached per item (see utils/poster.ts), so a tile that comes back
  // after a remount doesn't hit the network twice either.
  useEffect(() => {
    if (!loadPosters) return;
    let cancelled = false;
    resolvePoster(item.item_id).then((url) => {
      if (!cancelled) setPosterUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [item.item_id, loadPosters]);

  return (
    <div
      ref={(el) => registerTile(tileKey, el)}
      className={"wheel-legend__tile" + (isHighlighted ? " wheel-legend__tile--highlighted" : "")}
      onMouseEnter={(e) => onEnter(blockKey, item, e.currentTarget)}
      onMouseLeave={() => onLeave(blockKey, item)}
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
});

// Text-row variant of the same item - memoized for the same reason as
// LegendTile above.
const LegendRow = memo(function LegendRow({
  blockKey,
  item,
  angleLabel,
  swatch,
  isHighlighted,
  onEnter,
  onLeave,
}: LegendItemProps) {
  return (
    <div
      className={
        "rec-row" +
        (angleLabel ? "" : " rec-row--compact") +
        (isHighlighted ? " rec-row--highlighted" : "")
      }
      onMouseEnter={(e) => onEnter(blockKey, item, e.currentTarget)}
      onMouseLeave={() => onLeave(blockKey, item)}
    >
      {angleLabel ? (
        <span className="rec-row__anglebadge" style={{ borderColor: swatch, color: swatch }} aria-hidden="true">
          {angleLabel}
        </span>
      ) : (
        <span className="rec-row__swatch" style={{ background: swatch, color: swatch }} aria-hidden="true" />
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
});

interface WheelLegendProps {
  /** Every populated circle, in the Recommendations list's own order -
   * one block per entry, all mounted at once. */
  circles: RecommendCircle[];
  /** Key of the circle currently active (see utils/circleKey.ts) - the
   * block the track aligns to the top of its viewport. */
  activeKey: string;
  layout: LegendLayoutMode;
  onToggleLayout: () => void;
  /** Fixed pixel height of the legend's clipping viewport - the wheel's
   * own rendered wrap height (see WheelStack below), so the legend is
   * never taller than the disc beside it. Must be a real height, not a
   * max-height: the track is positioned by translate against it. */
  height: number;
}

/**
 * Legend for the big/primary wheel: every populated circle's
 * recommendations rendered as one continuous vertical track, clipped to
 * a fixed-height viewport, with the active circle's own block aligned
 * to the top.
 *
 * Switching the active circle only changes the track's translateY, so
 * the grid the user is already looking at physically slides to its new
 * position from wherever it currently is - nothing remounts, fades, or
 * is rebuilt, and the whole motion is visible from its first frame.
 *
 * Blocks below the active one double as the preview of what comes next,
 * dimmed; a block arriving from outside the viewport may still show
 * poster placeholders, since posters are only resolved for a window
 * around the settled circle (see POSTER_BLOCKS_AHEAD/BEHIND).
 *
 * Hovering a row or tile cross-highlights the same movie's point on the
 * wheel (see HighlightContext.tsx) and opens the recommendation info
 * card anchored to it (see contexts/ActiveCardContext.tsx); hovering an
 * inactive block previews that circle on the disc (see
 * contexts/HoverCircleContext.tsx).
 */
function WheelLegend({ circles, activeKey, layout, onToggleLayout, height }: WheelLegendProps) {
  const { highlighted, setHighlighted, clearHighlighted } = useHighlight();
  const { showCard, hideCard, closeCardNow } = useActiveCard();
  const { setHoveredCircle } = useHoverCircle();
  const openCardKeyRef = useRef<string | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const blockRefs = useRef<Map<string, HTMLElement>>(new Map());
  const [offset, setOffset] = useState(0);
  // Suppresses the slide for one frame whenever the block set itself is
  // replaced (new reference movie or scheme): the active circle resets
  // to the first one, and animating across content the user never saw
  // would read as a long, meaningless scroll.
  const [instant, setInstant] = useState(true);

    const viewportRef = useRef<HTMLDivElement>(null);
  // Live intersection state for every mounted grid tile, and the subset
  // of it that has actually been published to render. Kept apart so
  // intersection updates observed WHILE the track is sliding can be
  // recorded without acting on them - see flushVisibleTiles below.
  const tileIntersectingRef = useRef<Map<string, boolean>>(new Map());
  const [visibleTiles, setVisibleTiles] = useState<Set<string>>(new Set());
  const tileObserverRef = useRef<IntersectionObserver | null>(null);
  // Every currently mounted grid tile, by key. Needed because tiles
  // register during the commit that mounts them, which is BEFORE the
  // effect below gets a chance to create the observer - so the observer
  // has to pick up whatever is already here when it's created, rather
  // than relying on registration alone.
  const tileElsRef = useRef<Map<string, HTMLElement>>(new Map());
  const slidingRef = useRef(false);
  const flushTimerRef = useRef<number | undefined>(undefined);

  const flushVisibleTiles = useCallback(() => {
    slidingRef.current = false;
    const next = new Set<string>();
    for (const [key, intersecting] of tileIntersectingRef.current) {
      if (intersecting) next.add(key);
    }
    setVisibleTiles((prev) => {
      if (prev.size === next.size && [...next].every((key) => prev.has(key))) return prev;
      return next;
    });
  }, []);

  const scheduleFlush = useCallback(
    (delayMs: number) => {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = window.setTimeout(flushVisibleTiles, delayMs);
    },
    [flushVisibleTiles]
  );

  const blocks = useMemo(
    () =>
      circles
        .map((circle) => ({
          key: circleKey(circle),
          circle,
          angles: circle.angles.filter((a) => a.items.length > 0),
        }))
        .filter((block) => block.angles.length > 0),
    [circles]
  );

  // `blocks.length > 0` is part of the dependency array on purpose: the
  // legend renders no DOM at all (see the early `return null` below) until
  // there's at least one populated circle, so `viewportRef.current` isn't
  // available yet on the very first commit if the recommendations haven't
  // arrived by then (the common case on a fresh page load). Re-running
  // this effect once real content appears is what lets the observer
  // actually attach to a live root instead of silently giving up forever
  // on a `root` that was null at mount time.
  const hasBlocks = blocks.length > 0;
  // Single observer shared by every tile in the track, rooted at the
  // legend's own clipping viewport: a tile resolves its poster only once
  // it's actually near the visible area, which is what keeps mounting
  // the whole track from costing one request per tile on load.
  useEffect(() => {
  const root = viewportRef.current;
  if (!root) return;
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.tileKey;
        if (key) tileIntersectingRef.current.set(key, entry.isIntersecting);
      }
      if (!slidingRef.current) scheduleFlush(POSTER_IDLE_FLUSH_MS);
    },
    { root, rootMargin: `${POSTER_PRELOAD_MARGIN_PX}px 0px`, threshold: 0 }
  );
  tileObserverRef.current = observer;
  // Tiles mounted in the same commit registered before this effect ran,
  // so they're already in tileElsRef and need observing here.
  for (const el of tileElsRef.current.values()) observer.observe(el);
  return () => {
    observer.disconnect();
    tileObserverRef.current = null;
    window.clearTimeout(flushTimerRef.current);
  };
}, [scheduleFlush, hasBlocks]);

  const registerTile = useCallback((tileKey: string, el: HTMLElement | null) => {
    const observer = tileObserverRef.current;
    if (el) {
      el.dataset.tileKey = tileKey;
      tileElsRef.current.set(tileKey, el);
      observer?.observe(el);
      return;
    }
    const previous = tileElsRef.current.get(tileKey);
    if (previous) observer?.unobserve(previous);
    tileElsRef.current.delete(tileKey);
    tileIntersectingRef.current.delete(tileKey);
  }, []);

  // `circles` is a fresh array on every parent render, so block identity
  // has to be compared by content, not by reference - keying effects off
  // the array itself would retrigger them constantly and kill the slide.
  const blocksSignature = blocks.map((block) => block.key).join("|");

  const activeIndex = blocks.findIndex((block) => block.key === activeKey);

  // offsetTop is layout-based and therefore unaffected by the track's
  // own translate; the track is the blocks' offset parent (it's
  // position: relative - see WheelLegend.css).
  const measure = useCallback(() => {
    const el = blockRefs.current.get(activeKey);
    setOffset(el ? el.offsetTop : 0);
  }, [activeKey]);

  useLayoutEffect(() => {
    measure();
  }, [measure, layout, height, blocksSignature]);

  useLayoutEffect(() => {
    setInstant(true);
  }, [blocksSignature]);

  // The track is about to travel: hold off publishing visibility until
  // it has actually come to rest (an instant jump has no travel to wait
  // out). A rapid sequence of steps keeps pushing this out, so only the
  // position the user settles on ever triggers poster requests.
  useLayoutEffect(() => {
    if (instant) {
      scheduleFlush(POSTER_IDLE_FLUSH_MS);
      return;
    }
    slidingRef.current = true;
    scheduleFlush(POSTER_SLIDE_SETTLE_MS);
  }, [offset, instant, scheduleFlush]);

  useEffect(() => {
    if (!instant) return;
    const frame = requestAnimationFrame(() => setInstant(false));
    return () => cancelAnimationFrame(frame);
  }, [instant]);

  // Keeps the alignment correct as the track's own content height
  // changes (layout switch, a different scheme's item counts).
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  // Closes this legend's own card, and clears any hover-preview override
  // it set on the big wheel, if it unmounts while still hovered.
  useEffect(() => {
    return () => {
      if (openCardKeyRef.current) closeCardNow(openCardKeyRef.current);
      setHoveredCircle(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleEnter = useCallback(
    (blockKey: string, item: RecItem, el: HTMLElement) => {
      const cardKey = `${blockKey}:legend:${item.item_id}`;
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
    [setHighlighted, showCard]
  );

  const handleLeave = useCallback(
    (blockKey: string, item: RecItem) => {
      clearHighlighted(blockKey, item.item_id);
      hideCard(`${blockKey}:legend:${item.item_id}`);
    },
    [clearHighlighted, hideCard]
  );

  const registerBlockRef = useCallback((key: string, el: HTMLElement | null) => {
    if (el) blockRefs.current.set(key, el);
    else blockRefs.current.delete(key);
  }, []);

  if (blocks.length === 0) return null;

  // One circle's angle groups, as poster tiles (grid) or text rows
  // (list).
  const renderBlock = (
    blockKey: string,
    angles: RecAngle[],
    blockBearing: number,
    axisXColors: AxisColorPair,
    axisYColors: AxisColorPair,
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
              const isHighlighted =
                highlighted?.circleKey === blockKey && highlighted.itemId === item.item_id;
              const angleLabel = index === 0 ? angleText : undefined;

              return layout === "grid" ? (
                <LegendTile
                  key={item.item_id}
                  tileKey={`${blockKey}:${item.item_id}`}
                  blockKey={blockKey}
                  item={item}
                  angleLabel={angleLabel}
                  swatch={swatch}
                  isHighlighted={isHighlighted}
                  onEnter={handleEnter}
                  onLeave={handleLeave}
                  registerTile={registerTile}
                  loadPosters={visibleTiles.has(`${blockKey}:${item.item_id}`)}
                />
              ) : (
                <LegendRow
                  key={item.item_id}
                  blockKey={blockKey}
                  item={item}
                  angleLabel={angleLabel}
                  swatch={swatch}
                  isHighlighted={isHighlighted}
                  onEnter={handleEnter}
                  onLeave={handleLeave}
                />
              );
            })}
          </div>
        </div>
      );
    });

  return (
    <div className="wheel-stack__legend" style={{ height }} aria-label="Recommendations">
      <div className="wheel-legend__header">
        <LegendLayoutToggle layout={layout} onToggle={onToggleLayout} />
      </div>

      <div className="wheel-legend__viewport" ref={viewportRef}>
        <div
          ref={trackRef}
          className={"wheel-legend__track" + (instant ? " wheel-legend__track--instant" : "")}
          style={{ transform: `translateY(${-offset}px)` }}
        >
          {blocks.map((block) => {
            const isActive = block.key === activeKey;
            const bearing = block.circle.reference
              ? refCompassBearing(block.circle.reference.z_x, block.circle.reference.z_y)
              : 0;

            return (
              <div
                key={block.key}
                ref={(el) => registerBlockRef(block.key, el)}
                className={"wheel-legend__block" + (isActive ? "" : " wheel-legend__block--dimmed")}
                // Hovering an inactive block temporarily shows that
                // circle on the big wheel, and (via the shared
                // hovered-circle key) highlights its own small wheel in
                // the Recommendations list - see RecommendationsPanel.tsx.
                onMouseEnter={() => {
                  if (!isActive && supportsHover()) setHoveredCircle(block.circle);
                }}
                onMouseLeave={() => {
                  if (!isActive && supportsHover()) setHoveredCircle(null);
                }}
              >
                {renderBlock(
                  block.key,
                  block.angles,
                  bearing,
                  block.circle.axis_x.colors,
                  block.circle.axis_y.colors,
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Crossfades between successive discs instead of swapping them outright
 * (see discCircle below for what drives which circle is shown).
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
 * This applies to the DISC only. The legend beside it is a single,
 * persistent track that slides between circles rather than crossfading -
 * see WheelLegend above.
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
  previewStarfield,
  starfield,
}: Props) {
  const [discLayers, setDiscLayers] = useState<DiscLayer[]>([]);
  const nextDiscId = useRef(0);
  const [legendLayout, setLegendLayout] = useState<LegendLayoutMode>("grid");

  // What the disc (Wheel + WheelPointLabels) actually renders - the
  // hover-preview circle when one is set, otherwise the real active
  // circle. The legend is intentionally NOT derived from this - it stays
  // anchored on `circle`, so hovering a small wheel or a legend block
  // never changes what the legend lists or where its track sits.
  const discCircle = previewCircle ?? circle;
  const discOverlays = previewCircle ? previewOverlays : overlays;
  const discStarfield = previewCircle ? previewStarfield : starfield;
  

  const activeKey = circle ? circleKey(circle) : null;

  // The legend's own content. `queueCircles` is the normal source; the
  // single-circle fallback keeps the legend working for a caller that
  // only has the active circle's overlays to give.
  const legendCircles = useMemo<RecommendCircle[]>(() => {
    if (queueCircles && queueCircles.length > 0) return queueCircles;
    if (!circle || !overlays) return [];
    return [
      {
        primary: circle.primary,
        axis_x: circle.axis_x,
        axis_y: circle.axis_y,
        reference: {
          z_x: circle.z_x,
          z_y: circle.z_y,
          angle_deg: circle.angle_deg,
          radius: circle.radius,
        },
        angles: overlays,
      },
    ];
  }, [queueCircles, circle, overlays]);

    useEffect(() => {
    if (!discCircle) return;
    const key = circleKey(discCircle);
    setDiscLayers((prev) => {
      if (prev.length > 0 && prev[prev.length - 1].key === key) {
        const updated = [...prev];
        updated[updated.length - 1] = {
          ...updated[updated.length - 1],
          circle: discCircle, size, title, overlays: discOverlays, starfield: discStarfield,
        };
        return updated;
      }
      const id = ++nextDiscId.current;
      return [...prev, { id, key, circle: discCircle, size, title, overlays: discOverlays, starfield: discStarfield, visible: false }];
    });
    // discCircle/size/title/discOverlays/discStarfield are fresh
    // objects/arrays every parent render regardless of whether they
    // logically changed - intentional, see the branch above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discCircle, size, title, discOverlays, discStarfield]);

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

  if (!circle || !activeKey || discLayers.length === 0) return null;

  return (
    <div className="wheel-stack">
      {/* Disc and legend sit side by side in a flex row (see
          .wheel-stack__row in WheelLegend.css): the disc crossfades
          between circles, the legend slides between them. */}
      <div className="wheel-stack__row">
        <div className="wheel-stack__crossfade">
          {discLayers.map((l) => (
            <div
              key={l.id}
              className={
                "wheel-stack__crossfade-layer wheel-stack__disc-layer" +
                (l.visible ? " wheel-stack__disc-layer--visible" : "")
              }
              onTransitionEnd={() => handleDiscTransitionEnd(l.id)}
            >
              <div className="wheel-stack__disc-wrap">
                <Wheel circle={l.circle} size={l.size} title={l.title} overlays={l.overlays} starfield={l.starfield} />
                <WheelPointLabels
                  circle={l.circle}
                  size={l.size}
                  title={l.title}
                  overlays={l.overlays}
                  starfield={l.starfield}
                  circleKey={l.key}
                />
              </div>
            </div>
          ))}
        </div>

        <WheelLegend
          circles={legendCircles}
          activeKey={activeKey}
          layout={legendLayout}
          onToggleLayout={() => setLegendLayout((m) => (m === "list" ? "grid" : "list"))}
          height={size + RING_PAD * 2 + 40}
        />
      </div>
    </div>
  );
}