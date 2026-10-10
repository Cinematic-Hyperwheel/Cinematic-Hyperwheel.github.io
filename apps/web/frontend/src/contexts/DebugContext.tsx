import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

const STORAGE_KEY = "omltp.debug";
const QUERY_PARAM = "debug";

// ?debug=1 / ?debug=0 wins and is persisted, because in-app navigation
// rewrites the URL without its query string.
function readInitial(): boolean {
  try {
    const q = new URLSearchParams(window.location.search).get(QUERY_PARAM);
    if (q !== null) {
      const on = q !== "0" && q !== "false";
      localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
      return on;
    }
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false; // storage can be unavailable (private mode, blocked cookies)
  }
}

interface DebugContextValue {
  enabled: boolean;
  toggle: () => void;
  /** "{circleKey}:{itemId}" -> global recommendation ordinal. */
  numbering: Map<string, number>;
}

const DebugContext = createContext<DebugContextValue>({
  enabled: false,
  toggle: () => {},
  numbering: new Map(),
});

export function DebugProvider({ numbering, children }: { numbering: Map<string, number>; children: ReactNode }) {
  const [enabled, setEnabled] = useState(readInitial);

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      try {
        localStorage.setItem(STORAGE_KEY, prev ? "0" : "1");
      } catch { /* non-persistent toggle is fine */ }
      return !prev;
    });
  }, []);

  useEffect(() => {
    document.documentElement.toggleAttribute("data-debug", enabled);
  }, [enabled]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.altKey && e.shiftKey && e.code === "KeyD")) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      toggle();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggle]);

  const value = useMemo(() => ({ enabled, toggle, numbering }), [enabled, toggle, numbering]);
  return <DebugContext.Provider value={value}>{children}</DebugContext.Provider>;
}

export function useDebug(): DebugContextValue {
  return useContext(DebugContext);
}