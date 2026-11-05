import { publicJson } from './tools.js';

const DEFAULT_ENDPOINT = 'https://nominatim.openstreetmap.org';
const ATTRIBUTION = 'Place search by OpenStreetMap Nominatim (ODbL 1.0).';
const MAX_RESULTS = 8;
const MAX_QUERY = 200;
const MAX_CACHE_ENTRIES = 240;
/** Nominatim allows one request per second; the margin covers clock jitter on a busy machine. */
export const GEOCODER_MIN_INTERVAL_MS = 1_100;

export type PlaceSuggestion = {
  id: string; name: string; displayName: string; lat: number; lng: number;
  category: string; type: string; country: string | null; locality: string | null;
  importance: number; provider: 'nominatim'; fetchedAt: string;
};
export type PlaceSearchResult = {
  status: 'observed' | 'unavailable'; query: string; results: PlaceSuggestion[];
  provider: 'nominatim'; attribution: string; fetchedAt: string | null; cached: boolean; message?: string;
};
export type PlaceReverseResult = {
  status: 'observed' | 'unavailable'; place: PlaceSuggestion | null;
  provider: 'nominatim'; attribution: string; fetchedAt: string | null; cached: boolean; message?: string;
};

type JsonReader = (url: string, options: { userAgent: string; timeoutMs: number; accept: string }) => Promise<{ status: number; body: any }>;
type GeocoderOptions = { read?: JsonReader; minIntervalMs?: number; cacheTtlMs?: number; timeoutMs?: number };

const round = (value: number) => Math.round(value * 1e6) / 1e6;

/**
 * OpenStreetMap Nominatim allows at most one request per second per client, so the limiter is
 * process-wide rather than per instance: every geocoder, every trip completion and every UI search
 * shares one queue. Two people completing two trips at the same time still trickle.
 */
let nextSlotAt = 0;
let queue: Promise<unknown> = Promise.resolve();
function schedule<T>(minIntervalMs: number, task: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = Math.max(0, nextSlotAt - Date.now());
    nextSlotAt = Math.max(Date.now(), nextSlotAt) + minIntervalMs;
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    return task();
  });
  queue = run.then(() => undefined, () => undefined);
  return run;
}
/** Test seam: lets a caller reset the shared clock between isolated assertions. */
export function resetGeocoderClock() { nextSlotAt = 0; queue = Promise.resolve(); }
const cleanText = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const scalarText = (value: unknown, max: number) => typeof value === 'number' && Number.isFinite(value) ? String(value) : cleanText(value, max);

/** The endpoint may be disabled with `TRAVELMORE_GEOCODER_URL=off`; otherwise it must be a public HTTPS origin. */
function geocoderEndpoint() {
  const configured = cleanText(process.env.TRAVELMORE_GEOCODER_URL, 2048);
  if (configured.toLowerCase() === 'off') return null;
  return (configured || DEFAULT_ENDPOINT).replace(/\/+$/, '');
}
/** Nominatim asks every client to identify itself; a contact address is strongly recommended. */
function userAgent() {
  const contact = cleanText(process.env.TRAVELMORE_GEOCODER_CONTACT, 200).replace(/[\r\n]/g, ' ');
  return contact ? `TravelMore/0.1 (+${contact})` : 'TravelMore/0.1 (local travel planner)';
}
function language(value: unknown) {
  return typeof value === 'string' && /^[a-z]{2}(?:-[A-Z]{2})?$/.test(value) ? value : 'en';
}
/** A soft viewbox keeps nearby matches first without excluding the rest of the world. */
function preferredViewbox(near: any) {
  const lat = Number(near?.lat), lng = Number(near?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const span = 2;
  const west = Math.max(-180, lng - span), east = Math.min(180, lng + span);
  const south = Math.max(-90, lat - span), north = Math.min(90, lat + span);
  return `${round(west)},${round(north)},${round(east)},${round(south)}`;
}

function localName(address: any, displayName: string, name: string) {
  if (name) return name;
  const street = [cleanText(address?.house_number, 40), cleanText(address?.road, 120)].filter(Boolean).join(' ');
  const locality = cleanText(address?.city, 120) || cleanText(address?.town, 120) || cleanText(address?.village, 120) || cleanText(address?.municipality, 120);
  return street || cleanText(address?.suburb, 120) || locality || cleanText(address?.state, 120) || displayName.split(',')[0].trim();
}

/** Normalize one Nominatim record. Returns null instead of a guess when coordinates are unusable. */
function toSuggestion(raw: any, fetchedAt: string, fallback?: { lat: number; lng: number }): PlaceSuggestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const lat = raw.lat === undefined ? fallback?.lat : Number(raw.lat);
  const lng = raw.lon === undefined ? fallback?.lng : Number(raw.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat as number) > 90 || Math.abs(lng as number) > 180) return null;
  const displayName = cleanText(raw.display_name, 500);
  const address = raw.address && typeof raw.address === 'object' ? raw.address : {};
  const name = localName(address, displayName, cleanText(raw.name, 200));
  if (!name && !displayName) return null;
  const locality = cleanText(address.city, 120) || cleanText(address.town, 120) || cleanText(address.village, 120) || cleanText(address.municipality, 120);
  const importance = Number(raw.importance);
  return {
    id: `${scalarText(raw.osm_type, 20) || 'place'}/${scalarText(raw.osm_id, 40) || scalarText(raw.place_id, 40) || `${lat},${lng}`}`,
    name: name || displayName,
    displayName: displayName || name,
    lat: round(lat as number),
    lng: round(lng as number),
    category: cleanText(raw.category, 60),
    type: cleanText(raw.type, 60) || cleanText(raw.addresstype, 60),
    country: cleanText(address.country, 120) || null,
    locality: locality || null,
    importance: Number.isFinite(importance) ? importance : 0,
    provider: 'nominatim',
    fetchedAt,
  };
}

function toSuggestions(body: any, limit: number, fetchedAt: string) {
  const list = Array.isArray(body) ? body : [];
  const seen = new Set<string>();
  const results: PlaceSuggestion[] = [];
  for (const raw of list) {
    const suggestion = toSuggestion(raw, fetchedAt);
    if (!suggestion) continue;
    const key = `${suggestion.displayName.toLowerCase()}|${suggestion.lat}|${suggestion.lng}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(suggestion);
    if (results.length >= limit) break;
  }
  return results;
}

/**
 * Server-side place lookup (autocomplete + reverse geocoding) on top of the DNS-pinned
 * public HTTPS reader. Requests are serialized to respect the provider's one-request-per-second
 * policy, cached by full URL, and never throw for upstream failures: the client degrades to
 * manual coordinates instead of losing the form it is editing.
 */
export class PlaceGeocoder {
  private readonly read?: JsonReader;
  private readonly minIntervalMs: number;
  private readonly cacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, { expiresAt: number; fetchedAt: string; body: any }>();
  /** A provider that answered 403/429 is left alone for a while instead of being retried into a ban. */
  private blockedUntil = 0;
  private strikes = 0;

  constructor(options: GeocoderOptions = {}) {
    this.read = options.read;
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? GEOCODER_MIN_INTERVAL_MS);
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 10 * 60_000);
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? 9_000);
  }

  async search(input: any): Promise<PlaceSearchResult> {
    const query = cleanText(input?.query, MAX_QUERY + 1).replace(/\s+/g, ' ');
    if (query.length < 2 || query.length > MAX_QUERY) throw new Error('Place search needs a query of 2 to 200 characters.');
    const limit = Number.isInteger(input?.limit) ? Math.min(MAX_RESULTS, Math.max(1, Number(input.limit))) : 6;
    const unavailable = (message: string): PlaceSearchResult => ({ status: 'unavailable', query, results: [], provider: 'nominatim', attribution: ATTRIBUTION, fetchedAt: null, cached: false, message });
    const endpoint = geocoderEndpoint();
    if (!endpoint) return unavailable('Place search is turned off for this server.');
    if (this.blockedUntil > Date.now()) return unavailable(`Place search is rate limited: retry in ${Math.ceil((this.blockedUntil - Date.now()) / 1000)}s.`);
    const url = new URL(`${endpoint}/search`);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('accept-language', language(input?.language));
    const viewbox = preferredViewbox(input?.near);
    if (viewbox) { url.searchParams.set('viewbox', viewbox); url.searchParams.set('bounded', '0'); }
    try {
      const response = await this.fetch(url.toString());
      return { status: 'observed', query, results: toSuggestions(response.body, limit, response.fetchedAt), provider: 'nominatim', attribution: ATTRIBUTION, fetchedAt: response.fetchedAt, cached: response.cached };
    } catch (error: any) {
      return unavailable(`Place search is unavailable: ${String(error?.message || error).slice(0, 200)}`);
    }
  }

  async reverse(input: any): Promise<PlaceReverseResult> {
    const lat = Number(input?.lat), lng = Number(input?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new Error('Place lookup needs valid lat and lng.');
    const unavailable = (message: string): PlaceReverseResult => ({ status: 'unavailable', place: null, provider: 'nominatim', attribution: ATTRIBUTION, fetchedAt: null, cached: false, message });
    const endpoint = geocoderEndpoint();
    if (!endpoint) return unavailable('Place search is turned off for this server.');
    if (this.blockedUntil > Date.now()) return unavailable(`Place search is rate limited: retry in ${Math.ceil((this.blockedUntil - Date.now()) / 1000)}s.`);
    const url = new URL(`${endpoint}/reverse`);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('lat', String(round(lat)));
    url.searchParams.set('lon', String(round(lng)));
    url.searchParams.set('zoom', '18');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('accept-language', language(input?.language));
    try {
      const response = await this.fetch(url.toString());
      const place = response.body && !response.body.error ? toSuggestion(response.body, response.fetchedAt, { lat, lng }) : null;
      return { status: 'observed', place, provider: 'nominatim', attribution: ATTRIBUTION, fetchedAt: response.fetchedAt, cached: response.cached };
    } catch (error: any) {
      return unavailable(`Place lookup is unavailable: ${String(error?.message || error).slice(0, 200)}`);
    }
  }

  private async fetch(target: string) {
    const hit = this.cache.get(target);
    if (hit && hit.expiresAt > Date.now()) {
      this.cache.delete(target); this.cache.set(target, hit); // refresh recency
      return { body: hit.body, fetchedAt: hit.fetchedAt, cached: true };
    }
    if (hit) this.cache.delete(target);
    const reader = this.read || ((url, options) => publicJson(url, options));
    const response = await schedule(this.minIntervalMs, () => reader(target, { userAgent: userAgent(), timeoutMs: this.timeoutMs, accept: 'application/json' }));
    if (response.status === 403 || response.status === 429) {
      // Back off progressively: 1, 2, 4, 8 minutes, capped at the point where a human must look.
      this.strikes = Math.min(this.strikes + 1, 4);
      this.blockedUntil = Date.now() + 60_000 * 2 ** (this.strikes - 1);
      throw new Error(`the place provider is rate limiting requests (paused for ${Math.round((this.blockedUntil - Date.now()) / 1000)}s)`);
    }
    this.strikes = 0;
    if (response.status < 200 || response.status >= 300) throw new Error(`the place provider responded ${response.status}`);
    const fetchedAt = new Date().toISOString();
    if (this.cacheTtlMs > 0) {
      if (this.cache.size >= MAX_CACHE_ENTRIES) { const oldest = this.cache.keys().next(); if (!oldest.done) this.cache.delete(oldest.value); }
      this.cache.set(target, { expiresAt: Date.now() + this.cacheTtlMs, fetchedAt, body: response.body });
    }
    return { body: response.body, fetchedAt, cached: false };
  }
}

export const placeGeocoder = new PlaceGeocoder();
