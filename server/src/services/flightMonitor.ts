import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { TravelStore } from '../store.js';
import { buildCells, cellKey, normalizeWatch, datesBetween, type FlightCell, type FlightDirection, type FlightWatch } from './flights/matrix.js';
import { airportLabel, findAirport, resolveAirportInput } from './airports.js';
import { cheapestByDate, lastPrice, priceSeries, recordObservation, type FlightObservation, type FlightRun } from './flights/history.js';
import { GoogleFlightsScanner, type ScanOptions, type ScanProgress, type ScanResult } from './flights/googleScanner.js';
import { SkyscannerScanner } from './flights/skyscanner.js';
import type { FlightProvider } from './flights/matrix.js';

const now = () => new Date().toISOString();
/** One monitor per store, so two RPC peers share the running batch and its cancellation. */
const monitors = new WeakMap<TravelStore, FlightMonitor>();
export function flightMonitor(store: TravelStore) {
  const existing = monitors.get(store);
  if (existing) return existing;
  const created = new FlightMonitor(store);
  monitors.set(store, created);
  return created;
}

/**
 * Flight monitoring service: watch configuration, manual runs and price history.
 *
 * Scoping follows the rest of the app — everything belongs to one trip. A run is a job, not a
 * request held open: the RPC starts it, the client polls progress, the history grows on changes.
 */
export class FlightMonitor {
  private running = new Map<string, AbortController>();

  private scanners: Record<FlightProvider, { run: any }>;
  constructor(private store: TravelStore, scanners?: Partial<Record<FlightProvider, any>>) {
    this.scanners = { google: scanners?.google || new GoogleFlightsScanner(), skyscanner: scanners?.skyscanner || new SkyscannerScanner() };
  }

  private tripNodes() {
    const data = this.store.snapshot();
    return data.nodes.filter(node => node.type === 'trip' && node.parentId === null);
  }
  private assertTrip(tripId: string) {
    if (typeof tripId !== 'string' || !this.tripNodes().some(trip => trip.id === tripId)) throw new Error('Trip not found.');
    return tripId;
  }

  /**
   * A run only lives inside this process. If the server was restarted (or crashed) while scanning,
   * its record stays "running" forever and the UI refuses to start another one: close those out.
   */
  async recoverInterrupted() {
    const stale = this.store.snapshot().flightRuns.filter(run => run.status === 'running' && !this.running.has(run.tripId));
    if (!stale.length) return { recovered: 0 };
    await this.store.transaction(state => {
      state.flightRuns = state.flightRuns.map(run => run.status === 'running'
        ? { ...run, status: 'failed' as const, finishedAt: now(), message: run.message || 'The scan was interrupted by a restart.' }
        : run);
      return null;
    });
    return { recovered: stale.length };
  }

  /** Throw away the observed data of a trip: runs, offers and the price history. */
  async reset(tripId: string, forgetWatch = false) {
    this.assertTrip(tripId);
    if (this.running.has(tripId)) throw new Error('Stop the running scan before clearing its data.');
    const before = this.store.snapshot();
    const runs = before.flightRuns.filter(run => run.tripId === tripId).length;
    const offers = before.flightOffers.filter(offer => offer.tripId === tripId).length;
    const prices = before.flightPrices.filter(point => point.tripId === tripId).length;
    await this.store.transaction(state => {
      state.flightRuns = state.flightRuns.filter(run => run.tripId !== tripId);
      state.flightOffers = state.flightOffers.filter(offer => offer.tripId !== tripId);
      state.flightPrices = state.flightPrices.filter(point => point.tripId !== tripId);
      if (forgetWatch) state.flightWatches = state.flightWatches.filter(watch => watch.tripId !== tripId);
      return null;
    });
    return { cleared: { runs, offers, prices }, watchRemoved: forgetWatch };
  }

  /** Watches of one trip, newest first. */
  listWatches(tripId: string) {
    this.assertTrip(tripId);
    const data = this.store.snapshot();
    // Watches saved before the airport dataset existed have codes but no labels: backfill for display.
    const withLabels = (watch: FlightWatch) => {
      const labels: Record<string, string> = { ...(watch.labels || {}) };
      for (const code of [...watch.origins, ...watch.destinations]) {
        if (labels[code]) continue;
        const airport = findAirport(code);
        if (airport) labels[code] = airportLabel(airport);
      }
      return { ...watch, labels };
    };
    return { watches: data.flightWatches.filter(watch => watch.tripId === tripId).sort((a, b) => a.direction.localeCompare(b.direction)).map(withLabels), offers: data.flightOffers.filter(offer => offer.tripId === tripId), runs: data.flightRuns.filter(run => run.tripId === tripId).slice(-10).reverse() };
  }

  /** Create or update the watch of one direction; the cell matrix is what a run will cover. */
  async saveWatch(tripId: string, input: any) {
    this.assertTrip(tripId);
    const data = this.store.snapshot();
    const direction: FlightDirection = input?.direction === 'return' ? 'return' : 'outbound';
    const existing = data.flightWatches.find(watch => watch.tripId === tripId && watch.direction === direction) || null;
    // Accept "Shenzhen" as well as SZX: the airport dataset decides, and the caller is told when the
    // name is ambiguous instead of silently scanning the wrong city.
    const labels: Record<string, string> = {};
    const resolveAll = (values: unknown, field: string) => {
      if (!Array.isArray(values) || !values.length) throw new Error(`${field} needs at least one airport.`);
      return values.map(value => {
        const resolved = resolveAirportInput(value);
        if ('error' in resolved) { const error: any = new Error(resolved.error); error.suggestions = resolved.suggestions; throw error; }
        if (resolved.airport) labels[resolved.code] = airportLabel(resolved.airport);
        return resolved.code;
      });
    };
    const origins = resolveAll(input?.origins, 'origins'), destinations = resolveAll(input?.destinations, 'destinations');
    const watch = normalizeWatch({ ...input, origins, destinations, labels: { ...(existing?.labels || {}), ...labels } }, tripId, existing);
    await this.store.transaction(state => {
      state.flightWatches = [...state.flightWatches.filter(item => !(item.tripId === tripId && item.direction === watch.direction)), watch];
      return null;
    });
    return { watch, cells: buildCells(watch).length };
  }

  async deleteWatch(tripId: string, direction: FlightDirection) {
    this.assertTrip(tripId);
    await this.store.transaction(state => { state.flightWatches = state.flightWatches.filter(item => !(item.tripId === tripId && item.direction === direction)); return null; });
    return { deleted: direction };
  }

  /** The matrix a run would scan, without touching the network — used by the UI preview. */
  preview(tripId: string, direction: FlightDirection) {
    this.assertTrip(tripId);
    const watch = this.store.snapshot().flightWatches.find(item => item.tripId === tripId && item.direction === direction);
    if (!watch) throw new Error(`Configure the ${direction} watch first.`);
    const cells = buildCells(watch);
    return { watch, cells, dates: datesBetween(watch.from, watch.to), estimatedMs: cells.length * (watch.pauseMs + 1_500) };
  }

  /**
   * Start one manual refresh of one direction: every cell of the matrix, no sampling.
   * Returns immediately with the run record; progress reaches the client through `onProgress`.
   */
  start(tripId: string, direction: FlightDirection, options: ScanOptions & { cellKeys?: string[]; onProgress?: (progress: ScanProgress) => void } = {}) {
    this.assertTrip(tripId);
    const watch = this.store.snapshot().flightWatches.find(item => item.tripId === tripId && item.direction === direction);
    if (!watch) throw new Error(`Configure the ${direction} watch first.`);
    if (this.running.has(tripId)) throw new Error('A flight scan is already running for this trip.');
    const all = buildCells(watch);
    // A single cell can be refreshed on its own: the watch is the authority on what exists.
    const wanted = options.cellKeys?.length ? new Set(options.cellKeys.map(key => String(key).trim())) : null;
    if (wanted) for (const key of wanted) if (!all.some(cell => cell.key === key)) throw new Error(`${key} is not part of the ${direction} watch.`);
    const cells = wanted ? all.filter(cell => wanted.has(cell.key)) : all;
    const controller = new AbortController();
    const run: FlightRun = { id: randomUUID(), watchId: watch.id, tripId, direction, status: 'running', startedAt: now(), finishedAt: null, cellsTotal: cells.length, cellsDone: 0, observed: 0, empty: 0, failed: 0, message: '', currentCellKey: '', failures: [] };
    this.running.set(tripId, controller);
    void this.store.transaction(state => { state.flightRuns.push(run); return null; }).catch(() => {});
    void this.execute(run, watch, cells, controller, options);
    return run;
  }

  private lastFailures: { cellKey: string; status: string; message: string }[] = [];
  /** Cells already written during this run, so the final sweep never duplicates a point. */
  private recorded = new Set<string>();
  private async execute(run: FlightRun, watch: FlightWatch, cells: FlightCell[], controller: AbortController, options: ScanOptions & { onProgress?: (progress: ScanProgress) => void }) {
    this.lastFailures = []; this.recorded = new Set();
    let status: FlightRun['status'] = 'done', message = '';
    try {
      const result: ScanResult = await (this.scanners[watch.provider] || this.scanners.google).run(cells, watch, {
        ...options, signal: controller.signal,
        // The Chrome profile belongs to this installation's data, never to the working directory.
        profileDir: options.profileDir || join(this.store.root, 'browser-profile'),
        onProgress: (progress: ScanProgress) => {
          // A start notice only marks the cell; the counters belong to the outcome.
          if (progress.status === 'scanning') {
            run.currentCellKey = progress.cellKey;
            void this.store.transaction(state => { state.flightRuns = state.flightRuns.map(item => item.id === run.id ? { ...run } : item); return null; }).catch(() => {});
            options.onProgress?.(progress);
            return;
          }
          if (progress.observation) { this.recorded.add(progress.observation.cellKey); void this.record(progress.observation, run.id).catch(() => {}); }
          run.cellsDone = progress.index + 1;
          if (progress.status === 'observed') run.observed++;
          else if (progress.status === 'empty') run.empty++;
          else run.failed++;
          void this.store.transaction(state => { state.flightRuns = state.flightRuns.map(item => item.id === run.id ? { ...run } : item); return null; }).catch(() => {});
          options.onProgress?.(progress);
        },
      });
      this.lastFailures = result.failures.map((item: ScanResult['failures'][number]) => ({ cellKey: item.cellKey, status: item.status, message: item.message }));
      // Already recorded cell by cell above; this only catches anything the progress hook missed.
      for (const observation of result.observations) if (!this.recorded.has(observation.cellKey)) await this.record(observation, run.id);
      if (result.aborted) { status = 'cancelled'; message = 'Scan cancelled.'; }
      else if (result.blocked) { status = 'blocked'; message = result.failures.find((item: ScanResult['failures'][number]) => item.status === 'blocked')?.message || 'The provider asked for a human check.'; }
      else if (!result.observations.length) {
        // "No flights on these dates" is an answer, not a failure: only real errors set 'failed'.
        const onlyEmpty = result.failures.length > 0 && result.failures.every((item: ScanResult['failures'][number]) => item.status === 'empty');
        status = onlyEmpty ? 'done' : 'failed';
        message = result.failures[0]?.message || 'No fare was observed.';
      }
    } catch (error: any) {
      status = controller.signal.aborted ? 'cancelled' : 'failed';
      message = String(error?.message || error).slice(0, 300);
    } finally {
      this.running.delete(run.tripId);
      const failures = (this.lastFailures ?? []).slice(0, 40);
      const finished: FlightRun = { ...run, status, message, failures, finishedAt: now() };
      await this.store.transaction(state => { state.flightRuns = [...state.flightRuns.filter(item => item.id !== run.id), finished]; return null; }).catch(() => {});
    }
  }

  private async record(observation: FlightObservation, runId: string) {
    await this.store.transaction(state => { recordObservation(state, observation, runId); return null; });
  }

  /** Refresh one date of one route: the same run machinery, one cell. */
  rescanCell(tripId: string, cellKey: string, options: ScanOptions = {}) {
    const direction: FlightDirection = String(cellKey).startsWith('return|') ? 'return' : 'outbound';
    return this.start(tripId, direction, { ...options, cellKeys: [String(cellKey)] });
  }

  cancel(tripId: string) {
    const controller = this.running.get(tripId);
    if (!controller) return { cancelled: false };
    controller.abort();
    return { cancelled: true };
  }

  getRun(runId: string) {
    const run = this.store.snapshot().flightRuns.find(item => item.id === runId);
    if (!run) throw new Error('Run not found.');
    return run;
  }

  /** Offers plus the two axes that matter: cheapest per date, and the series per cell. */
  overview(tripId: string) {
    this.assertTrip(tripId);
    const data = this.store.snapshot();
    return {
      offers: data.flightOffers.filter(offer => offer.tripId === tripId),
      cheapest: cheapestByDate(data.flightOffers, tripId),
      cells: [...new Set(data.flightOffers.filter(offer => offer.tripId === tripId).map(offer => offer.cellKey))].sort().map(key => ({ cellKey: key, series: priceSeries(data.flightPrices, key), latest: data.flightOffers.find(offer => offer.cellKey === key) })),
    };
  }

  /** History of one cell: the answer to "what did 10 December cost yesterday?". */
  history(tripId: string, key: string) {
    this.assertTrip(tripId);
    const data = this.store.snapshot();
    const point = lastPrice(data.flightPrices, key);
    return { cellKey: key, series: priceSeries(data.flightPrices, key), latest: data.flightOffers.find(offer => offer.cellKey === key) || null, hasHistory: !!point };
  }

  /** Convenience for tests/CLI: build the cells of a direction without a stored watch. */
  static cellsOf(watch: FlightWatch) { return buildCells(watch).map(cell => ({ ...cell, key: cellKey(cell) })); }
}
