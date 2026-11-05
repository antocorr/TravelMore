/**
 * Manual flight scan from the terminal, before the UI exists.
 *
 *   TRAVELMORE_DATA_DIR=/tmp/tm npm --workspace server run scan:flights -- \
 *     --trip <tripId> --direction outbound --from FCO --to MFM,HKG --dates 2026-12-01..2026-12-03 --pause 10000
 *
 * Every cell of origins × destinations × dates is scanned; nothing is sampled.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { TravelStore } from './store.js';
import { FlightMonitor } from './services/flightMonitor.js';
import { buildCells } from './services/flights/matrix.js';

const args = process.argv.slice(2);
const flag = (name: string, fallback = '') => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] ?? fallback : fallback; };
const tripId = flag('trip');
const direction = flag('direction', 'outbound') === 'return' ? 'return' : 'outbound';
const origins = flag('from', 'FCO').split(',').map(value => value.trim()).filter(Boolean);
const destinations = flag('to').split(',').map(value => value.trim()).filter(Boolean);
const [from, to] = flag('dates', '').split('..');
const pauseMs = Number(flag('pause', '10000'));
const dryRun = args.includes('--dry-run');

if (!tripId || !destinations.length || !from || !to) {
  console.error('Usage: --trip <tripId> --from FCO[,MXP] --to MFM,HKG --dates 2026-12-01..2026-12-05 [--direction outbound|return] [--pause 10000] [--dry-run]');
  process.exit(2);
}

const store = new TravelStore(process.env.TRAVELMORE_DATA_DIR || join(homedir(), '.travelmore'));
await store.open();
const monitor = new FlightMonitor(store);
// Save first: the server resolves "Shenzhen" into SZX, so the cells below are always real codes.
const { watch } = await monitor.saveWatch(tripId, { direction, origins, destinations, from, to, pauseMs });
const cells = buildCells(watch);
const names = (list: string[]) => list.map(code => watch.labels?.[code] || code).join('/');
console.log(`${direction}: ${names(watch.origins)} → ${names(watch.destinations)} · ${watch.from}..${watch.to}`);
console.log(`${cells.length} celle · pausa ${pauseMs} ms · stima ${Math.round(cells.length * (pauseMs + 1500) / 60000)} min`);
if (dryRun) { for (const cell of cells) console.log(`  ${cell.key}`); process.exit(0); }

const run = monitor.start(tripId, direction, {
  pauseMs,
  onProgress: progress => {
    const detail = progress.status === 'observed' ? `€${progress.price}` : progress.message || '';
    console.log(`${String(progress.index + 1).padStart(3)}/${progress.total} ${progress.cellKey} ${progress.status} ${progress.ms}ms ${detail}`);
  },
});

// Wait for the job to finish: the CLI is a foreground tool, unlike the RPC.
while (true) {
  await new Promise(resolve => setTimeout(resolve, 1_000));
  const current = monitor.getRun(run.id);
  if (current.status !== 'running') {
    console.log(`\nrun ${current.status} · ${current.observed} osservati · ${current.empty} vuoti · ${current.failed} falliti · ${current.message || 'ok'}`);
    process.exit(current.status === 'done' ? 0 : 1);
  }
}
