import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { RecItem, RecommendCircle, toWheelCircle } from "../api";
import { circleKey } from "../utils/circleKey";
import { colorOnWheel } from "../utils/color";
import { imdbUrlForItem } from "../utils/imdb";
import { tmdbUrlForItem } from "../utils/tmdb";
import { useHighlight, useHighlightedItem } from "../contexts/HighlightContext";
import { useActiveCard } from "../contexts/ActiveCardContext";
import { useActiveCircleNav } from "../hooks/useActiveCircleNav";
import Wheel, { RING_PAD } from "./Wheel";
import WheelPointLabels from "./WheelPointLabels";
import "./MovieHighlight.css";

interface Props {
  circles: RecommendCircle[];
  /**
   * Link builder for the IMDb button. Defaults to a direct title-page
   * link when the dataset has a matching imdbId (see
   * tools/filter_metadata_to_artifact.py's --links merge), falling back
   * to an IMDb title search when it doesn't.
   */
  imdbUrlFor?: (item: RecItem) => string;
  /**
   * Link builder for the TMDB button - same direct-link-with-fallback
   * shape as imdbUrlFor, backed by tmdbId instead of imdbId.
   */
  tmdbUrlFor?: (item: RecItem) => string;
  /**
   * Called whenever the active circle changes (via click, arrow keys, or
   * a wheel tick - see useActiveCircleNav) - lets a parent mirror that
   * circle's data into a wheel rendered elsewhere (App.tsx's central
   * wheel). Only fires on the desktop layout, where that wheel actually
   * exists.
   */
  onActiveCircleChange?: (circle: RecommendCircle | null) => void;
}

// Compact label for a scheme angle, shown inside the angle badge on the
// first row of each rec-angle section, e.g. "+30°" / "-120°". Angles are
// always whole numbers (see rotation.ts SCHEMES) and the format itself
// (sign + number + degree symbol) doesn't need localization.
function formatAngle(angleDeg: number): string {
  const rounded = Math.round(angleDeg);
  return `${rounded > 0 ? "+" : ""}${rounded}°`;
}

// Simple hand-drawn "magic wand" glyph - not tied to any specific icon
// library, just a diagonal wand with a sparkle at the tip, matching the
// project's "Get recommendations" action.
function WandIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 20 L14 10" />
      <path d="M16 4 L17.5 7.5 L21 9 L17.5 10.5 L16 14 L14.5 10.5 L11 9 L14.5 7.5 Z" />
      <path d="M19 15 V17" />
      <path d="M18 16 H20" />
    </svg>
  );
}

// Two vertical arrows: pointing toward each other depicts the "stack"
// action, pointing away from each other depicts "unstack" - drawn
// according to the CURRENT layout, i.e. whichever action the button is
// about to perform.
function StackToggleIcon({ unstacked }: { unstacked: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {unstacked ? (
        <>
          <path d="M12 3 V11" />
          <path d="M8.5 7.5 L12 11 L15.5 7.5" />
          <path d="M12 21 V13" />
          <path d="M8.5 16.5 L12 13 L15.5 16.5" />
        </>
      ) : (
        <>
          <path d="M12 11 V3" />
          <path d="M8.5 6.5 L12 3 L15.5 6.5" />
          <path d="M12 13 V21" />
          <path d="M8.5 17.5 L12 21 L15.5 17.5" />
        </>
      )}
    </svg>
  );
}

interface StackToggleButtonProps {
  unstacked: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

// Per-section stack/unstack control (mobile only), sitting at the seam
// between a section's wheel and its own angle-section list so it stays
// reachable while scrolling through a long recommendations list. One
// shared toggle for the whole panel (see the `unstacked` state in
// RecommendationsPanel) - every section renders its own button, but
// they all flip the same layout together. Exact position is CSS-driven
// (see .rec-circle__stack-toggle-icon in index.css): centered in the
// wheel/list overlap band in "peek" mode, in the small gap between
// wheel and list in "stacked" mode.
function StackToggleButton({ unstacked, onClick }: StackToggleButtonProps) {
  const { t } = useTranslation();
  const label = unstacked ? t("recommendations.stackAll") : t("recommendations.unstackAll");
  return (
    <button
      type="button"
      className="rec-circle__stack-toggle-icon"
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      <StackToggleIcon unstacked={unstacked} />
    </button>
  );
}

/**
 * Replaces the old title hyperlink (which navigated the CURRENT tab to
 * this movie as the new reference) - instead opens the same deep link
 * (/{item_id}, see App.tsx's URL sync) in a NEW tab, so browsing
 * recommendations never loses the reference the user is currently
 * looking at.
 */
function GetRecommendationsButton({ itemId, label }: { itemId: number; label: string }) {
  return (
    <button
      type="button"
      className="rec-row__wand"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        window.open(`/${itemId}`, "_blank", "noopener,noreferrer");
      }}
    >
      <WandIcon />
    </button>
  );
}

function LocateIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <line x1="12" y1="2" x2="12" y2="5" />
      <line x1="12" y1="19" x2="12" y2="22" />
      <line x1="2" y1="12" x2="5" y2="12" />
      <line x1="19" y1="12" x2="22" y2="12" />
    </svg>
  );
}

// Mobile-only stand-in for desktop's hover: touch has no hover-enter/leave
// pair, so this button toggles the row's item as highlighted directly
// (see HighlightContext) - lighting up its point on the section's small
// wheel - without ever opening the info card, unlike tapping the row
// itself (which still toggles the card, see RecRow's own onClick).
function LocateButton({
  itemId,
  isActive,
  onActivate,
  onDeactivate,
  label,
}: {
  itemId: number;
  isActive: boolean;
  onActivate: (itemId: number) => void;
  onDeactivate: (itemId: number) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className={"rec-row__locate" + (isActive ? " rec-row__locate--active" : "")}
      title={label}
      aria-label={label}
      aria-pressed={isActive}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (isActive) onDeactivate(itemId);
        else onActivate(itemId);
      }}
    >
      <LocateIcon />
    </button>
  );
}
 
// Prev/next chevron for the desktop panel's edge nav buttons (see
// .rec-panel__nav below) - same stroke style as the mobile info card's
// own prev/next buttons (RecommendationInfoCard.tsx), mirrored for "next".
function PanelNavChevron({ direction }: { direction: "prev" | "next" }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={direction === "next" ? { transform: "scaleX(-1)" } : undefined}
    >
      <path d="M15 5 L8 12 L15 19" />
    </svg>
  );
}

// Big (primary/central) wheel's own point for this item, when one is
// currently rendered there - kept clear of the recommendation info card
// (see RecommendationInfoCard's avoidOverlap). Scoped to
// .layout3__wheel-wrap (App.tsx), the big wheel's unique page-level
// wrapper, so a same-id point on a different wheel (this row's own
// small section wheel, or another section's) is never picked up.
function bigWheelPointRect(itemId: number): DOMRect | undefined {
  return document
    .querySelector<SVGCircleElement>(`.layout3__wheel-wrap [data-point-item-id="${itemId}"]`)
    ?.getBoundingClientRect();
}

interface AngleSectionsProps {
  circle: RecommendCircle;
  cKey: string;
  bearing: number;
  expanded: Set<string>;
  onToggleExpand: (key: string) => void;
  activeCardKey: string | null;
  onCardEnter: (key: string, item: RecItem, el: HTMLElement, list?: RecItem[]) => void;
  onCardLeave: (key: string) => void;
  onCardToggle: (key: string, item: RecItem, el: HTMLElement, list?: RecItem[]) => void;
  imdbUrlFor: (item: RecItem) => string;
  tmdbUrlFor: (item: RecItem) => string;
  showLocate: boolean;
}

// The per-angle rows for one circle - factored out of RecommendationsPanel
// so the exact same list can be dropped into either the default overlay
// layout or the "unstacked" side-by-side/stacked layout without
// duplicating this block.
function AngleSections({
  circle,
  cKey,
  bearing,
  expanded,
  onToggleExpand,
  activeCardKey,
  onCardEnter,
  onCardLeave,
  onCardToggle,
  imdbUrlFor,
  tmdbUrlFor,
  showLocate,
}: AngleSectionsProps) {
  const { t } = useTranslation();
  const { setHighlighted, clearHighlighted } = useHighlight();
  const highlightedItemId = useHighlightedItem(cKey);
  // Thin wrappers so RecRow only needs to report its own item id, not
  // thread the circle's key through every call site.
  const onHighlightEnter = (itemId: number) => setHighlighted(cKey, itemId);
  const onHighlightLeave = (itemId: number) => clearHighlighted(cKey, itemId);

  // Full ordered item list for this circle (every populated angle,
  // flattened) - passed to each row's card trigger so the mobile popup's
  // prev/next buttons (RecommendationInfoCard.tsx) can step through
  // every recommended movie for this circle, not only the ones
  // currently expanded/visible.
  const navigableItems = useMemo(
    () => circle.angles.filter((a) => a.items.length > 0).flatMap((a) => a.items),
    [circle]
  );

  return (
    <>
      {circle.angles
        .filter((a) => a.items.length > 0)
        .map((angle) => {
          const key = `${cKey}-${angle.angle_deg}`;
          const isOpen = expanded.has(key);
          const [top, ...rest] = angle.items;
          const hasMore = rest.length > 0;
          const swatch = colorOnWheel(
            bearing + angle.angle_deg,
            circle.axis_x.colors.positive,
            circle.axis_x.colors.negative,
            circle.axis_y.colors.positive,
            circle.axis_y.colors.negative
          );
          const topCardKey = `${key}:top:${top.item_id}`;
          // The highlighted item is hidden inside this group's collapsed
          // "rest" list - light up the "+N" button as a stand-in for the
          // (currently invisible) row, see MovieHighlight.css.
          const hiddenHighlight = !isOpen && rest.some((it) => it.item_id === highlightedItemId);

          return (
            <div className="rec-angle" key={key}>
              <RecRow
                item={top}
                swatchColor={swatch}
                angleLabel={formatAngle(angle.angle_deg)}
                imdbUrlFor={imdbUrlFor}
                tmdbUrlFor={tmdbUrlFor}
                cardKey={topCardKey}
                isCardOpen={activeCardKey === topCardKey}
                onCardEnter={onCardEnter}
                onCardLeave={onCardLeave}
                onCardToggle={onCardToggle}
                isHighlighted={highlightedItemId === top.item_id}
                onHighlightEnter={onHighlightEnter}
                onHighlightLeave={onHighlightLeave}
                showLocate={showLocate}
                navList={navigableItems}
                trailing={
                  hasMore ? (
                    <button
                      type="button"
                      className={
                        "rec-row__expand" +
                        (isOpen ? " rec-row__expand--open" : "") +
                        (!isOpen && !hiddenHighlight ? " rec-row__expand--pulse" : "") +
                        (hiddenHighlight ? " rec-row__expand--highlighted" : "")
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleExpand(key);
                      }}
                      aria-expanded={isOpen}
                      aria-label={
                        isOpen ? t("recommendations.hide") : t("recommendations.more", { count: rest.length })
                      }
                      title={
                        isOpen ? t("recommendations.hide") : t("recommendations.more", { count: rest.length })
                      }
                    >
                      <span className="rec-row__expand-label">{isOpen ? `+${rest.length}` : `+${rest.length}`}</span>
                      <span
                        className={"rec-row__expand-chevron" + (isOpen ? " rec-row__expand-chevron--open" : "")}
                        aria-hidden="true"
                      >
                        ▾
                      </span>
                    </button>
                  ) : null
                }
              />

              {hasMore && (
                <div className={"rec-more" + (isOpen ? " rec-more--open" : "")}>
                  <div className="rec-more__inner">
                    {rest.map((it) => {
                      const itemCardKey = `${key}:${it.item_id}`;
                      return (
                        <RecRow
                          key={it.item_id}
                          item={it}
                          swatchColor={swatch}
                          imdbUrlFor={imdbUrlFor}
                          tmdbUrlFor={tmdbUrlFor}
                          cardKey={itemCardKey}
                          isCardOpen={activeCardKey === itemCardKey}
                          onCardEnter={onCardEnter}
                          onCardLeave={onCardLeave}
                          onCardToggle={onCardToggle}
                          isHighlighted={highlightedItemId === it.item_id}
                          onHighlightEnter={onHighlightEnter}
                          onHighlightLeave={onHighlightLeave}
                          showLocate={showLocate}
                          navList={navigableItems}
                          compact
                        />
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}
    </>
  );
}

// Default per-section wheel size: fills the available column width (see
// the fillWheelSize ResizeObserver effect below) - used both by the
// default overlay layout (angle-section list drawn over the wheel's
// lower edge) and by the "unstacked" layout on narrow viewports (wheel
// stacked above a full-width list, see .rec-circle__layout in
// index.css). Clamped so it never shrinks below legibility nor grows
// large enough to make a long list of sections unreasonably tall.
const SECTION_WHEEL_MIN = 170;
const SECTION_WHEEL_MAX = 380;
// Fixed small wheel size for the "unstacked" layout on wide viewports,
// where the wheel sits beside the list rather than above/behind it.
const SECTION_WHEEL_UNSTACKED = 140;

// Same bearing math as Wheel.tsx's recPoints: the reference's own compass
// bearing (0 = top/north, clockwise) plus this scheme angle's relative
// rotation, so a recommendation's swatch always matches the color its
// point actually has on the wheel overlay - not an independent palette.
function refCompassBearing(refX: number, refY: number): number {
  return ((Math.atan2(refY, refX) * 180) / Math.PI + 90 + 360) % 360;
}

// Threshold below which the panel switches from the desktop layout
// (wheel beside the list, hover-driven info card) to the mobile one
// (stacked list, tap-driven card as a bottom sheet - see
// RecommendationInfoCard.tsx).
const MOBILE_BREAKPOINT = 640;

export default function RecommendationsPanel({
  circles,
  imdbUrlFor = imdbUrlForItem,
  tmdbUrlFor = tmdbUrlForItem,
  onActiveCircleChange,
}: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const { trigger, showCard, hideCard, closeCardNow, clearCard } = useActiveCard();
  const listRef = useRef<HTMLDivElement>(null);
  const canHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches

  // Only circles that actually turned up at least one recommendation
  // anywhere across their angles are worth showing. Memoized so
  // useActiveCircleNav only re-runs its own effects when `circles`
  // itself changes, not on every render.
  const populated = useMemo(
    () => circles.filter((c) => c.angles.some((a) => a.items.length > 0)),
    [circles]
  );

  // Reactive version of the MOBILE_BREAKPOINT check (resize/orientation
  // change matter here, unlike the one-off canHover capability check
  // above) - drives the section wheel's fill-width sizing below.
  const [isNarrow, setIsNarrow] = useState(() => window.innerWidth <= MOBILE_BREAKPOINT);
  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth <= MOBILE_BREAKPOINT);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Which circle is active (click, arrow keys, wheel-tick, or a
  // hand-dragged scrollbar), keeping its section scrolled into view and
  // mirroring it up via onActiveCircleChange - see useActiveCircleNav
  // for the full scrollspy behavior. Mobile has no notion of an active
  // circle, so it's inert there (activeKey stays null).
  const { activeKey, activateCircle, registerSectionRef, stepActive } = useActiveCircleNav({
    populated,
    isNarrow,
    listRef,
    onActiveCircleChange,
  });

  // Desktop only: whether the edge nav buttons (see .rec-panel__nav
  // below) can step further in each direction - mirrors the clamping
  // stepActive itself already does, just exposed so the buttons can
  // disable themselves at either end instead of silently no-op'ing.
  const activeIndex = populated.findIndex((c) => circleKey(c) === activeKey);
  const canStepPrev = activeIndex > 0;
  const canStepNext = activeIndex === -1 ? populated.length > 1 : activeIndex < populated.length - 1;

  // Mobile-only: whether every section uses the "stacked" layout
  // (list fully below the wheel) instead of the default "peek" layout
  // (list pulled up over the wheel's lower edge). One switch for the
  // whole panel (see .rec-panel__toolbar). The transition itself is a
  // pure CSS animation (see .rec-circle__mobile--peek/--stacked in
  // index.css) - overflow-anchor on the scroll container (also in
  // index.css) is what keeps the user's scroll position visually
  // stable while it plays.
  const [unstacked, setUnstacked] = useState(false);

  // Fill-width sizing for the per-section wheel: measures the
  // scrollable list's own width and sizes the wheel to match it,
  // accounting for RING_PAD (the pole-label ring drawn OUTSIDE the
  // disc) plus a small buffer, so the ring is never clipped. Used by
  // the default overlay layout on every viewport, and by the
  // "unstacked" layout specifically on narrow ones (see
  // .rec-circle__layout in index.css).
  const [fillWheelSize, setFillWheelSize] = useState(SECTION_WHEEL_UNSTACKED);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const apply = (width: number) => {
      const target = Math.floor(width - RING_PAD * 2 - 12);
      setFillWheelSize(Math.max(SECTION_WHEEL_MIN, Math.min(SECTION_WHEEL_MAX, target)));
    };
    apply(el.clientWidth);
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) apply(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Overlap amount for the "peek" layout - how far the list rides up
  // over the wheel's lower edge, as a fraction of the wheel's own
  // current size (fillWheelSize) rather than a fixed pixel constant, so
  // it scales sensibly across viewport widths.
  const wheelPeek = Math.round(fillWheelSize * 0.34);

  // Reset UI state tied to a specific movie/scheme selection.
  useEffect(() => {
    clearCard();
    setUnstacked(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [circles]);

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // --- Hover/tap info card wiring -----------------------------------
  // Hovering a row (desktop) opens the shared card (see
  // contexts/ActiveCardContext.tsx), anchored to the row and kept clear
  // of the big wheel's own point for this item, if one is currently
  // shown there; tapping a row (touch) toggles it open/closed
  // regardless of hover support.
  const openCard = (key: string, item: RecItem, el: HTMLElement, list?: RecItem[]) => {
    if (!canHover) return;
    showCard({
      key,
      item,
      source: "list",
      rect: el.getBoundingClientRect(),
      avoidRect: bigWheelPointRect(item.item_id),
      list,
    });
  };

  const scheduleCloseCard = (key: string) => {
    if (!canHover) return;
    hideCard(key);
  };

  const toggleCard = (key: string, item: RecItem, el: HTMLElement, list?: RecItem[]) => {
    if (trigger?.key === key) {
      closeCardNow(key);
      return;
    }
    showCard({
      key,
      item,
      source: "list",
      rect: el.getBoundingClientRect(),
      avoidRect: bigWheelPointRect(item.item_id),
      list,
    });
  };

  // Scrolling the list invalidates a LIST-sourced card's own captured
  // anchor rect - legend/point-sourced cards live elsewhere on the page
  // and are unaffected by this list's scroll position. Escape and
  // window resize are handled once, globally, by
  // ActiveRecommendationCard.
  useEffect(() => {
    if (!trigger || trigger.source !== "list") return;
    const listEl = listRef.current;
    if (!listEl) return;
    const onScroll = () => closeCardNow(trigger.key);
    listEl.addEventListener("scroll", onScroll, { passive: true });
    return () => listEl.removeEventListener("scroll", onScroll);
  }, [trigger, closeCardNow]);

  if (populated.length === 0) return null;

  return (
    <div className="rec-panel">
      {!isNarrow && (
        <button
          type="button"
          className="rec-panel__nav rec-panel__nav--prev"
          onClick={() => stepActive(-1)}
          disabled={!canStepPrev}
          aria-label={t("recommendations.previous")}
          title={t("recommendations.previous")}
        >
          <PanelNavChevron direction="prev" />
        </button>
      )}
      <div className="rec-panel__list scroll-fade" ref={listRef}>
        {populated.map((circle) => {
          const cKey = circleKey(circle);
          // Desktop: matches whichever circle is currently active (see
          // useActiveCircleNav). Mobile has no notion of an active circle,
          // so it stays the server-provided "primary" flag instead.
          const isPrimaryStyle = isNarrow ? circle.primary : cKey === activeKey;
          const bearing = circle.reference
            ? refCompassBearing(circle.reference.z_x, circle.reference.z_y)
            : 0;
          const wheelCircle = toWheelCircle(circle);

          const angleSections = (
            <AngleSections
              circle={circle}
              cKey={cKey}
              bearing={bearing}
              expanded={expanded}
              onToggleExpand={toggle}
              activeCardKey={trigger?.key ?? null}
              onCardEnter={openCard}
              onCardLeave={scheduleCloseCard}
              onCardToggle={toggleCard}
              imdbUrlFor={imdbUrlFor}
              tmdbUrlFor={tmdbUrlFor}
              showLocate={isNarrow}
            />
          );

          // Desktop: just the small wheel itself, with the same
          // point-label/highlight overlay as the big wheel (see
          // WheelPointLabels) - the per-angle text list is mobile-only
          // (see the stacked branch below).
          if (!isNarrow) {
            return (
              <section
                className={"rec-circle" + (isPrimaryStyle ? " rec-circle--primary" : "")}
                key={cKey}
                ref={(el) => registerSectionRef(cKey, el)}
                onClick={() => activateCircle(cKey)}
              >
                <div className="rec-circle__layout">
                  {wheelCircle && (
                    <div className="rec-circle__wheel">
                      <Wheel circle={wheelCircle} size={SECTION_WHEEL_UNSTACKED} overlays={circle.angles} />
                      <WheelPointLabels
                        circle={wheelCircle}
                        size={SECTION_WHEEL_UNSTACKED}
                        overlays={circle.angles}
                        circleKey={cKey}
                      />
                    </div>
                  )}
                </div>
              </section>
            );
          }

          // Mobile: same DOM in both states, only a modifier class (and
          // --wheel-peek) changes - see .rec-circle__mobile* in
          // index.css for why this needs to stay structurally identical
          // (it's what makes the switch an actual CSS transition). The
          // wheel and its point-label overlay are wrapped together in
          // .rec-circle__mobile-wheel purely so the overlay has a
          // correctly-sized positioned ancestor to anchor to.
          return (
            <section
              className={"rec-circle" + (isPrimaryStyle ? " rec-circle--primary" : "")}
              key={cKey}
            >
              <div
                className={
                  "rec-circle__mobile" +
                  (unstacked ? " rec-circle__mobile--stacked" : " rec-circle__mobile--peek")
                }
                style={{ "--wheel-peek": `${wheelPeek}px` } as CSSProperties}
              >
                {wheelCircle && (
                  <div className="rec-circle__mobile-wheel">
                    <Wheel
                      circle={wheelCircle}
                      size={fillWheelSize}
                      overlays={circle.angles}
                      showReadout={false}
                    />
                    <WheelPointLabels
                      circle={wheelCircle}
                      size={fillWheelSize}
                      overlays={circle.angles}
                      circleKey={cKey}
                    />
                    <StackToggleButton unstacked={unstacked} onClick={(e) => {
                      const timeGap = 300;
                      const clickedButton = e.currentTarget as HTMLElement;
                      const rectBefore = clickedButton.getBoundingClientRect();

                      setUnstacked((v) => !v);

                      setTimeout(() => {
                        requestAnimationFrame(() => {

                          const rectAfter = clickedButton.getBoundingClientRect();
                          const diff = rectAfter.top - rectBefore.top;

                          if (diff !== 0)
                            window.scrollBy(0, diff);
                        });
                      }, timeGap);
                    }} />
                  </div>
                )}
                <div className="rec-circle__mobile-list">{angleSections}</div>
              </div>
            </section>
          );
        })}
      </div>
      {!isNarrow && (
        <button
          type="button"
          className="rec-panel__nav rec-panel__nav--next"
          onClick={() => stepActive(1)}
          disabled={!canStepNext}
          aria-label={t("recommendations.next")}
          title={t("recommendations.next")}
        >
          <PanelNavChevron direction="next" />
        </button>
      )}
    </div>
  );
}

interface RecRowProps {
  item: RecItem;
  swatchColor: string;
  /** Present only on the first row of a rec-angle section - renders a
   * bigger badge with the scheme angle text instead of a plain dot. */
  angleLabel?: string;
  imdbUrlFor: (item: RecItem) => string;
  tmdbUrlFor: (item: RecItem) => string;
  trailing?: ReactNode;
  compact?: boolean;
  cardKey: string;
  isCardOpen: boolean;
  onCardEnter: (key: string, item: RecItem, el: HTMLElement, list?: RecItem[]) => void;
  onCardLeave: (key: string) => void;
  onCardToggle: (key: string, item: RecItem, el: HTMLElement, list?: RecItem[]) => void;
  /** Whether this row's movie is the one currently highlighted - from a
   * hover on this row itself, its wheel point (small or big), or the
   * legend, all scoped to the same circle (see
   * contexts/HighlightContext.tsx). */
  isHighlighted: boolean;
  onHighlightEnter: (itemId: number) => void;
  onHighlightLeave: (itemId: number) => void;
  showLocate?: boolean;
  /** Ordered item list this row belongs to - forwarded into the card
   * trigger for the mobile popup's prev/next navigation. */
  navList?: RecItem[];
}

// A single recommendation row: scheme-angle swatch or badge, title,
// external IMDb/TMDB links, a "get recommendations" button, and an
// optional trailing control (the expand/collapse chevron - only ever
// passed for the top-ranked row of an angle). Each interactive zone is
// its own element, not one big clickable row - the external links, the
// wand button, and the chevron are all independently clickable.
//
// The row as a whole also drives two other things: hovering it opens
// the shared poster/details info card (see RecInfoCard) after a short
// delay window that lets the pointer travel onto the card itself, which
// lives elsewhere in the DOM via a portal; and it marks this row's
// movie as highlighted (see contexts/HighlightContext.tsx), lighting up
// the same movie's point on this circle's wheel and its legend row,
// wherever they're currently shown.
function RecRow({
  item,
  swatchColor,
  angleLabel,
  imdbUrlFor,
  tmdbUrlFor,
  trailing,
  compact,
  cardKey,
  isCardOpen,
  onCardEnter,
  onCardLeave,
  onCardToggle,
  isHighlighted,
  onHighlightEnter,
  onHighlightLeave,
  showLocate,
  navList,
}: RecRowProps) {
  const { t } = useTranslation();
  return (
    <div
      className={
        "rec-row" +
        (compact ? " rec-row--compact" : "") +
        (isCardOpen ? " rec-row--active" : "") +
        (isHighlighted ? " rec-row--highlighted" : "")
      }
      onMouseEnter={(e) => {
        onCardEnter(cardKey, item, e.currentTarget, navList);
        onHighlightEnter(item.item_id);
      }}
      onMouseLeave={() => {
        onCardLeave(cardKey);
        onHighlightLeave(item.item_id);
      }}
      onClick={(e) => onCardToggle(cardKey, item, e.currentTarget, navList)}
    >
      {angleLabel ? (
        <span
          className="rec-row__anglebadge"
          style={{ borderColor: swatchColor, color: swatchColor }}
          aria-hidden="true"
        >
          {angleLabel}
        </span>
      ) : (
        <span
          className="rec-row__swatch"
          style={{ background: swatchColor, color: swatchColor }}
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
      <GetRecommendationsButton itemId={item.item_id} label={t("recommendations.getRecommendations")} />
      {showLocate && (
        <LocateButton
          itemId={item.item_id}
          isActive={isHighlighted}
          onActivate={onHighlightEnter}
          onDeactivate={onHighlightLeave}
          label={t("recommendations.locate")}
        />
      )}
      {trailing}
    </div>
  );
}