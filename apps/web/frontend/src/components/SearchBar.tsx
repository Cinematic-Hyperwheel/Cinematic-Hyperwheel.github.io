import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MovieHit, Span, getRandomMovie, searchMovies } from "../api";
import { imdbUrlForItem } from "../utils/imdb";
import { tmdbUrlForItem } from "../utils/tmdb";
import { resolvePoster } from "../utils/poster";
import "./SearchBar.css";

interface Props {
  onSelect: (movie: MovieHit) => void;
  /**
   * Title of the currently selected reference movie, if any. Keeps the
   * input in sync when the reference changes through a path other than
   * this search box itself - e.g. clicking a recommendation's title, or
   * loading a deep-linked /{item_id} URL.
   */
  selectedTitle?: string | null;
  selectedMovie?: MovieHit | null;
}

// Renders `text` with the given character spans wrapped in <mark>.
// Spans come pre-computed from the backend - the client just paints the
// ranges it's given.
function renderHighlighted(text: string, spans: Span[]) {
  if (!text || spans.length === 0) return text;
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  sorted.forEach(([start, end], i) => {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <mark key={i} className="search__hl">
        {text.slice(start, end)}
      </mark>
    );
    cursor = end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function SearchIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="6.5" />
      <line x1="16" y1="16" x2="21" y2="21" />
    </svg>
  );
}

// "Surprise me" trigger - a magician's hat with a pair of rabbit ears
// peeking out and a sparkle, standing in for "pull a random movie out
// of the catalog" the way a rabbit is pulled out of a hat.
function MagicHatIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <ellipse cx="12" cy="18.4" rx="8" ry="2.1" />
      <path d="M6.8 18 L8.2 8.6 A4 3.4 0 0 1 15.8 8.6 L17.2 18" />
      <path d="M10.2 8.6 C9.4 5.6 9.8 3.4 10.8 2" />
      <path d="M13.4 8.6 C13.7 5.3 13.3 3.1 12.4 1.7" />
      <path d="M19 4.2 L19.5 5.7 L21 6.2 L19.5 6.7 L19 8.2 L18.5 6.7 L17 6.2 L18.5 5.7 Z" />
    </svg>
  );
}

interface RandomMovieButtonProps {
  onClick: () => void;
  spinning: boolean;
  label: string;
}

function RandomMovieButton({ onClick, spinning, label }: RandomMovieButtonProps) {
  return (
    <button
      type="button"
      className={"search__random" + (spinning ? " search__random--spinning" : "")}
      onClick={onClick}
      disabled={spinning}
      aria-label={label}
      aria-busy={spinning}
      title={label}
    >
      <MagicHatIcon />
    </button>
  );
}

// Characters used for the "reel" scramble animation while a random pick
// is in flight/resolving - kept language-neutral (not real words) so
// the effect looks the same regardless of UI language.
const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
function randomScrambleChar(): string {
  return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
}

const SPIN_PLACEHOLDER_LENGTH = 18;
const SPIN_FRAME_MS = 45;
// Minimum time spent visibly "spinning" before revealing the pick, so a
// fast response doesn't make the button feel like it did nothing.
const SPIN_MIN_DURATION_MS = 500;
// Per-character stagger for the reveal phase - each letter/digit locks
// into place a little later than the one before it, left to right.
const REVEAL_STAGGER_MS = 18;

export default function SearchBar({ onSelect, selectedTitle = null, selectedMovie = null }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MovieHit[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(selectedMovie == null);
  const [spinning, setSpinning] = useState(false);
  // Poster thumbnail for the currently selected reference movie -
  // undefined while loading/unresolved, null once resolved to "no
  // poster available" (see utils/poster.ts).
  const [posterUrl, setPosterUrl] = useState<string | null | undefined>(undefined);
  const debounceRef = useRef<number | undefined>(undefined);
  // Monotonically increasing id per fired request, so that when
  // several searches are in flight at once (typing faster than the
  // debounce window lets them settle), a late-arriving response for an
  // OLDER keystroke can be detected and dropped instead of clobbering
  // the results of a newer one that already resolved - this is what was
  // causing the "flicker" of stale result sets while typing fast.
  const requestIdRef = useRef(0);
  // Sentinel query value we just set programmatically (on select),
  // so the search effect can recognize "this change came from picking a
  // result, not from typing" and skip re-searching/reopening for it.
  const suppressNextSearchRef = useRef<string | null>(null);
  // Interval driving the random-pick "reel" animation (scramble, then
  // character-by-character reveal) - see runRandomPick/revealTitle.
  const spinTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => window.clearInterval(spinTimerRef.current);
  }, []);

  // Keep the input in sync with the reference movie set externally (a
  // recommendation title click, or a deep-linked /{item_id} URL) - those
  // paths never touch this component's own query state, so without this
  // the box would keep showing whatever was last typed/picked here.
  useEffect(() => {
    if (selectedTitle == null || selectedTitle === query) return;
    suppressNextSearchRef.current = selectedTitle;
    setQuery(selectedTitle);
    setOpen(false);
    setEditing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTitle]);

  useEffect(() => {
    if (selectedMovie) {
      setQuery(selectedMovie.title);
      setEditing(false);
    } else {
      setEditing(true);
    }
  }, [selectedMovie?.item_id, selectedMovie?.title]);

  // Poster thumbnail for the reference card - same lazy, cached lookup
  // as the recommendation hover/tap info card (see utils/poster.ts).
  // Kept independent of `editing`, so it stays visible under the input
  // while the user is retyping a new query but hasn't picked yet.
  useEffect(() => {
    if (!selectedMovie) {
      setPosterUrl(undefined);
      return;
    }
    let cancelled = false;
    setPosterUrl(undefined);
    resolvePoster(selectedMovie.item_id).then((url) => {
      if (!cancelled) setPosterUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedMovie?.item_id]);

  useEffect(() => {
    window.clearTimeout(debounceRef.current);

    // If this exact query value was just set by handleSelect below,
    // consume the flag and skip firing a search for it - otherwise the
    // debounced search resolves ~250ms+ after selection and calls
    // setOpen(true) again, making the dropdown pop back open on its own.
    if (suppressNextSearchRef.current === query) {
      suppressNextSearchRef.current = null;
      return;
    }

    if (query.trim().length < 2 || !editing) {
      setResults([]);
      return;
    }
    debounceRef.current = window.setTimeout(async () => {
      const myRequestId = ++requestIdRef.current;
      try {
        const hits = await searchMovies(query);
        // A newer request was fired (and possibly already resolved)
        // while this one was in flight - discard this stale response.
        if (myRequestId !== requestIdRef.current) return;
        setResults(hits);
        setOpen(true);
      } catch {
        if (myRequestId !== requestIdRef.current) return;
        setResults([]);
      }
    }, 250);
    return () => window.clearTimeout(debounceRef.current);
  }, [query, editing]);

  const handleSelect = (r: MovieHit) => {
    onSelect(r);
    // Mark the upcoming query change as "programmatic" before
    // triggering it, so the effect above ignores it.
    suppressNextSearchRef.current = r.title;
    setQuery(r.title);
    setEditing(false);
    setOpen(false);
  };

  const beginEditing = () => {
    suppressNextSearchRef.current = query;
    setEditing(true);
    requestAnimationFrame(() => {
      document.getElementById("reference-search-input")?.focus();
      (document.getElementById("reference-search-input") as HTMLInputElement | null)?.select();
    });
  };

  const cancelEditing = () => {
    setEditing(false);
    setQuery(selectedMovie?.title ?? query);
    setResults([]);
    setOpen(false);
  };

  // Reveal phase of the random-pick animation: characters lock into
  // their final position one by one, left to right, each after its own
  // randomized delay, while the rest keep flickering. Punctuation/spaces
  // are left alone throughout - scrambling them adds noise without
  // adding to the effect.
  const revealTitle = (title: string) =>
    new Promise<void>((resolve) => {
      const chars = title.split("");
      const lockAt = chars.map((ch, i) =>
        /[a-zA-Z0-9]/.test(ch) ? i * REVEAL_STAGGER_MS + Math.random() * REVEAL_STAGGER_MS * 2 : 0
      );
      const duration = Math.max(0, ...lockAt) + 220;
      const start = Date.now();

      window.clearInterval(spinTimerRef.current);
      spinTimerRef.current = window.setInterval(() => {
        const elapsed = Date.now() - start;
        setQuery(chars.map((ch, i) => (elapsed >= lockAt[i] ? ch : randomScrambleChar())).join(""));
        if (elapsed >= duration) {
          window.clearInterval(spinTimerRef.current);
          setQuery(title);
          resolve();
        }
      }, SPIN_FRAME_MS);
    });

  // "Surprise me": picks a random movie from the whole catalog. Plays a
  // brief slot-machine-style animation in the input itself (fast
  // character scramble while the pick is in flight, then a left-to-right
  // reveal once it's known) before actually selecting it, via the same
  // handleSelect() path a normal search-result click uses.
  const runRandomPick = async () => {
    if (spinning) return;
    setSpinning(true);
    setEditing(true);
    setOpen(false);
    setResults([]);
    // Invalidate any in-flight typed search so its response can't land
    // (and reopen the dropdown) once the animation is done.
    requestIdRef.current += 1;

    const startedAt = Date.now();
    window.clearInterval(spinTimerRef.current);
    spinTimerRef.current = window.setInterval(() => {
      setQuery(Array.from({ length: SPIN_PLACEHOLDER_LENGTH }, randomScrambleChar).join(""));
    }, SPIN_FRAME_MS);

    let movie: MovieHit | null = null;
    try {
      movie = await getRandomMovie();
    } catch {
      movie = null;
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed < SPIN_MIN_DURATION_MS) {
      await new Promise((resolve) => window.setTimeout(resolve, SPIN_MIN_DURATION_MS - elapsed));
    }

    if (!movie) {
      window.clearInterval(spinTimerRef.current);
      setSpinning(false);
      if (selectedMovie) {
        setQuery(selectedMovie.title);
        setEditing(false);
      } else {
        setQuery("");
      }
      return;
    }

    await revealTitle(movie.title);
    setSpinning(false);
    handleSelect(movie);
  };

  const randomLabel = t("search.random");

  const renderSelectedContent = () => (
    <div className="search__selected">
      {editing ? (
        <div className="search__editor">
          {!selectedMovie && (
            <span className="search__leading-icon" aria-hidden="true">
              <SearchIcon />
            </span>
          )}
          <input
            id="reference-search-input"
            className={
              "search__input search__selected-input" +
              (spinning ? " search__selected-input--spinning" : "") +
              (!selectedMovie ? " search__selected-input--with-icon" : "")
            }
            placeholder={t("search.placeholder")}
            value={query}
            readOnly={spinning}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={(e) => {
              if (spinning) return;
              // Select-all on focus, so clicking/tabbing into an already-filled
              // field (e.g. after picking a result) lets the user immediately
              // retype instead of having to manually clear it first.
              e.target.select();
              if (results.length) setOpen(true);
            }}
            onBlur={() => {
              if (spinning) return;
              window.setTimeout(() => {
                setOpen(false);
                if (!selectedMovie) return;
                if (document.activeElement?.closest(".search__editor")) return;
                cancelEditing();
              }, 150);
            }}
            onKeyDown={(e) => {
              if (spinning) return;
              if (e.key === "Escape" && selectedMovie) {
                e.preventDefault();
                cancelEditing();
              }
            }}
          />
          <RandomMovieButton onClick={runRandomPick} spinning={spinning} label={randomLabel} />
          {open && results.length > 0 && (
            <ul className="search__results">
              {results.map((r) => (
                <li
                  key={r.item_id}
                  className="search__result"
                  onMouseDown={() => handleSelect(r)}
                >
                  <div className="search__result-main">
                    <span className="search__title">
                      {renderHighlighted(r.title, r.titleHighlights)}
                    </span>
                  </div>
                  {/* Genres are shown but never highlighted - they aren't
                      part of the match, only the title is (see search.py). */}
                  {r.genres.length > 0 && (
                    <div className="search__genres">
                      {r.genres.map((g) => (
                        <span key={g} className="search__genre-badge">
                          {g}
                        </span>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <>
          <button
            type="button"
            className="search__selected-title"
            onClick={beginEditing}
            aria-label={t("search.placeholder")}
          >
            {selectedMovie?.title ?? query}
          </button>
          <button
            type="button"
            className="search__selected-search"
            onClick={beginEditing}
            aria-label={t("search.placeholder")}
            title={t("search.placeholder")}
          >
            <SearchIcon />
          </button>
          <RandomMovieButton onClick={runRandomPick} spinning={spinning} label={randomLabel} />
        </>
      )}
      {selectedMovie && (
        <div className="search__selected-meta">
          {selectedMovie.genres.length > 0 ? (
            <div className="search__selected-genres">
              {selectedMovie.genres.map((g) => (
                <span key={g} className="card__genre-badge">
                  {g}
                </span>
              ))}
            </div>
          ) : (
            <span className="search__selected-genres-empty">
              {t("card.genres")}: {t("card.unknown")}
            </span>
          )}
          <div className="search__selected-links">
            <a
              className="rec-row__extlink rec-row__extlink--imdb"
              href={imdbUrlForItem({ imdb_id: selectedMovie.imdb_id ?? null, title: selectedMovie.title })}
              target="_blank"
              rel="noopener noreferrer"
            >
              IMDb
            </a>
            <a
              className="rec-row__extlink rec-row__extlink--tmdb"
              href={tmdbUrlForItem({ tmdb_id: selectedMovie.tmdb_id ?? null, title: selectedMovie.title })}
              target="_blank"
              rel="noopener noreferrer"
            >
              TMDB
            </a>
          </div>
        </div>
      )}
    </div>
  );

  if (!selectedMovie) {
    return (
      <div className="search">
        {renderSelectedContent()}
      </div>
    );
  }

  return (
    <div className="search card search--selected">
      <div className="search__card-row">
        {posterUrl === undefined && (
          <div className="search__poster search__poster--loading" aria-hidden="true" />
        )}
        {posterUrl && (
          <img className="search__poster" src={posterUrl} alt={selectedMovie.title} loading="lazy" />
        )}
        <div className="search__selected-col">{renderSelectedContent()}</div>
      </div>
    </div>
  );
}
