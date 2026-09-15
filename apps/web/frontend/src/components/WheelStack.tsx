import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Wheel from "./Wheel";
import WheelPointLabels from "./WheelPointLabels";
import { RecAngle, RecItem, WheelCircle } from "../api";
import { circleKey } from "../utils/circleKey";
import { colorOnWheel } from "../utils/color";
import { resolvePoster } from "../utils/poster";
import { useHighlight, useHighlightedItem } from "../contexts/HighlightContext";
import { useActiveCard } from "../contexts/ActiveCardContext";
import "./WheelLegend.css";
import "./MovieHighlight.css";

interface Props {
  /** Circle to display, or null while nothing is resolved yet (before the
   * first movie is selected, or briefly between an old and new
   * recommendation set settling after a movie/scheme change). */
  circle: WheelCircle | null;
  size: number;
  title?: string;
  overlays?: RecAngle[];
  /** Forwarded to the TOPMOST (newest) layer's Wheel only - see
   * Wheel.tsx's onReadoutHeight doc comment. The outgoing layer's own
   * readout is about to disappear anyway, so only the incoming/current
   * one's height is relevant to a caller doing layout math with it. */
  onReadoutHeight?: (height: number) => void;
}

interface Layer {
  id: number;
  key: string; // "{pc_x}-{pc_y}" - axis-pair identity, not object identity
  circle: WheelCircle;
  size: number;
  title?: string;
  overlays?: RecAngle[];
  visible: boolean;
}

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
}

// Poster tile for the legend's grid layout - same hover/highlight wiring
// as a list row (see LegendTile's callers in WheelLegend), just a
// different visual: a lazily-resolved poster (see utils/poster.ts) with
// a bottom scrim for the title and a corner badge/swatch for the scheme
// angle, instead of a text row.
function LegendTile({ item, angleLabel, swatch, isHighlighted, onEnter, onLeave }: LegendTileProps) {
  const [posterUrl, setPosterUrl] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setPosterUrl(undefined);
    resolvePoster(item.item_id).then((url) => {
      if (!cancelled) setPosterUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [item.item_id]);

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
}

// Legend rows for the big/primary wheel. Hovering a row cross-highlights
// the same movie's point on the wheel/other surfaces (see
// HighlightContext.tsx) and, independently, opens the recommendation
// info card anchored to that row (see contexts/ActiveCardContext.tsx),
// kept clear of the big wheel's own point for this item - the card only
// ever reacts to THIS row's own hover, never to a highlight that
// originated elsewhere, so it can't end up open at the same time as a
// card triggered by a different surface (a list row, a wheel point).
function WheelLegend({ circle, overlays, layout, onToggleLayout }: WheelLegendProps) {
  const cKey = circleKey(circle);
  const { setHighlighted, clearHighlighted } = useHighlight();
  const activeItemId = useHighlightedItem(cKey);
  const { showCard, hideCard, closeCardNow } = useActiveCard();
  const openCardKeyRef = useRef<string | null>(null);

  // Closes this instance's own card (if one of its rows currently has
  // one open) when the instance itself unmounts - e.g. the big wheel
  // crossfading to a different circle while a legend row is still
  // hovered (see WheelStack's crossfade) - so the card never outlives
  // the row it's anchored to.
  useEffect(() => {
    return () => {
      if (openCardKeyRef.current) closeCardNow(openCardKeyRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const populated = overlays?.filter((angle) => angle.items.length > 0) ?? [];
  if (populated.length === 0) return null;

  const bearing = refCompassBearing(circle.z_x, circle.z_y);

  return (
    <div className="wheel-stack__legend" aria-label="Recommendations">
      <div className="wheel-legend__header">
        <LegendLayoutToggle layout={layout} onToggle={onToggleLayout} />
      </div>
      {populated.map((angle) => {
        const swatch = colorOnWheel(
          bearing + angle.angle_deg,
          circle.axis_x.colors.positive,
          circle.axis_x.colors.negative,
          circle.axis_y.colors.positive,
          circle.axis_y.colors.negative
        );
        const angleText = `${Math.round(angle.angle_deg) > 0 ? "+" : ""}${Math.round(angle.angle_deg)}°`;

        return (
          <div className={"rec-angle" + (layout === "grid" ? " rec-angle--grid" : "")} key={angle.angle_deg}>
            <div className={layout === "grid" ? "wheel-legend__tiles" : undefined}>
              {angle.items.map((item, index) => {
                const cardKey = `${cKey}:legend:${item.item_id}`;
                const isHighlighted = activeItemId === item.item_id;

                // Shared by both the list row and the grid tile below -
                // the only thing that actually differs between the two
                // layouts is what's rendered, not the hover/highlight
                // wiring itself.
                const handleEnter = (el: HTMLElement) => {
                  setHighlighted(cKey, item.item_id);
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
                };
                const handleLeave = () => {
                  clearHighlighted(cKey, item.item_id);
                  hideCard(cardKey);
                };

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
      })}
    </div>
  );
}

/**
 * Crossfades between successive wheels instead of swapping them outright.
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
export default function WheelStack({ circle, size, title, overlays, onReadoutHeight }: Props) {
  const [layers, setLayers] = useState<Layer[]>([]);
  const nextId = useRef(0);
  // Shared across every layer (see the crossfade below) so switching
  // list<->grid doesn't reset itself the moment the displayed circle
  // changes.
  const [legendLayout, setLegendLayout] = useState<LegendLayoutMode>("grid");

  useEffect(() => {
    if (!circle) return;
    const key = circleKey(circle);
    setLayers((prev) => {
      if (prev.length > 0 && prev[prev.length - 1].key === key) {
        // Same circle already showing (or mid fade-in) - update its data
        // without starting a new fade.
        const updated = [...prev];
        updated[updated.length - 1] = { ...updated[updated.length - 1], circle, size, title, overlays };
        return updated;
      }
      const id = ++nextId.current;
      return [...prev, { id, key, circle, size, title, overlays, visible: false }];
    });
    // circle/size/title/overlays are fresh objects/arrays every parent
    // render regardless of whether they logically changed - intentional:
    // the branch above makes re-running this a harmless no-op update
    // rather than an extra fade, so depending on primitives only isn't
    // needed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [circle, size, title, overlays]);

  useEffect(() => {
    const pending = layers.find((l) => !l.visible);
    if (!pending) return;
    let cancelled = false;
    // Two rAFs: the layer must actually paint at opacity 0 first, or the
    // browser coalesces the initial and final style and the opacity
    // transition never runs (same reasoning as HeroBackdrop.tsx).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (cancelled) return;
        setLayers((prev) => prev.map((l) => (l.id === pending.id ? { ...l, visible: true } : l)));
      });
    });
    return () => {
      cancelled = true;
    };
  }, [layers]);

  // Once the newest layer has fully faded in, every older layer is
  // completely covered by it - drop them, same cleanup as HeroBackdrop.tsx.
  const handleTransitionEnd = (id: number) => {
    setLayers((prev) => {
      const idx = prev.findIndex((l) => l.id === id);
      if (idx === -1 || idx !== prev.length - 1) return prev;
      return prev.slice(idx);
    });
  };

  if (layers.length === 0) return null;

  return (
    <div className="wheel-stack">
      {layers.map((l, i) => (
        <div
          key={l.id}
          className={"wheel-stack__layer" + (l.visible ? " wheel-stack__layer--visible" : "")}
          onTransitionEnd={() => handleTransitionEnd(l.id)}
        >
          {/* Disc and legend sit side by side in a flex row (see
              .wheel-stack__row in WheelLegend.css) so the legend's width
              is accounted for by normal layout -
              App.tsx's wheel-sizing effect reserves matching column
              width for it. */}
          <div className="wheel-stack__row">
            <div className="wheel-stack__disc-wrap">
              <Wheel
                circle={l.circle}
                size={l.size}
                title={l.title}
                overlays={l.overlays}
                onReadoutHeight={i === layers.length - 1 ? onReadoutHeight : undefined}
              />
              <WheelPointLabels
                circle={l.circle}
                size={l.size}
                title={l.title}
                overlays={l.overlays}
                circleKey={l.key}
              />
            </div>
            <WheelLegend
              circle={l.circle}
              overlays={l.overlays}
              layout={legendLayout}
              onToggleLayout={() => setLegendLayout((m) => (m === "list" ? "grid" : "list"))}
            />
          </div>
        </div>
      ))}
    </div>
  );
}