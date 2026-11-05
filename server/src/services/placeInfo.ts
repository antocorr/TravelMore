import { publicJson } from './tools.js';

const DEFAULT_ENDPOINT = 'https://en.wikipedia.org';
const ATTRIBUTION = 'Place details from Wikipedia (CC BY-SA 4.0).';
const MAX_QUERY = 200;
const MAX_CACHE_ENTRIES = 240;

export type PlaceInfo = {
  status: 'observed' | 'not_found' | 'unavailable';
  query: string;
  title: string;
  description: string;
  imageUrl: string | null;
  pageUrl: string | null;
  lat: number | null;
  lng: number | null;
  provider: 'wikipedia';
  attribution: string;
  fetchedAt: string | null;
  cached: boolean;
  message?: string;
};

type JsonReader = (url: string, options: { userAgent: string; timeoutMs: number; accept: string }) => Promise<{ status: number; body: any }>;
type PlaceInfoOptions = { read?: JsonReader; minIntervalMs?: number; cacheTtlMs?: number; timeoutMs?: number };

const cleanText = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : '';
function endpoint() {
  const configured = cleanText(process.env.TRAVELMORE_PLACE_INFO_URL, 2048);
  if (configured.toLowerCase() === 'off') return null;
  try {
    const url = new URL(configured || DEFAULT_ENDPOINT);
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch { return null; }
}
function userAgent() {
  const contact = cleanText(process.env.TRAVELMORE_GEOCODER_CONTACT, 200).replace(/[\r\n]/g, ' ');
  return contact ? `TravelMore/0.1 (+${contact})` : 'TravelMore/0.1 (local travel planner)';
}
function language(value: unknown) {
  return typeof value === 'string' && /^[a-z]{2}(?:-[A-Z]{2})?$/.test(value) ? value : 'en';
}
/** Wikipedia serves images as protocol-relative URLs and serves thumbnails by width. */
/**
 * Wikimedia only serves the thumbnail sizes it pre-generated — rewriting `.../1024px-` into an
 * ungenerated width answers 400 — so the returned URL is used exactly as given.
 */
export function imageUrl(source: any) {
  const raw = cleanText(source?.source, 2048);
  if (!raw) return null;
  const absolute = raw.startsWith('//') ? `https:${raw}` : raw.startsWith('/') ? `https://upload.wikimedia.org${raw}` : raw;
  try {
    const url = new URL(absolute);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch { return null; }
}
const STOP_WORDS = new Set(['the', 'of', 'and', 'an', 'in', 'at', 'on', 'to', 'de', 'la', 'el', 'il', 'lo', 'le', 'di', 'da', 'du', 'des', 'les', 'del', 'della', 'e', 'a', 'sul', 'sulla']);
/** Accents and British spellings must not decide whether an article is about the requested place. */
const normalize = (value: unknown) => String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/centre/g, 'center').replace(/theatre/g, 'theater')
  .split(/[^a-z0-9]+/).filter(Boolean);
/**
 * Does the article title actually name this place? A loose search hit would otherwise attach the
 * biography of an architect to a city square, so every significant query word must appear in the
 * title (allowing "Shenzhen Talent Park" to fail against "Shenzhen Bay Culture Plaza").
 */
export function titleScore(query: string, title: string) {
  const significant = (value: unknown) => [...new Set(normalize(value).filter(token => token.length > 2 && !STOP_WORDS.has(token)))];
  const wanted = significant(query);
  if (!wanted.length) return 0;
  const found = significant(title);
  if (!found.length) return 0;
  const matched = wanted.filter(token => found.some(candidate => candidate === token || (token.length > 4 && candidate.includes(token)) || (candidate.length > 4 && token.includes(candidate))));
  // Jaccard, not coverage: "Talent Park station" must lose to the park itself.
  return matched.length / new Set([...wanted, ...found]).size;
}
export const TITLE_THRESHOLD = 0.6;
/** Public predicate: the article title must name at least most of the requested place. */
export const titleMatches = (query: string, title: string) => titleScore(query, title) >= TITLE_THRESHOLD;

/** Keep the extract to a usable summary instead of the whole article lead. */
function summary(value: unknown, max = 900) {
  const text = cleanText(value, 4_000).replace(/\s+/g, ' ');
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'));
  return `${(sentence > max * 0.5 ? cut.slice(0, sentence + 1) : cut).trim()}…`;
}

/**
 * Place descriptions and photographs from Wikipedia, so the planner can fill a place with more than
 * its title without inventing anything: what comes back is a real extract, a real image URL and the
 * page it came from. Same manners as the geocoder: one request slot, cached, disable-able.
 */
export class PlaceInfoService {
  private readonly read?: JsonReader;
  private readonly minIntervalMs: number;
  private readonly cacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, { expiresAt: number; fetchedAt: string; body: any }>();
  private nextSlotAt = 0;

  constructor(options: PlaceInfoOptions = {}) {
    this.read = options.read;
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? 400);
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 24 * 60 * 60_000);
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? 9_000);
  }

  async lookup(input: any): Promise<PlaceInfo> {
    const query = cleanText(input?.query, MAX_QUERY + 1).replace(/\s+/g, ' ');
    if (query.length < 2 || query.length > MAX_QUERY) throw new Error('Place details need a query of 2 to 200 characters.');
    const empty = (status: PlaceInfo['status'], message?: string): PlaceInfo => ({ status, query, title: '', description: '', imageUrl: null, pageUrl: null, lat: null, lng: null, provider: 'wikipedia', attribution: ATTRIBUTION, fetchedAt: null, cached: false, ...(message ? { message } : {}) });
    const base = endpoint();
    if (!base) return empty('unavailable', 'Place details are turned off for this server.');
    try {
      const candidates = await this.findPages(base, query, language(input?.language));
      if (!candidates.length) return { ...empty('not_found'), fetchedAt: new Date().toISOString() };
      const wanted = query.replace(/,.*$/, '');
      let body: any = null, fetchedAt = '', cached = false, best = 0;
      for (const candidate of candidates) {
        const response = await this.fetch(`${base.origin}/api/rest_v1/page/summary/${encodeURIComponent(candidate)}`);
        fetchedAt = response.fetchedAt; cached = response.cached;
        const page = response.body;
        if (!page || page.type === 'disambiguation' || typeof page.extract !== 'string') continue;
        const score = titleScore(wanted, page.title || candidate);
        if (score < TITLE_THRESHOLD || score <= best) continue;
        body = page; best = score;
      }
      if (!body) return { ...empty('not_found', 'No encyclopedia entry matched this place closely enough.'), fetchedAt };
      const match = body.title || candidates[0];
      const coordinates = body.coordinates;
      const lat = Number(coordinates?.lat), lng = Number(coordinates?.lon);
      return {
        status: 'observed', query,
        title: cleanText(match, 200),
        description: summary(body.extract),
        // The curated lead image is preferred, at a size a card can actually use.
        imageUrl: imageUrl(body.thumbnail) || imageUrl(body.originalimage),
        pageUrl: cleanText(body.content_urls?.desktop?.page, 2048) || `${base.origin}/wiki/${encodeURIComponent(match)}`,
        lat: Number.isFinite(lat) && Math.abs(lat) <= 90 ? Math.round(lat * 1e6) / 1e6 : null,
        lng: Number.isFinite(lng) && Math.abs(lng) <= 180 ? Math.round(lng * 1e6) / 1e6 : null,
        provider: 'wikipedia', attribution: ATTRIBUTION, fetchedAt, cached,
      };
    } catch (error: any) {
      return empty('unavailable', `Place details are unavailable: ${String(error?.message || error).slice(0, 200)}`);
    }
  }

  /** The search API is the only way to tolerate "Teatro alla Scala" ⟶ "La Scala". */
  private async findPages(base: URL, query: string, lang: string) {
    const url = new URL('/w/api.php', base.origin);
    url.searchParams.set('action', 'query'); url.searchParams.set('list', 'search');
    url.searchParams.set('srsearch', query); url.searchParams.set('srlimit', '3');
    url.searchParams.set('format', 'json'); url.searchParams.set('utf8', '1');
    url.searchParams.set('uselang', lang);
    const response = await this.fetch(url.toString());
    const hits = response.body?.query?.search;
    if (!Array.isArray(hits)) return [];
    return hits.map((hit: any) => cleanText(hit?.title, 200)).filter(Boolean);
  }

  private async fetch(target: string) {
    const hit = this.cache.get(target);
    if (hit && hit.expiresAt > Date.now()) { this.cache.delete(target); this.cache.set(target, hit); return { body: hit.body, fetchedAt: hit.fetchedAt, cached: true }; }
    if (hit) this.cache.delete(target);
    const wait = Math.max(0, this.nextSlotAt - Date.now());
    this.nextSlotAt = Math.max(Date.now(), this.nextSlotAt) + this.minIntervalMs;
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    const reader = this.read || ((url, options) => publicJson(url, options));
    const response = await reader(target, { userAgent: userAgent(), timeoutMs: this.timeoutMs, accept: 'application/json' });
    if (response.status === 403 || response.status === 429) throw new Error('the place provider is rate limiting requests');
    if (response.status < 200 || response.status >= 300) throw new Error(`the place provider responded ${response.status}`);
    const fetchedAt = new Date().toISOString();
    if (this.cacheTtlMs > 0 && response.body) {
      if (this.cache.size >= MAX_CACHE_ENTRIES) { const oldest = this.cache.keys().next(); if (!oldest.done) this.cache.delete(oldest.value); }
      this.cache.set(target, { expiresAt: Date.now() + this.cacheTtlMs, fetchedAt, body: response.body });
    }
    return { body: response.body, fetchedAt, cached: false };
  }
}

export const placeInfoService = new PlaceInfoService();
