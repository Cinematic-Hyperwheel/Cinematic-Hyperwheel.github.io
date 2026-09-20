import { powFetch } from "./pow/powFetch";

export type Span = [number, number];

export interface MovieHit {
  item_id: number;
  title: string;
  titleHighlights: Span[];
  genres: string[];
  // Only populated by getMovieById() (backed by /api/movie/{id}, which
  // always includes them, possibly as null); search() results omit
  // these fields entirely, since /api/search doesn't return them.
  imdb_id?: string | null;
  tmdb_id?: string | null;
}

export interface AxisLabels {
  axis: string;
  negative: string;
  positive: string;
}

export interface AxisConfig {
  pc: number;
  colors: { negative: string; positive: string };
  labels: Record<string, AxisLabels>; // keyed by language code, e.g. "en"/"ru"
  explained: number;
}

export interface WheelCircle {
  primary: boolean;
  axis_x: AxisConfig;
  axis_y: AxisConfig;
  z_x: number;
  z_y: number;
  angle_deg: number;
  radius: number;
}

export interface WheelResponse {
  item_id: number;
  circles: WheelCircle[];
}

export async function searchMovies(q: string): Promise<MovieHit[]> {
  const res = await powFetch("light", `/api/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error("search failed");
  return (await res.json()).results;
}

export interface RecItem {
  item_id: number;
  title: string;
  genres: string[];
  // null when the dataset has no matching links.csv row for this movie,
  // or movies.csv wasn't built with --links at all - see
  // tools/filter_metadata_to_artifact.py and utils/imdb.ts / utils/tmdb.ts
  // for the title-search fallback used in that case.
  imdb_id: string | null;
  tmdb_id: string | null;
  rank: number;
  distance_to_target: number;
  angular_error_deg: number | null;
  radius_ratio: number | null;
  z_x: number;
  z_y: number;
  angle_deg: number;
}

export interface RecAngle {
  angle_deg: number;
  items: RecItem[];
}

export interface RecommendReference {
  z_x: number;
  z_y: number;
  angle_deg: number;
  radius: number;
}

export interface StarfieldItem {
  item_id: number;
  title: string;
  genres: string[];
  imdb_id: string | null;
  tmdb_id: string | null;
  z_x: number;
  z_y: number;
  angle_deg: number;
}

export interface RecommendCircle {
  primary: boolean;
  axis_x: AxisConfig;
  axis_y: AxisConfig;
  reference: RecommendReference | null;
  angles: RecAngle[];
  starfield: StarfieldItem[];
}

export interface RecommendResponse {
  item_id: number;
  scheme: string;
  circles: RecommendCircle[];
}

/**
 * Converts a RecommendCircle (server's per-circle recommend payload,
 * carrying the reference point under `reference`) into the plain
 * WheelCircle shape the Wheel component renders - shared by the main
 * wheel (App.tsx) and the small per-section wheels in
 * RecommendationsPanel.tsx, so both draw the reference point the same
 * way. Returns null only if the server had no basis index for the
 * reference item (reference: null in the API response).
 */
export function toWheelCircle(rc: RecommendCircle): WheelCircle | null {
  if (!rc.reference) return null;
  return {
    primary: rc.primary,
    axis_x: rc.axis_x,
    axis_y: rc.axis_y,
    z_x: rc.reference.z_x,
    z_y: rc.reference.z_y,
    angle_deg: rc.reference.angle_deg,
    radius: rc.reference.radius,
  };
}

export async function getRecommendations(itemId: number, scheme: string): Promise<RecommendResponse> {
  const res = await powFetch("heavy", `/api/movie/${itemId}/recommend?scheme=${encodeURIComponent(scheme)}`);
  if (!res.ok) throw new Error("recommend lookup failed");
  return res.json();
}

export async function getWheelCircles(itemId: number): Promise<WheelResponse> {
  const res = await powFetch("light", `/api/movie/${itemId}/wheel`);
  if (!res.ok) throw new Error("wheel lookup failed");
  return res.json();
}

export async function getMovieById(itemId: number): Promise<MovieHit> {
  const res = await powFetch("light", `/api/movie/${itemId}`);
  if (!res.ok) throw new Error("movie lookup failed");
  const data = await res.json();
  return {
    item_id: data.item_id,
    title: data.title,
    titleHighlights: [],
    genres: data.genres,
    imdb_id: data.imdb_id ?? null,
    tmdb_id: data.tmdb_id ?? null,
  };
}

/**
 * Picks one movie at random from the whole catalog (not just the
 * currently loaded search results) - backs the "surprise me" button in
 * SearchBar.tsx. Same response shape as getMovieById().
 */
export async function getRandomMovie(): Promise<MovieHit> {
  const res = await powFetch("light", `/api/movie/random`);
  if (!res.ok) throw new Error("random movie lookup failed");
  const data = await res.json();
  return {
    item_id: data.item_id,
    title: data.title,
    titleHighlights: [],
    genres: data.genres,
    imdb_id: data.imdb_id ?? null,
    tmdb_id: data.tmdb_id ?? null,
  };
}

export interface BackdropResponse {
  item_id: number;
  backdrop_url: string | null;
}

export async function getBackdrop(itemId: number): Promise<BackdropResponse> {
  const res = await powFetch("light", `/api/movie/${itemId}/backdrop`);
  if (!res.ok) throw new Error("backdrop lookup failed");
  return res.json();
}

export interface PosterResponse {
  item_id: number;
  // null when the movie has no tmdb_id, TMDB isn't configured, or the
  // lookup failed - see apps/web/backend/app/tmdb.py.
  poster_url: string | null;
}

export async function getPoster(itemId: number): Promise<PosterResponse> {
  const res = await powFetch("light", `/api/movie/${itemId}/poster`);
  if (!res.ok) throw new Error("poster lookup failed");
  return res.json();
}