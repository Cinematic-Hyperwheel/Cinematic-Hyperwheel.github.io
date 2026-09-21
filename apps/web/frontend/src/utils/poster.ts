import { getPoster } from "../api";

/**
 * Client-side poster URL cache, shared by every surface that shows a
 * movie poster (the reference search card, the recommendation
 * hover/tap info card) - avoids re-resolving the same TMDB poster more
 * than once per session.
 */
const posterCache = new Map<number, string | null>();
const posterInFlight = new Map<number, Promise<string | null>>();

export async function resolvePoster(itemId: number): Promise<string | null> {
  if (posterCache.has(itemId)) return posterCache.get(itemId)!;
  let pending = posterInFlight.get(itemId);
  if (!pending) {
    pending = getPoster(itemId)
      .then((r) => r.poster_url)
      .catch(() => null);
    posterInFlight.set(itemId, pending);
  }
  const url = await pending;
  posterCache.set(itemId, url);
  posterInFlight.delete(itemId);
  return url;
}

/**
 * Synchronous cache lookup - lets a caller skip the loading placeholder
 * entirely when the poster was already resolved earlier in the session
 * (e.g. by the grid tile itself before it was hovered), instead of
 * flashing "loading" for one frame while the async resolvePoster()
 * promise settles for a value that's already known. Returns undefined
 * only when nothing has resolved this item yet.
 */
export function getCachedPoster(itemId: number): string | null | undefined {
  return posterCache.get(itemId);
}