import { useEffect, useRef, useState } from "react";

/**
 * Returns `value`, but only updates once it has stayed the same for
 * `delayMs` without changing again - i.e. the settled value, not a live
 * mirror of every intermediate update. Each change restarts the timer
 * and cancels the previous one, so a rapid burst of changes never
 * produces an update for any of the discarded intermediate values, only
 * for whichever one the input actually settles on.
 *
 * The very first value is returned immediately (no initial delay) -
 * only subsequent changes are debounced.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(timerRef.current);
  }, [value, delayMs]);

  return settled;
}