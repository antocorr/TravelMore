import { randomUUID } from 'node:crypto';

/**
 * Flight monitoring: a watch is the per-trip configuration, a cell is one search.
 *
 * A run covers the **full cartesian product** of the watch (origins × destinations × dates) for one
 * direction: clicking "run" on the outbound group must scan every outbound cell, never a sample.
 */

export type FlightDirection = 'outbound' | 'return';
/** Two engines, chosen per watch: Google Flights or Skyscanner. */
export type FlightProvider = 'google' | 'skyscanner';
export type FlightWatch = {
  id: string; tripId: string; direction: FlightDirection;
  origins: string[]; destinations: string[]; from: string; to: string;
  /** Readable names for the codes above, so the UI never has to show a bare IATA code. */
  labels: Record<string, string>;
  adults: number; children: number; childrenAges: number[]; provider: FlightProvider; currency: string; maxStops: number | null;
  /** Google point of sale and language: a fare quoted for IT is not the fare quoted for US. */
  gl: string; hl: string;
  pauseMs: number; createdAt: string; updatedAt: string;
};
export type FlightCell = { key: string; direction: FlightDirection; origin: string; destination: string; date: string };

/** A runaway window would melt the provider: the cap is a guard rail, not a target. */
export const MAX_CELLS = 400;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CODE = /^[A-Z]{3}$/;
const now = () => new Date().toISOString();

const place = (value: unknown, field: string) => {
  if (typeof value !== 'string') throw new Error(`${field} must be a place name or a 3-letter IATA code.`);
  const text = value.trim();
  if (!text || text.length > 64) throw new Error(`${field} must be 1 to 64 characters.`);
  return CODE.test(text.toUpperCase()) ? text.toUpperCase() : text;
};
const places = (value: unknown, field: string, max = 8) => {
  if (!Array.isArray(value) || !value.length || value.length > max) throw new Error(`${field} needs 1 to ${max} places.`);
  return [...new Set(value.map(item => place(item, field)))];
};
const isoDate = (value: unknown, field: string) => {
  if (typeof value !== 'string' || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) throw new Error(`${field} must be an ISO date (YYYY-MM-DD).`);
  return value;
};

/** Every date in the window, inclusive, as ISO days in UTC. */
export function datesBetween(from: string, to: string) {
  const start = Date.parse(`${isoDate(from, 'from')}T00:00:00Z`), end = Date.parse(`${isoDate(to, 'to')}T00:00:00Z`);
  if (end < start) throw new Error('The date window ends before it starts.');
  const dates: string[] = [];
  for (let at = start; at <= end; at += 86_400_000) dates.push(new Date(at).toISOString().slice(0, 10));
  if (dates.length > 120) throw new Error('A date window may cover at most 120 days.');
  return dates;
}

export function normalizeWatch(input: any, tripId: string, existing?: FlightWatch | null): FlightWatch {
  if (typeof tripId !== 'string' || !/^[a-f0-9-]{36}$/i.test(tripId)) throw new Error('A watch belongs to one trip.');
  const direction: FlightDirection = input?.direction === 'return' ? 'return' : 'outbound';
  if (input?.direction !== undefined && input.direction !== 'outbound' && input.direction !== 'return') throw new Error('Direction must be outbound or return.');
  const origins = places(input?.origins, 'origins'), destinations = places(input?.destinations, 'destinations');
  const from = isoDate(input?.from, 'from'), to = isoDate(input?.to, 'to');
  const dates = datesBetween(from, to);
  const adults = input?.adults === undefined ? 1 : Number(input.adults);
  if (!Number.isInteger(adults) || adults < 1 || adults > 9) throw new Error('Adults must be between 1 and 9.');
  const children = input?.children === undefined ? 0 : Number(input.children);
  if (!Number.isInteger(children) || children < 0 || children > 8) throw new Error('Children must be between 0 and 8.');
  // Skyscanner needs the age to price a child; Google only has a 2-11 bucket.
  const rawAges = Array.isArray(input?.childrenAges) ? input.childrenAges : [];
  const childrenAges = Array.from({ length: children }, (_, index) => {
    const age = Number(rawAges[index] ?? 8);
    if (!Number.isInteger(age) || age < 0 || age > 17) throw new Error("Children's ages must be 0 to 17.");
    return age;
  });
  const provider: FlightProvider = input?.provider === 'skyscanner' ? 'skyscanner' : input?.provider === 'google' ? 'google' : (existing?.provider || 'google');
  // Providers price one booking of at most nine travellers.
  if (adults + children > 9) throw new Error('A scan covers at most 9 travellers in total.');
  const currency = typeof input?.currency === 'string' && /^[A-Z]{3}$/.test(input.currency.toUpperCase()) ? input.currency.toUpperCase() : 'EUR';
  const maxStops = input?.maxStops === undefined || input?.maxStops === null ? null : Number(input.maxStops);
  if (maxStops !== null && (!Number.isInteger(maxStops) || maxStops < 0 || maxStops > 3)) throw new Error('maxStops must be 0 to 3, or null for no limit.');
  const gl = typeof input?.gl === 'string' && /^[A-Z]{2}$/.test(input.gl.toUpperCase()) ? input.gl.toUpperCase() : '';
  const hl = typeof input?.hl === 'string' && /^[a-z]{2}$/.test(input.hl) ? input.hl : 'en';
  const pauseMs = input?.pauseMs === undefined ? 10_000 : Number(input.pauseMs);
  if (!Number.isInteger(pauseMs) || pauseMs < 1_000 || pauseMs > 120_000) throw new Error('The pause must be 1000–120000 ms.');
  if (origins.length * destinations.length * dates.length > MAX_CELLS) throw new Error(`This watch needs ${origins.length * destinations.length * dates.length} searches; the limit is ${MAX_CELLS}.`);
  const stamp = now();
  return {
    id: existing?.id || randomUUID(), tripId, direction, origins, destinations, from, to,
    labels: { ...(existing?.labels || {}), ...(input?.labels && typeof input.labels === 'object' ? input.labels : {}) },
    adults, children, childrenAges, provider, currency, maxStops, gl, hl, pauseMs, createdAt: existing?.createdAt || stamp, updatedAt: stamp,
  };
}

export const cellKey = (cell: Pick<FlightCell, 'direction' | 'origin' | 'destination' | 'date'>) =>
  `${cell.direction}|${cell.origin.toUpperCase()}|${cell.destination.toUpperCase()}|${cell.date}`;

/** The full matrix, deterministic order (origin, destination, date) so a run is reproducible. */
export function buildCells(watch: FlightWatch): FlightCell[] {
  const cells: FlightCell[] = [];
  for (const origin of watch.origins) for (const destination of watch.destinations) for (const date of datesBetween(watch.from, watch.to)) {
    const cell = { direction: watch.direction, origin, destination, date } as const;
    cells.push({ ...cell, key: cellKey(cell) });
  }
  return cells;
}
