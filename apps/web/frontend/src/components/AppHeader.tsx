import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import LanguageSwitcher from "./LanguageSwitcher";
import type { HeaderMode } from "../hooks/useHeaderMode";
import BrandTitle from "./BrandTitle";

interface Props {
  mode: HeaderMode;
  searchSlot: ReactNode;
  /** Color-scheme selector - only passed (and rendered) in compact mode;
   * in hero mode it's rendered separately below the header (see
   * App.tsx's `sticky-controls`). */
  schemeSlot?: ReactNode;
  onAboutClick: () => void;
  /** Reports this header's own real rendered height via ResizeObserver -
   * see App.tsx, which turns it into a CSS custom property consumed by
   * the sticky offsets below it (.sticky-controls, .layout3__center -
   * see sticky-layout.css). Necessary because the header's actual height
   * differs between hero and compact and changes discretely at the
   * moment the mode flips. */
  onHeightChange: (height: number) => void;
}

// A SINGLE, persistent DOM structure with two CSS variants toggled by a
// modifier class - deliberately NOT two different JSX subtrees switched
// by `mode`. Branching the JSX would remount `searchSlot`'s <SearchBar>
// on every hero<->compact switch (a different position in the React
// tree, even with the same component type, forces React to unmount +
// remount) - losing its internal query/focus/dropdown-open state on
// every scroll-triggered mode change, which would be jarring mid-typing.
// The visual hero<->compact change itself is handled entirely by
// document.startViewTransition (see useHeaderMode.ts) rather than a CSS
// transition on individual layout properties - see header.css's top
// comment for why plain CSS transitions can't do this reflow on their
// own regardless.
export default function AppHeader({ mode, searchSlot, schemeSlot, onAboutClick, onHeightChange }: Props) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const report = () => onHeightChange(el.offsetHeight);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={rootRef}
      className={"appheader" + (mode === "compact" ? " appheader--compact" : "")}
    >
      <div className="appheader__brand vt-brand">
        <div className="appheader__brand-text">
          <h1 className="appheader__title">
            <BrandTitle text={t("app.title")} />
          </h1>
          <p className="appheader__tagline">{t("app.tagline")}</p>
          <p className="appheader__poweredby">{t("app.poweredBy")}</p>
        </div>
      </div>

      {searchSlot && <div className="appheader__search vt-search">{searchSlot}</div>}

      <div className="appheader__actions">
        {schemeSlot && <div className="appheader__scheme">{schemeSlot}</div>}
      </div>

      <div className="appheader__actions">
        <div className="appheader__lang vt-lang">
          <LanguageSwitcher />
        </div>

        <button
          type="button"
          className="appheader__about vt-about"
          onClick={onAboutClick}
          aria-label={t("footer.about")}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9.5" />
            <line x1="12" y1="16.2" x2="12" y2="11.5" />
            <circle cx="12" cy="7.6" r="1.3" fill="currentColor" stroke="none" />
          </svg>
        </button>
      </div>
    </div>
  );
}