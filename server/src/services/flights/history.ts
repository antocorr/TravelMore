import { randomUUID } from 'node:crypto';
import type { FlightDirection } from './matrix.js';

/**
 * What a scan observed, and what it costs over time.
 *
 * `FlightOffer` is the latest observation of one cell; `FlightPricePoint` is the history of that
 * same cell over time — "on 10 December it cost 448 yesterday and 458 today". A point is appended
 * only when the price actually differs from the previous one, so the series stays readable and a
 * repeated refresh does not inflate the file.
 */

export type FlightOffer = {
  id: string; cellKey: string; tripId: string; provider: string; direction: FlightDirection;
  origin: string; destination: string; date: string;
  price: number; currency: string; airline: string; stops: number | null; durationMinutes: number | null;
  departureAt: string | null; arrivalAt: string | null;
  /** How many fares were on the page, so "cheapest of N" is a fact and not a claim. */
  options: number; maxStops: number | null;
  headerPrice: number | null; headerCheaper: boolean; priceSource: 'listed' | 'header';
  /** The party the price covers: a total for three people is not comparable with a single fare. */
  travellers: number; perTraveller: number;
  sourceUrl: string; provenance: string; observedAt: string; runId: string;
};
export type FlightPricePoint = { id: string; cellKey: string; tripId: string; price: number; currency: string; observedAt: string; runId: string };
/** One manual refresh of one direction: resumable in the UI, honest about why it stopped. */
export type FlightRun = {
  id: string; watchId: string; tripId: string; direction: FlightDirection;
  status: 'running' | 'done' | 'blocked' | 'failed' | 'cancelled';
  startedAt: string; finishedAt: string | null;
  cellsTotal: number; cellsDone: number; observed: number; empty: number; failed: number;
  /** The cell being looked at right now, so the grid can show it moving. */
  currentCellKey: string;
  message: string;
  /** Why cells came back empty: without this a scan reports "0 priced" and nothing else. */
  failures: { cellKey: string; status: string; message: string }[];
};
/** What the scanner produces for one cell: the cheapest result it could read. */
export type FlightObservation = {
  cellKey: string; tripId: string; direction: FlightDirection; origin: string; destination: string; date: string; provider: string;
  price: number; currency: string; airline: string; stops: number | null; durationMinutes: number | null;
  departureAt: string | null; arrivalAt: string | null;
  options?: number; maxStops?: number | null; travellers?: number; perTraveller?: number;
  /** What Google declared as its own minimum, and whether it was below the visible list. */
  headerPrice?: number | null; headerCheaper?: boolean;
  /** Where the recorded price comes from: the rendered list, or Google's own declared minimum. */
  priceSource?: 'listed' | 'header';
  sourceUrl: string; provenance: string; observedAt: string;
};

const roundPrice = (value: number) => Math.round(value * 100) / 100;

/** The last recorded price for a cell, if any. */
export function lastPrice(points: FlightPricePoint[], cellKeyValue: string) {
  let latest: FlightPricePoint | undefined;
  for (const point of points) if (point.cellKey === cellKeyValue && (!latest || point.observedAt >= latest.observedAt)) latest = point;
  return latest;
}

/**
 * Record one observation: the offer row is replaced (it is "now"), the history grows only on a real
 * change — a different price, or an offer that appeared/disappeared.
 */
export function recordObservation(data: { flightOffers: FlightOffer[]; flightPrices: FlightPricePoint[] }, observation: FlightObservation, runId: string) {
  const price = roundPrice(observation.price);
  const previous = lastPrice(data.flightPrices, observation.cellKey);
  const changed = !previous || previous.price !== price || previous.currency !== observation.currency;
  const travellers = Math.max(1, observation.travellers || 1);
  const offer: FlightOffer = { id: randomUUID(), ...observation, options: observation.options ?? 0, maxStops: observation.maxStops ?? null, headerPrice: observation.headerPrice ?? null, headerCheaper: observation.headerCheaper === true, priceSource: observation.priceSource === 'header' ? 'header' : 'listed', travellers, perTraveller: Math.round((price / travellers) * 100) / 100, price, runId, observedAt: observation.observedAt };
  data.flightOffers = [...data.flightOffers.filter(item => item.cellKey !== observation.cellKey), offer];
  if (!changed) return { offer, priceRecorded: false, previous };
  const point: FlightPricePoint = { id: randomUUID(), cellKey: observation.cellKey, tripId: observation.tripId, price, currency: observation.currency, observedAt: observation.observedAt, runId };
  data.flightPrices.push(point);
  return { offer, priceRecorded: true, previous };
}

/** A cell that produced no fare must be visible, not silently absent. */
export function recordMiss(data: { flightOffers: FlightOffer[]; flightPrices: FlightPricePoint[] }, cell: { key: string; tripId?: string }) {
  data.flightOffers = data.flightOffers.filter(item => item.cellKey !== cell.key);
  return { cellKey: cell.key, cleared: true };
}

/** Ascending series for a chart, oldest first. */
export function priceSeries(points: FlightPricePoint[], cellKeyValue: string) {
  return points.filter(point => point.cellKey === cellKeyValue).sort((a, b) => a.observedAt.localeCompare(b.observedAt)).map(point => ({ observedAt: point.observedAt, price: point.price, currency: point.currency }));
}

/** Cheapest cell per date, for the heat map / matrix view. */
export function cheapestByDate(offers: FlightOffer[], tripId: string) {
  const best = new Map<string, FlightOffer>();
  for (const offer of offers) {
    if (offer.tripId !== tripId) continue;
    const key = `${offer.direction}|${offer.date}`;
    const current = best.get(key);
    if (!current || offer.price < current.price) best.set(key, offer);
  }
  return [...best.values()].sort((a, b) => a.date.localeCompare(b.date) || a.price - b.price);
}
