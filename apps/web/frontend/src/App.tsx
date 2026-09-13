import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import SearchBar from "./components/SearchBar";
import AppHeader from "./components/AppHeader";
import { RING_PAD, WHEEL_GAP } from "./components/Wheel";
import WheelStack from "./components/WheelStack";
import LanguageSwitcher from "./components/LanguageSwitcher";
import RecommendationsPanel from "./components/RecommendationsPanel";
import AboutModal from "./components/AboutModal";
import HeroBackdrop from "./components/HeroBackdrop";
import { useHeaderMode, ENTER_COMPACT_PX, EXIT_TO_HERO_PX } from "./hooks/useHeaderMode";
import { HighlightProvider } from "./contexts/HighlightContext";
import { ActiveCardProvider } from "./contexts/ActiveCardContext";
import ActiveRecommendationCard from "./components/ActiveRecommendationCard";
import BrandTitle from "./components/BrandTitle";
import {
  MovieHit,
  RecommendCircle,
  RecommendResponse,
  WheelCircle,
  getBackdrop,
  getMovieById,
  getRecommendations,
  getWheelCircles,
  toWheelCircle,
} from "./api";

const SCHEMES = [
  "complementary",
  "triadic",
  "analogous",
  "split-complementary",
  "tetradic",
  "monochromatic",
];

function findRecCircle(circle: WheelCircle, recs: RecommendResponse | null): RecommendCircle | undefined {
  if (!recs) return undefined;
  return recs.circles.find(
    (c) => c.axis_x.pc === circle.axis_x.pc && c.axis_y.pc === circle.axis_y.pc
  );
}

// Matches `@media (max-width: 640px)` in index.css/header.css - below
// this width the app uses its separate, unchanged mobile header instead
// of AppHeader's hero/compact switching (out of scope for mobile for
// now, and the central wheel column
// duplicates what the first Recommendations section already shows.
const WHEEL_WRAP_MOBILE_BREAKPOINT = 640;

// Minimum/maximum pixel size for the main wheel - it fills its column
// (see the ResizeObserver effect below), but is clamped so it never
// shrinks into compact mode (COMPACT_BELOW in Wheel.tsx) nor grows
// absurdly large on very wide screens.
const MIN_WHEEL_SIZE = 260;
// A defensive sanity ceiling only - in practice the real viewport HEIGHT
// (see the sizing effect below) is almost always the binding constraint
// once .layout3__center's own max-width is gone (index.css), so this
// rarely if ever actually clamps anything.
const MAX_WHEEL_SIZE = 1200;
// Gap left between the wheel's readout text and the actual bottom edge
// of the viewport, so it never touches the screen edge.
const WHEEL_BOTTOM_MARGIN = 24;
// Used only until the first real measurement comes in via
// onReadoutHeight below (see Wheel.tsx) - a rough estimate for ~4 short
// lines of text at .wheel__readout's font sizes, just so the very first
// size computation doesn't wildly overshoot before that measurement
// exists.
const READOUT_HEIGHT_FALLBACK = 90;
// Horizontal gap between the wheel disc and its legend, and the
// legend's own max width - see .wheel-stack__row / .wheel-stack__legend
// in WheelLegend.css. Duplicated here (rather than measured) so the
// wheel-sizing effect below can reserve exactly this much extra column
// width up front, instead of the wheel and legend fighting over the
// same pixels once both are laid out.
const WHEEL_LEGEND_GAP = 24;

function legendReserveWidth(): number {
  return Math.min(300, window.innerWidth * 0.28) + WHEEL_LEGEND_GAP;
}

export default function App() {
  const { t, i18n } = useTranslation();
  const [selected, setSelected] = useState<MovieHit | null>(null);
  const [circles, setCircles] = useState<WheelCircle[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [scheme, setScheme] = useState<string>(SCHEMES[2]);
  const [recs, setRecs] = useState<RecommendResponse | null>(null);
  const [recError, setRecError] = useState<string | null>(null);
  // The circle currently active in the Recommendations list (click,
  // arrow keys, or a wheel tick - see RecommendationsPanel.tsx) -
  // mirrored into the big central wheel. Null until that fires (or on
  // mobile, where there is no notion of an active circle); the render
  // below falls back to the top-ranked circle in that case.
  const [activeCircle, setActiveCircle] = useState<RecommendCircle | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [backdropUrl, setBackdropUrl] = useState<string | null>(null);
  // The main wheel is sized to fill the available width of its column
  // (layout3__center) rather than a fixed pixel size, so the two-column
  // Recommendations/wheel split (see index.css, .layout3) makes full use
  // of whichever half of the screen the wheel gets.
  const wheelWrapRef = useRef<HTMLDivElement>(null);
  const wheelColumnRef = useRef<HTMLElement>(null);
  const [wheelSize, setWheelSize] = useState(320);
  const [readoutHeight, setReadoutHeight] = useState(READOUT_HEIGHT_FALLBACK);
  const [isWheelWrapHidden, setIsWheelWrapHidden] = useState(
    () => window.innerWidth <= WHEEL_WRAP_MOBILE_BREAKPOINT
  );

  useEffect(() => {
    const onResize = () => setIsWheelWrapHidden(window.innerWidth <= WHEEL_WRAP_MOBILE_BREAKPOINT);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    document.documentElement.lang = i18n.resolvedLanguage ?? "en";
  }, [i18n.resolvedLanguage]);

  // Desktop-only hero/compact header (see AppHeader.tsx / useHeaderMode.ts).
  const { mode: headerMode, sentinelEnterRef, sentinelExitRef, contentRef, spacerHeight } = useHeaderMode();
  const [headerHeight, setHeaderHeight] = useState(150); // fallback until AppHeader's own ResizeObserver reports
  const stickyControlsRef = useRef<HTMLDivElement>(null);
  const [controlsHeight, setControlsHeight] = useState(0);

  // Publishes the header's and the scheme-selector row's real measured
  // heights as CSS custom properties (see sticky-layout.css's
  // calc()-based `top` offsets) - global on :root rather than scoped to
  // a specific element, since both consuming selectors live in a
  // different part of the tree than either measured element.
  useEffect(() => {
    document.documentElement.style.setProperty("--app-header-height", `${headerHeight}px`);
  }, [headerHeight]);
  useEffect(() => {
    document.documentElement.style.setProperty("--app-controls-height", `${controlsHeight}px`);
  }, [controlsHeight]);

  useEffect(() => {
    const el = stickyControlsRef.current;
    if (!el) return;
    const report = () => setControlsHeight(el.offsetHeight);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The wheel circle currently shown as the big central "primary" wheel,
  // and its recommendation overlays - computed here (rather than lower,
  // next to the render that consumes them) because the sizing effect
  // below also needs to know whether a legend will be drawn beside this
  // circle, to reserve column width for it.
  const displayCircles: WheelCircle[] =
    recs && !recError
      ? recs.circles.map(toWheelCircle).filter((c): c is WheelCircle => c !== null)
      : circles;
  // The big central wheel mirrors whichever Recommendations section is
  // currently scrolled into view (see RecommendationsPanel's scrollspy
  // effect); until that fires - no data yet, or mobile, where it never
  // fires - fall back to the top-ranked circle, same as before.
  const activeWheelCircle = activeCircle ? toWheelCircle(activeCircle) : null;
  const [fallbackPrimary] = displayCircles;
  // Secondary circles no longer render here - they're shown inline next
  // to their matching Recommendations section instead (see
  // RecommendationsPanel.tsx). Only the top-ranked circle stays as the
  // large centered wheel.
  const primary = activeWheelCircle ?? fallbackPrimary ?? null;
  const primaryOverlays = primary ? findRecCircle(primary, recs)?.angles : undefined;
  // Whether WheelStack will actually draw a legend beside the primary
  // wheel (see WheelLegend's own populated-angles check) - the sizing
  // effect below only reserves column width for it when it will.
  const hasLegend = !isWheelWrapHidden && (primaryOverlays?.some((a) => a.items.length > 0) ?? false);
  // True until a reference movie is picked - the very first thing a
  // visitor sees. In this state the header sheds its search bar and the
  // scheme selector entirely; a single, larger search bar takes over as
  // the page's primary call to action (see .wheel-empty-state below).
  const isEmpty = !selected;

  // Sizes the big wheel to fill the available space on BOTH axes while
  // staying fully within the visible viewport, readout text and legend
  // included - see Wheel.tsx (frozen viewBox) and WheelStack.tsx
  // (crossfade, wheel+legend row) for how the result is actually
  // rendered smoothly.
  useEffect(() => {
    if (isWheelWrapHidden) return;
    const wrapEl = wheelWrapRef.current;
    const colEl = wheelColumnRef.current;
    if (!wrapEl || !colEl) return;

    let scheduled = false;
    const recompute = () => {
      scheduled = false;

      const top = wrapEl.getBoundingClientRect().top;
      const availableHeight = window.innerHeight - top - WHEEL_BOTTOM_MARGIN;
      const heightBased = availableHeight - WHEEL_GAP - readoutHeight - RING_PAD * 2;

      // Extra column width reserved for the legend WheelStack draws
      // beside the disc (see .wheel-stack__row in WheelLegend.css) -
      // without this, the column would be sized for the disc alone and
      // the legend would overflow past its right edge once the disc
      // grows large enough to fill the column (e.g. in compact header
      // mode, where more vertical room lets the wheel grow wider).
      const legendReserve = hasLegend ? legendReserveWidth() : 0;

      const heightCapPx =
        Math.max(MIN_WHEEL_SIZE, Math.floor(heightBased)) + RING_PAD * 2 + legendReserve;
      colEl.style.maxWidth = `${heightCapPx}px`;

      // The legend's own reserved width is excluded here too, so the
      // disc itself is sized from whatever's actually left over for it.
      const widthBased = wrapEl.clientWidth - RING_PAD * 2 - legendReserve;

      const target = Math.floor(Math.min(widthBased, heightBased));
      setWheelSize(Math.min(MAX_WHEEL_SIZE, Math.max(MIN_WHEEL_SIZE, target)));
    };

    const onFrame = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(recompute);
    };

    recompute();
    const resizeObserver = new ResizeObserver(onFrame);
    resizeObserver.observe(wrapEl);
    window.addEventListener("resize", onFrame);
    // The element's top can shift from plain page scroll (before it's
    // "stuck", or near the end of its sticky range) AND, now, from the
    // header's own height changing between hero and compact - neither
    // of the two listeners above fires for that second case on its own,
    // which is what headerMode/headerHeight/controlsHeight in the
    // dependency array below are for (they force this whole effect,
    // including its one immediate recompute() call, to re-run right
    // when the header's real geometry changes).
    window.addEventListener("scroll", onFrame, { passive: true });
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", onFrame);
      window.removeEventListener("scroll", onFrame);
      colEl.style.maxWidth = "";
    };
  }, [isWheelWrapHidden, readoutHeight, headerMode, headerHeight, controlsHeight, hasLegend]);

  const fetchRecommendations = async (itemId: number, sch: string) => {
    try {
      const r = await getRecommendations(itemId, sch);
      setRecs(r);
      setRecError(null);
    } catch {
      setRecs(null);
      setRecError(t("recommendations.error"));
    }
  };

  // Decorative only - a failed/slow TMDB lookup must never surface as
  // an app-level error (see errors.wheelLookup / recommendations.error
  // for the errors that DO matter). Fired alongside the wheel/recommend
  // calls in handleSelect, not blocking either of them.
  const fetchBackdrop = async (itemId: number) => {
    try {
      const { backdrop_url } = await getBackdrop(itemId);
      setBackdropUrl(backdrop_url);
    } catch {
      setBackdropUrl(null);
    }
  };

  const handleSelect = async (movie: MovieHit) => {
    setSelected(movie);
    setError(null);
    setRecError(null);
    setRecs(null);
    setActiveCircle(null);
    // A fresh reference means an entirely new Recommendations list -
    // jump back to the top of the page so the list (and the big wheel,
    // which mirrors the list's scroll position) both start from item
    // #1, and the header starts back in "hero" mode, instead of staying
    // wherever the PREVIOUS reference's list happened to be scrolled to.
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    void fetchBackdrop(movie.item_id);
    // Keep the URL in sync with the current reference movie, so it's
    // shareable/bookmarkable and survives a page reload (see the
    // /{item_id} route on the backend and the sync effect below).
    const path = `/${movie.item_id}`;
    if (window.location.pathname !== path) {
      window.history.pushState({}, "", path);
    }
    try {
      const res = await getWheelCircles(movie.item_id);
      setCircles(res.circles);
    } catch {
      setCircles([]);
      setError(t("errors.wheelLookup"));
    }
    await fetchRecommendations(movie.item_id, scheme);
  };

  // Resolve a reference movie from just its item_id - used both for the
  // initial /{item_id} deep link and for clicking a recommendation's
  // title (which only carries an item_id, not a full MovieHit).
  const selectById = async (itemId: number) => {
    try {
      const movie = await getMovieById(itemId);
      await handleSelect(movie);
    } catch {
      setError(t("errors.wheelLookup"));
    }
  };

  // Deep-linking: load the reference movie encoded in the URL (e.g.
  // /567) on first render, and keep it in sync with browser back/forward.
  useEffect(() => {
    const syncFromUrl = () => {
      const match = window.location.pathname.match(/^\/(\d+)$/);
      if (match) {
        void selectById(Number(match[1]));
      } else {
        setSelected(null);
        setCircles([]);
        setRecs(null);
        setRecError(null);
        setError(null);
        setBackdropUrl(null);
        setActiveCircle(null);
      }
    };
    syncFromUrl();
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSchemeChange = (sch: string) => {
    setScheme(sch);
    if (selected) void fetchRecommendations(selected.item_id, sch);
  };

  const schemeSelect = (
    <div className="rec-form">
      <label className="rec-form__label" htmlFor="scheme">
        {t("scheme.label")}
      </label>
      <select
        id="scheme"
        className="rec-form__select"
        value={scheme}
        onChange={(e) => handleSchemeChange(e.target.value)}
      >
        {SCHEMES.map((s) => (
          <option key={s} value={s}>
            {t(`scheme.${s}`)}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <>
      <HighlightProvider>
        <ActiveCardProvider>
          <HeroBackdrop url={backdropUrl} />
          <div className="app">
            {isWheelWrapHidden ? (
              <>
                <div className="topbar">
                  <LanguageSwitcher />
                  <button
                    className="about-trigger"
                    onClick={() => setAboutOpen(true)}
                    aria-label={t("footer.about")}
                  >
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="9.5" />
                      <line x1="12" y1="16.2" x2="12" y2="11.5" />
                      <circle cx="12" cy="7.6" r="1.3" fill="currentColor" stroke="none" />
                    </svg>
                  </button>
                </div>

                <header className="app__header">
                  <div className="app__header-text">
                    <h1><BrandTitle text={t("app.title")} /></h1>
                    <p>{t("app.tagline")}</p>
                    <p className="app__header-poweredby">{t("app.poweredBy")}</p>
                  </div>
                </header>

                <div className="sticky-controls" ref={stickyControlsRef}>
                  {!isEmpty && (
                    <>
                      <SearchBar onSelect={handleSelect} selectedTitle={selected?.title ?? null} selectedMovie={selected} />
                      {schemeSelect}
                    </>
                  )}
                </div>
              </>
            ) : (
              <>
                <span ref={sentinelEnterRef} className="scroll-sentinel" style={{ top: ENTER_COMPACT_PX }} aria-hidden="true" />
                <span ref={sentinelExitRef} className="scroll-sentinel" style={{ top: EXIT_TO_HERO_PX }} aria-hidden="true" />

                <AppHeader
                  mode={headerMode}
                  onAboutClick={() => setAboutOpen(true)}
                  onHeightChange={setHeaderHeight}
                  searchSlot={
                    isEmpty ? undefined : (
                      <SearchBar onSelect={handleSelect} selectedTitle={selected?.title ?? null} selectedMovie={selected} />
                    )
                  }
                  schemeSlot={!isEmpty && headerMode === "compact" ? schemeSelect : undefined}
                />

                <div className="sticky-controls" ref={stickyControlsRef}>
                  {!isEmpty && headerMode !== "compact" && schemeSelect}
                </div>
              </>
            )}

            {error && <div className="app__error">{error}</div>}
            {recError && <div className="app__error">{recError}</div>}

            <div className="layout3" ref={contentRef} style={{ paddingTop: spacerHeight }}>
              {recs && !recError && (
                <aside className="layout3__left">
                  <RecommendationsPanel circles={recs.circles} onActiveCircleChange={setActiveCircle} />
                </aside>
              )}

              <main className="layout3__center" ref={wheelColumnRef}>
                {!isWheelWrapHidden && (
                  <div className="layout3__wheel-wrap" ref={wheelWrapRef}>
                    {primary && (
                      <WheelStack
                        circle={primary}
                        size={wheelSize}
                        title={selected?.title}
                        overlays={primaryOverlays}
                        onReadoutHeight={setReadoutHeight}
                      />
                    )}
                  </div>
                )}
              </main>
            </div>

            <footer className="app__footer app__footer--slim">
              <p>
                {t("footer.copyright", { year: new Date().getFullYear() })}
                {" · "}
                <button onClick={() => setAboutOpen(true)}>{t("footer.about")}</button>
              </p>
            </footer>

            <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />
          </div>
          {/* Fixed to the viewport (see .wheel-empty-state in index.css) -
              independent of the desktop/mobile layout split above, shown
              on both until a reference movie is selected. */}
          {!primary && (
            <div className="wheel-empty-state">
              <img className="wheel-empty-state__logo" src="/logo-mark.svg" alt="" aria-hidden="true" />
              {isEmpty && (
                <div className="wheel-empty-state__search">
                  <SearchBar onSelect={handleSelect} selectedTitle={null} selectedMovie={null} />
                </div>
              )}
            </div>
          )}
          <ActiveRecommendationCard />
        </ActiveCardProvider>
      </HighlightProvider>
    </>
  );
}
