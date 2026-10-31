import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import SchemeIcon, { SCHEME_ANGLES } from "./SchemeIcon";
import { supportsHover } from "../utils/hover";
import "./SchemeSelector.css";

interface Props {
  schemes: string[];
  /** Selected scheme, or null when none applies (e.g. a customized target). */
  value: string | null;
  onChange: (scheme: string) => void;
}

const TIP_WIDTH = 240;
const TIP_GAP = 8;
const VIEWPORT_MARGIN = 8;

interface Tip {
  scheme: string;
  /** Anchor button's box at the moment the tip was opened. */
  rect: DOMRect;
}

function formatAngles(scheme: string): string {
  return (SCHEME_ANGLES[scheme] ?? []).map((a) => `${a > 0 ? "+" : ""}${a}°`).join(" · ");
}

// Single-select radio group with every scheme visible at once. Only the
// checked button (the first one when none is checked) is in the tab
// order (roving tabindex); Left/Right move the selection.
// Up/Down are left alone: the page uses them to step through
// circles (see useActiveCircleNav).
export default function SchemeSelector({ schemes, value, onChange }: Props) {
  const { t } = useTranslation();
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [tip, setTip] = useState<Tip | null>(null);
  const tipId = useId();

  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const next = (index + step + schemes.length) % schemes.length;
    onChange(schemes[next]);
    buttonRefs.current[next]?.focus();
  };

  // The anchor rect is captured once, so anything that moves the button
  // closes the tip instead of leaving it behind.
  useEffect(() => {
    if (!tip) return;
    const close = () => setTip(null);
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [tip]);

  const tipLeft = tip
    ? Math.min(
        Math.max(tip.rect.left + tip.rect.width / 2 - TIP_WIDTH / 2, VIEWPORT_MARGIN),
        Math.max(VIEWPORT_MARGIN, window.innerWidth - TIP_WIDTH - VIEWPORT_MARGIN)
      )
    : 0;

  return (
    <>
      <div
        className="scheme-select scroll-fade"
        role="radiogroup"
        aria-label={t("scheme.label")}
        onScroll={() => setTip(null)}
      >
        {schemes.map((scheme, i) => {
          const checked = scheme === value;
          const label = t(`scheme.${scheme}`);
          const show = (el: HTMLElement) => setTip({ scheme, rect: el.getBoundingClientRect() });
          return (
            <button
              key={scheme}
              ref={(el) => {
                buttonRefs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              // The visible label is hidden in the compact header, so the
              // name is stated explicitly rather than derived from content.
              aria-label={label}
              aria-describedby={tip?.scheme === scheme ? tipId : undefined}
              tabIndex={checked || (value === null && i === 0) ? 0 : -1}
              className={"scheme-select__btn" + (checked ? " scheme-select__btn--active" : "")}
              onClick={() => onChange(scheme)}
              onKeyDown={(e) => handleKeyDown(e, i)}
              onMouseEnter={(e) => {
                if (supportsHover()) show(e.currentTarget);
              }}
              onMouseLeave={() => setTip(null)}
              onFocus={(e) => {
                // Keyboard focus only: a mouse click also focuses the button.
                if (e.currentTarget.matches(":focus-visible")) show(e.currentTarget);
              }}
              onBlur={() => setTip(null)}
            >
              <SchemeIcon scheme={scheme} />
              <span className="scheme-select__label" aria-hidden="true">
                {label}
              </span>
            </button>
          );
        })}
      </div>

      {tip &&
        createPortal(
          <div
            id={tipId}
            role="tooltip"
            className="scheme-tip"
            style={
              {
                left: tipLeft,
                top: tip.rect.bottom + TIP_GAP,
                width: TIP_WIDTH,
                "--arrow-x": `${tip.rect.left + tip.rect.width / 2 - tipLeft}px`,
              } as CSSProperties
            }
          >
            <div className="scheme-tip__head">
              <span className="scheme-tip__name">{t(`scheme.${tip.scheme}`)}</span>
              <span className="scheme-tip__angles">{formatAngles(tip.scheme)}</span>
            </div>
            <p className="scheme-tip__text">{t(`scheme.info.${tip.scheme}`)}</p>
          </div>,
          document.body
        )}
    </>
  );
}