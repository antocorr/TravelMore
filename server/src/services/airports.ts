import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Airport lookup from a bundled dataset (OurAirports, public domain), so the user can type
 * "Shenzhen" or "Catania" instead of remembering SZX or CTA. No network, no guessing: a name either
 * resolves to a real IATA code or the answer says it does not.
 */
export type Airport = { code: string; name: string; city: string; country: string; lat: number; lng: number; large: boolean };
export type AirportSuggestion = Airport & { label: string };

/** A few municipality names in the dataset are not the name anyone types for that airport. */
const DISPLAY_CITY: Record<string, string> = { MFM: 'Macau', HKG: 'Hong Kong', SZX: 'Shenzhen', CAN: 'Guangzhou' };

let index: { byCode: Map<string, Airport>; all: (Airport & { haystack: string })[] } | null = null;

const normalize = (value: unknown) => String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

function load() {
  if (index) return index;
  const path = fileURLToPath(new URL('../data/airports.json', import.meta.url));
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { airports: [string, string, string, string, number, number, number][] };
  const byCode = new Map<string, Airport>();
  const all: (Airport & { haystack: string })[] = [];
  for (const [code, name, city, country, lat, lng, large] of raw.airports) {
    const airport: Airport = { code, name, city, country, lat, lng, large: large === 1 };
    byCode.set(code, airport);
    all.push({ ...airport, haystack: normalize(`${code} ${city} ${name} ${country}`) });
  }
  index = { byCode, all };
  return index;
}

export function airportLabel(airport: Airport) {
  const place = DISPLAY_CITY[airport.code] || airport.city || airport.name;
  return `${place} (${airport.code})`;
}
export function describeAirport(airport: Airport | null | undefined) {
  if (!airport) return '';
  const bits = [airport.city && airport.city !== airport.name ? airport.city : '', airport.name, airport.country].filter(Boolean);
  return `${airport.code} · ${bits.join(' · ')}`;
}

/**
 * Ranked search: an exact code wins, then a city that starts with the query, then a name, then any
 * word. Large airports come first inside each band.
 */
export function searchAirports(query: unknown, limit = 8): AirportSuggestion[] {
  const text = normalize(query);
  if (!text) return [];
  const { byCode, all } = load();
  const code = String(query || '').trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(code) && byCode.has(code)) return [{ ...byCode.get(code)!, label: airportLabel(byCode.get(code)!) }];
  const words = text.split(' ').filter(Boolean);
  const scored = all.map(airport => {
    const city = normalize(airport.city), name = normalize(airport.name);
    let score = 0;
    if (city === text) score = 100;
    else if (city.startsWith(text)) score = 80;
    else if (name.startsWith(text)) score = 70;
    else if (city.includes(text)) score = 55;
    else if (name.includes(text)) score = 45;
    else if (words.every(word => airport.haystack.includes(word))) score = 30;
    if (score && airport.large) score += 5;
    return { airport, score };
  }).filter(item => item.score > 0);
  scored.sort((a, b) => b.score - a.score || a.airport.code.localeCompare(b.airport.code));
  return scored.slice(0, Math.min(20, Math.max(1, limit))).map(item => ({ ...item.airport, label: airportLabel(item.airport) }));
}

export function findAirport(code: unknown): Airport | null {
  const { byCode } = load();
  return byCode.get(String(code || '').trim().toUpperCase()) || null;
}

/**
 * Turn user input into an IATA code. A code is trusted; a name must resolve to exactly one airport,
 * otherwise the caller receives the candidates and can ask instead of scanning the wrong city.
 */
export function resolveAirportInput(input: unknown): { code: string; airport: Airport | null } | { error: string; suggestions: AirportSuggestion[] } {
  const text = String(input || '').trim();
  if (!text) return { error: 'Enter an airport, a city or a 3-letter code.', suggestions: [] };
  const upper = text.toUpperCase();
  const exact = findAirport(upper);
  if (exact) return { code: upper, airport: exact };
  const matches = searchAirports(text, 6);
  if (matches.length === 1) return { code: matches[0].code, airport: matches[0] };
  if (!matches.length) return { error: `No airport matches “${text}”. Try a city name such as Shenzhen, or a code such as SZX.`, suggestions: [] };
  const top = matches[0], tied = matches.filter(item => item.city.toLowerCase() === top.city.toLowerCase());
  if (tied.length === 1 && matches[1] && matches[1].city.toLowerCase() !== top.city.toLowerCase()) return { code: top.code, airport: top };
  return { error: `“${text}” matches more than one airport: ${matches.slice(0, 4).map(item => item.label).join(', ')}.`, suggestions: matches.slice(0, 6) };
}
