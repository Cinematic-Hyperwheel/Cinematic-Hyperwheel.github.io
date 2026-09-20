import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { CardTrigger } from "../contexts/ActiveCardContext";
import { imdbUrlForItem } from "../utils/imdb";
import { tmdbUrlForItem } from "../utils/tmdb";
import { resolvePoster } from "../utils/poster";
import "./RecommendationInfoCard.css";

const CARD_WIDTH = 300;
const CARD_MAX_HEIGHT = 360;
const VIEWPORT_MARGIN = 8;
const MOBILE_BREAKPOINT = 640;
// Vertical clearance kept between the card and an avoided rect (the big
// wheel's own point for this item) - a separate constant from
// VIEWPORT_MARGIN since this gap is against another UI element, not the
// viewport edge.
const AVOID_GAP = 50;

function computeLeft(rect: DOMRect): number {
  let left = rect.right + 12;
  if (left + CARD_WIDTH > window.innerWidth - VIEWPORT_MARGIN) {
    left = rect.left - CARD_WIDTH - 12;
  }
  return Math.min(
    Math.max(left, VIEWPORT_MARGIN),
    Math.max(VIEWPORT_MARGIN, window.innerWidth - CARD_WIDTH - VIEWPORT_MARGIN)
  );
}

// Row-level position, clamped to stay fully inside the viewport given
// the card's actual height.
function naturalTop(rect: DOMRect, cardHeight: number): number {
  const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - cardHeight - VIEWPORT_MARGIN);
  return Math.min(Math.max(rect.top, VIEWPORT_MARGIN), maxTop);
}

// Vertical-only nudge clear of avoidRect (the trigger's associated
// point on the big/primary wheel - see contexts/ActiveCardContext.tsx),
// sized from the card's OWN actually rendered height rather than its
// CSS max-height: the card is usually shorter than that max (no
// genres/meta line, short title, etc.), so using the real height keeps
// the shift the minimum distance actually needed instead of
// overshooting into space the card never uses.
function avoidOverlap(top: number, cardHeight: number, avoidRect: DOMRect): number {
  const avoidTop = avoidRect.top - AVOID_GAP;
  const avoidBottom = avoidRect.bottom + AVOID_GAP;
  const overlaps = top < avoidBottom && top + cardHeight > avoidTop;
  if (!overlaps) return top;

  const minTop = VIEWPORT_MARGIN;
  const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - cardHeight - VIEWPORT_MARGIN);
  const aboveTop = avoidTop - cardHeight;
  const belowTop = avoidBottom;
  const aboveValid = aboveTop >= minTop;
  const belowValid = belowTop <= maxTop;

  // Prefer whichever valid side needs the smaller shift from the
  // natural position; a candidate that wouldn't fit the viewport is
  // never chosen, so the card can't be pushed back into the point by a
  // later clamp.
  if (aboveValid && belowValid) {
    return Math.abs(aboveTop - top) <= Math.abs(belowTop - top) ? aboveTop : belowTop;
  }
  if (aboveValid) return aboveTop;
  if (belowValid) return belowTop;
  return top; // neither fits (viewport shorter than the card) - keep natural position
}

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

// Chevron used for the mobile sheet's prev/next buttons - same hand-drawn
// stroke style as the app's other small icons, mirrored for "next".
function ChevronIcon({ direction }: { direction: "prev" | "next" }) {
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

interface RecInfoCardProps {
  target: CardTrigger;
  onClose: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  allowUnderlyingInteraction?: boolean;
}

export default function RecommendationInfoCard({
  target,
  onClose,
  onMouseEnter,
  onMouseLeave,
  allowUnderlyingInteraction = false,
}: RecInfoCardProps) {
  const { t } = useTranslation();
  const [posterUrl, setPosterUrl] = useState<string | null | undefined>(undefined);
  const mobile = typeof window !== "undefined" && window.innerWidth <= MOBILE_BREAKPOINT;
  const cardRef = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(() => naturalTop(target.rect, CARD_MAX_HEIGHT));

  // Prev/next navigation within the triggering row's own item list
  // (mobile only - see the nav buttons below, and CardTrigger.list).
  // Navigating only moves this LOCAL pointer - it never re-fires
  // showCard, so it doesn't affect which row elsewhere on the page
  // reads as "active" for the originally tapped item.
  const list = target.list;
  const [navIndex, setNavIndex] = useState(() =>
    list ? Math.max(0, list.findIndex((it) => it.item_id === target.item.item_id)) : 0
  );
  useEffect(() => {
    // Reset only when a genuinely different card is opened - target.key
    // stays constant across the buttons' own navIndex changes.
    setNavIndex(list ? Math.max(0, list.findIndex((it) => it.item_id === target.item.item_id)) : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.key]);
  const displayItem = list?.[navIndex] ?? target.item;

  useEffect(() => {
    let cancelled = false;
    setPosterUrl(undefined);
    resolvePoster(displayItem.item_id).then((url) => {
      if (!cancelled) setPosterUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [displayItem.item_id]);

  // Recomputes the vertical position from the card's actual rendered
  // height (via cardRef) whenever the trigger changes - runs before
  // paint, so there's no visible jump between the natural and
  // avoidance-corrected position.
  useLayoutEffect(() => {
    if (mobile) return;
    const cardHeight = cardRef.current?.offsetHeight ?? CARD_MAX_HEIGHT;
    let nextTop = naturalTop(target.rect, cardHeight);
    if (target.avoidRect) nextTop = avoidOverlap(nextTop, cardHeight, target.avoidRect);
    setTop(nextTop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.key, mobile]);

  // Vertical center of the mobile sheet card, in viewport coordinates -
  // used to position the fixed prev/next buttons level with it. A
  // ResizeObserver (rather than a one-off measurement) keeps this
  // correct as the card's height changes: navigating items, the poster
  // loading, or a longer/shorter title all resize it.
  const [navTop, setNavTop] = useState<number | null>(null);
  const [cardTop, setCardTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!mobile) return;
    const el = cardRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setNavTop(rect.top + rect.height / 2);
      setCardTop(rect.top);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [mobile]);

  const isTile = !mobile && target.cardStyle === "tile";
  const extraRef = useRef<HTMLDivElement>(null);
  // Which side the compact panel grows toward. Defaults to "down"; a
  // layout effect (pre-paint) flips it to "up" if there isn't room
  // below, so the poster's own on-screen position never has to be
  // guessed before the panel's real height is known.
  const [growDirection, setGrowDirection] = useState<"down" | "up">("down");

  useLayoutEffect(() => {
    if (!isTile) return;
    setGrowDirection("down");
  }, [isTile, target.key]);

  useLayoutEffect(() => {
    if (!isTile) return;
    const extraEl = extraRef.current;
    if (!extraEl) return;
    const extraHeight = extraEl.offsetHeight;
    const spaceBelow = window.innerHeight - target.rect.bottom - VIEWPORT_MARGIN;
    const spaceAbove = target.rect.top - VIEWPORT_MARGIN;
    if (extraHeight > spaceBelow && spaceAbove >= extraHeight) setGrowDirection("up");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTile, target.key, displayItem.genres.length]);

  const style: CSSProperties | undefined = mobile
    ? undefined
    : { position: "fixed", left: computeLeft(target.rect), top, width: CARD_WIDTH };

    if (isTile) {
  const posterBlock = (
    <div className="rec-card--tile__poster" style={{ height: target.rect.height }}>
      {posterUrl === undefined && (
        <div className="rec-card__poster rec-card__poster--loading" aria-hidden="true" />
      )}
      {posterUrl && <img className="rec-card__poster" src={posterUrl} alt="" loading="lazy" />}
      {posterUrl === null && <div className="rec-card__poster" aria-hidden="true" />}
      <div className="rec-card--tile__scrim" aria-hidden="true" />
      {target.tileAngleLabel ? (
        <span
          className="rec-card--tile__badge"
          style={{ borderColor: target.tileSwatch, color: target.tileSwatch }}
        >
          {target.tileAngleLabel}
        </span>
      ) : (
        <span
          className="rec-card--tile__swatch"
          style={{ background: target.tileSwatch, color: target.tileSwatch }}
          aria-hidden="true"
        />
      )}
      <span className="rec-card--tile__title">{displayItem.title}</span>
    </div>
  );

  const extraBlock = (
    <div ref={extraRef} className="rec-card--tile__extra">
      {displayItem.genres.length > 0 && (
        <div className="rec-card__genres">
          {displayItem.genres.map((g) => (
            <span key={g} className="card__genre-badge">
              {g}
            </span>
          ))}
        </div>
      )}
      <div className="rec-card__links">
        <a
          className="rec-row__extlink rec-row__extlink--imdb"
          href={imdbUrlForItem(displayItem)}
          target="_blank"
          rel="noopener noreferrer"
        >
          IMDb
        </a>
        <a
          className="rec-row__extlink rec-row__extlink--tmdb"
          href={tmdbUrlForItem(displayItem)}
          target="_blank"
          rel="noopener noreferrer"
        >
          TMDB
        </a>
        <GetRecommendationsButton
          itemId={displayItem.item_id}
          label={t("recommendations.getRecommendations")}
        />
      </div>
    </div>
  );

  // "down": container's top edge = tile's top edge (poster is the
  // first child, so it lands exactly on the tile, unmoved); "up":
  // container's bottom edge = tile's bottom edge (poster is the last
  // child, so it still lands exactly on the tile) - either way the
  // poster's own screen position never depends on the extra content's
  // height, only which edge the container is anchored from.
  const tileStyle: CSSProperties =
    growDirection === "down"
      ? { left: target.rect.left, top: target.rect.top, width: target.rect.width }
      : { left: target.rect.left, bottom: window.innerHeight - target.rect.bottom, width: target.rect.width };

  return createPortal(
    <div className="rec-card__backdrop" onClick={onClose}>
      <div
        className="rec-card--tile"
        style={tileStyle}
        onClick={(e) => e.stopPropagation()}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        {growDirection === "down" ? (
          <>
            {posterBlock}
            {extraBlock}
          </>
        ) : (
          <>
            {extraBlock}
            {posterBlock}
          </>
        )}
      </div>
    </div>,
    document.body
  );
}

  return createPortal(
    <div
      className={
        "rec-card__backdrop" +
        (mobile ? " rec-card__backdrop--sheet" : "") +
        (allowUnderlyingInteraction ? " rec-card__backdrop--nonblocking" : "")
      }
      onClick={allowUnderlyingInteraction ? undefined : onClose}
    >
      <div
        ref={cardRef}
        className={"rec-card" + (mobile ? " rec-card--sheet" : " rec-card--anchored")}
        style={style}
        onClick={(e) => e.stopPropagation()}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        {!mobile && <button
          type="button"
          className="rec-card__close"
          onClick={onClose}
          aria-label={t("recommendations.close")}
        >
          ✕
        </button>}
        <div className="rec-card__body">
          {posterUrl === undefined && (
            <div className="rec-card__poster rec-card__poster--loading" aria-hidden="true" />
          )}
          {posterUrl && (
            <img className="rec-card__poster" src={posterUrl} alt={displayItem.title} loading="lazy" />
          )}
          <div className="rec-card__info">
            <div className="rec-card__title-row">
              <span className="rec-card__title">{displayItem.title}</span>
            </div>
            {displayItem.genres.length > 0 && (
              <div className="rec-card__genres">
                {displayItem.genres.map((g) => (
                  <span key={g} className="card__genre-badge">
                    {g}
                  </span>
                ))}
              </div>
            )}
            <div className="rec-card__links">
              <a
                className="rec-row__extlink rec-row__extlink--imdb"
                href={imdbUrlForItem(displayItem)}
                target="_blank"
                rel="noopener noreferrer"
              >
                IMDb
              </a>
              <a
                className="rec-row__extlink rec-row__extlink--tmdb"
                href={tmdbUrlForItem(displayItem)}
                target="_blank"
                rel="noopener noreferrer"
              >
                TMDB
              </a>
              <GetRecommendationsButton
                itemId={displayItem.item_id}
                label={t("recommendations.getRecommendations")}
              />
            </div>
          </div>
        </div>
      </div>

      {mobile && list && list.length > 1 && navTop !== null && (
        <>
          <button
            type="button"
            className="rec-card__nav rec-card__nav--close"
            style={{ top: cardTop ?? 'auto' }}
            onClick={onClose}
            aria-label={t("recommendations.close")}
          >
            ✕
          </button>
          <button
            type="button"
            className="rec-card__nav rec-card__nav--prev"
            style={{ top: navTop }}
            onClick={(e) => {
              e.stopPropagation();
              setNavIndex((i) => Math.max(0, i - 1));
            }}
            disabled={navIndex === 0}
            aria-label={t("recommendations.previous")}
            title={t("recommendations.previous")}
          >
            <ChevronIcon direction="prev" />
          </button>
          <button
            type="button"
            className="rec-card__nav rec-card__nav--next"
            style={{ top: navTop }}
            onClick={(e) => {
              e.stopPropagation();
              setNavIndex((i) => Math.min(list.length - 1, i + 1));
            }}
            disabled={navIndex === list.length - 1}
            aria-label={t("recommendations.next")}
            title={t("recommendations.next")}
          >
            <ChevronIcon direction="next" />
          </button>
        </>
      )}
    </div>,
    document.body
  );
}