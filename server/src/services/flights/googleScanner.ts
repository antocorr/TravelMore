import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FlightCell, FlightWatch } from './matrix.js';
import type { FlightObservation } from './history.js';

/**
 * Google Flights as a price source.
 *
 * The rules below are all measured, not assumed, and they are the reason this file looks the way it
 * does. A rewrite that ignores one of them reads a wrong price:
 *
 * 1. A headless browser, and Chrome started with puppeteer's default flag set, are quoted a *worse*
 *    fare than a visible window (1.066 € vs 886 € for the same search, same minute). So: Chrome is
 *    started by us with a minimal flag list and a window, and driven over CDP.
 * 2. Travellers cannot go in the URL: with a passenger clause Google drops the IATA route entirely.
 *    They are set in Google's own panel, and the result must confirm the party ("for 3 passengers").
 * 3. Until that confirmation arrives the cards still hold single-traveller prices (528 € while three
 *    people cost 1.045 €). Those samples are not prices for the party, they are noise.
 * 4. The list opens on "Best"; the "Cheapest" tab advertises a lower fare (1.538 € vs 1.045 €). The
 *    tab is clicked and `aria-selected` is verified, because a click during a re-query is ignored.
 * 5. Google keeps lowering the price for ten or twenty seconds after the search (measured: 2.344 € →
 *    891 € at 11 s), and the cheapest fare often sits in "Other flights" below the fold.
 * 6. While that is happening Google draws its own progress **next to the Cheapest price**
 *    (`div[jscontroller="DFTXbf"][data-progressvalue]` in the results header, with a comment saying
 *    "keep the progress next to the price"). Measured on CTA→SZX 12 Dec: the tab read €478 while it
 *    spun, €384 once it disappeared six seconds later. Waiting for that progress to vanish is how
 *    the cheap fare gets recorded instead of the intermediate one.
 * 7. The value to record is the one the page **settles on**, not the lowest ever seen: a transient dip
 *    (302 € for three travellers) is not a fare, it is a frame during a re-render.
 *
 * So a cell is: navigate → confirm the party → confirm the sort → wait for Google's progress to end
 * → sample until the number stops changing → record that number. If it never settles, the cell is
 * skipped instead of guessed.
 */

export const PROVIDER = 'google-flights';
const CONSENT_SOCS = 'CAISNQgQEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjQwMTA5LjA4X3AxGgJlbiACGgYIgLC_rwY';
/** Samples needed, and how long two consecutive samples must agree before the value counts as final. */
const SETTLE_SAMPLES = 4;
const SETTLE_MAX_MS = 30_000;
const SAMPLE_MS = 1_000;

export type ScanProgress = {
  index: number; total: number; cellKey: string;
  /** 'scanning' is a start notice, not a result: only the outcome statuses move the counters. */
  status: 'scanning' | 'observed' | 'empty' | 'failed' | 'blocked'; ms: number;
  price?: number; message?: string;
  observation?: FlightObservation;
};
export type ScanResult = {
  observations: FlightObservation[];
  failures: { cellKey: string; status: 'empty' | 'failed' | 'blocked'; message: string }[];
  blocked: boolean; aborted: boolean; durationMs: number;
};
export type ScanOptions = {
  pauseMs?: number; jitterMs?: number; cellTimeoutMs?: number;
  onProgress?: (progress: ScanProgress) => void; signal?: AbortSignal;
  chromePath?: string; profileDir?: string; headless?: boolean; connectUrl?: string;
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const debug = (message: string) => { if (process.env.TRAVELMORE_FLIGHTS_DEBUG) console.log(`[flights] ${message}`); };

/* ------------------------------------------------------------------ values */

/** "805 euro", "1.087 €", "85,50 €" → 805 / 1087 / 85.5. The last separator with 1-2 digits is decimal. */
export function parseMoney(raw: unknown) {
  const text = String(raw || '').replace(/[^\d.,]/g, '');
  if (!text) return 0;
  const separator = Math.max(text.lastIndexOf('.'), text.lastIndexOf(','));
  const decimals = separator >= 0 ? text.length - separator - 1 : 0;
  const normalized = decimals > 0 && decimals <= 2
    ? `${text.slice(0, separator).replace(/[.,]/g, '')}.${text.slice(separator + 1)}`
    : text.replace(/[.,]/g, '');
  const value = Number(normalized);
  return Number.isFinite(value) ? value : 0;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "Saturday, January 9" carries no year: derive it from the searched date, rolling over New Year. */
function parseDayMonth(text: string, cellDate: string) {
  const match = text.match(/([A-Z][a-z]+)\s+(\d{1,2})/);
  if (!match) return null;
  const month = MONTHS.indexOf(match[1]);
  if (month < 0) return null;
  const year = Number(cellDate.slice(0, 4)), searchedMonth = Number(cellDate.slice(5, 7)) - 1;
  return `${month < searchedMonth - 6 ? year + 1 : year}-${String(month + 1).padStart(2, '0')}-${String(Number(match[2])).padStart(2, '0')}`;
}

/** One rendered result card, read from its aria-label, which is already a record. */
export type ParsedFare = {
  price: number; currency: string; stops: number; airline: string;
  durationMinutes: number | null; departureAt: string | null; arrivalAt: string | null;
  departureAirport: string; arrivalAirport: string;
};
export function parseResultLabel(label: string, cellDate: string): ParsedFare | null {
  const text = String(label || '').replace(/\s+/g, ' ').trim();
  const price = text.match(/From\s+([\d.,]+)\s+(euros?|dollars?|pounds?)/i);
  if (!price) return null;
  const amount = Number(price[1].replace(/(?<=\d)[.,](?=\d{3}\b)/g, '').replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const currency = /dollar/i.test(price[2]) ? 'USD' : /pound/i.test(price[2]) ? 'GBP' : 'EUR';
  const stops = /Nonstop/i.test(text) ? 0 : Number(text.match(/(\d+)\s+stops?/i)?.[1] ?? 0);
  const airline = text.match(/flight with ([^.]+)\./i)?.[1]?.trim() || '';
  const leaves = text.match(/Leaves (.+?) at (\d{1,2}:\d{2}\s*[AP]M) on ([A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2})/i);
  const arrives = text.match(/arrives at (.+?) at (\d{1,2}:\d{2}\s*[AP]M) on ([A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2})/i);
  const duration = text.match(/Total duration (\d+)\s*hr(?:\s*(\d+)\s*min)?/i);
  const clock = (value?: string) => {
    const match = String(value || '').match(/(\d{1,2}):(\d{2})\s*([AP]M)/i);
    if (!match) return '';
    const hour = Number(match[1]) % 12 + (/pm/i.test(match[3]) ? 12 : 0);
    return `${String(hour).padStart(2, '0')}:${match[2]}`;
  };
  const departureDay = parseDayMonth(String(leaves?.[3] || ''), cellDate), arrivalDay = parseDayMonth(String(arrives?.[3] || ''), cellDate);
  return {
    price: amount, currency, stops, airline,
    durationMinutes: duration ? Number(duration[1]) * 60 + Number(duration[2] || 0) : null,
    departureAt: departureDay ? `${departureDay}T${clock(leaves?.[2])}` : null,
    arrivalAt: arrivalDay ? `${arrivalDay}T${clock(arrives?.[2])}` : null,
    departureAirport: leaves?.[1]?.trim() || '', arrivalAirport: arrives?.[1]?.trim() || '',
  };
}

/** "Catania CTA Shuozhou SZH" → "Shuozhou": the city Google resolved a code to, not the one typed. */
export function resolvedCity(text: string, origin: string, destination: string) {
  const escape = (value: string) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = String(text || '');
  const between = body.match(new RegExp(`${escape(origin)}\\s+([A-Za-z][A-Za-z.'\\-]*(?:\\s+[A-Za-z.'\\-]+){0,4})\\s+${escape(destination)}\\b`));
  const words = between ? between[1].split(/\s+/).filter(word => !/^[A-Z]{3}$/.test(word)) : [];
  if (words.length) return words.join(' ').trim();
  const single = body.match(new RegExp(`([A-Za-z][A-Za-z.'\\-]*(?:\\s+[A-Za-z.'\\-]+){0,2})\\s+${escape(destination)}\\b`));
  return single ? single[1].split(/\s+/).filter(word => !/^[A-Z]{3}$/.test(word)).join(' ').trim() : '';
}

/** Route and date only: travellers are set in the panel, because a passenger clause breaks the query. */
export function searchUrl(cell: Pick<FlightCell, 'origin' | 'destination' | 'date'>, watch: Pick<FlightWatch, 'currency' | 'gl'>) {
  const params = new URLSearchParams({ hl: 'en', curr: watch.currency });
  if (watch.gl) params.set('gl', watch.gl);
  params.set('q', `Flights from ${cell.origin} to ${cell.destination} one way on ${cell.date}`);
  return `https://www.google.com/travel/flights?${params.toString()}`;
}

/* ------------------------------------------------------------------ browser */

export function chromeExecutable(explicit?: string) {
  const candidates = [explicit, process.env.TRAVELMORE_CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].filter(Boolean) as string[];
  const found = candidates.find(candidate => existsSync(candidate));
  if (!found) throw new Error('Google Chrome was not found. Set TRAVELMORE_CHROME_PATH to the Chrome executable to scan flight prices.');
  return found;
}

/** Start Chrome ourselves with a minimal flag list: puppeteer's defaults are quoted a worse fare. */
export async function launchChrome(profileDir: string, options: { chromePath?: string; headless?: boolean } = {}) {
  const { spawn } = await import('node:child_process');
  const { createServer } = await import('node:net');
  const port: number = await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const address = probe.address(); const value = typeof address === 'object' && address ? address.port : 0; probe.close(() => value ? resolve(value) : reject(new Error('no free port'))); });
  });
  const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--lang=en-US'];
  if (options.headless) {
    args.push('--headless=new');
    console.warn('[travelmore-flights] headless mode: Google may quote a higher fare than a visible window');
  }
  args.push('about:blank');
  const child = spawn(chromeExecutable(options.chromePath), args, { detached: true, stdio: 'ignore' });
  child.unref();
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { const response = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(500) }); if (response.ok) return { child, url }; } catch { /* still starting */ }
    await sleep(250);
  }
  try { child.kill('SIGTERM'); } catch {}
  throw new Error('Chrome did not start. Set TRAVELMORE_CHROME_PATH if it is not in the usual place.');
}

/** Only an explicitly configured Chrome is attached to: never take over the browser the user is in. */
export async function detectDebuggableChrome() {
  const configured = process.env.TRAVELMORE_CHROME_DEBUG_URL;
  if (!configured || configured === 'off') return '';
  try { const response = await fetch(`${configured}/json/version`, { signal: AbortSignal.timeout(700) }); return response.ok ? configured : ''; }
  catch { return ''; }
}

/* ------------------------------------------------------------------ reading */

type Reading = {
  tab: number; listed: number; note: number; cards: ParsedFare[]; labels: string[];
  noResults: boolean; blocked: string; text: string;
  /** Google is still fetching fares: the price on screen is not final yet. */
  loading: boolean;
};

/** One snapshot of the results page: the tab amount, the cards, and the traveller confirmation. */
async function readPage(page: any): Promise<Reading> {
  const raw = await page.evaluate(() => {
    const body = document.body.innerText.replace(/\s+/g, ' ');
    const href = location.href, title = document.title;
    const blocked = /captcha|sorry|consent|\/sttc\/px/i.test(href) || /Before you continue|unusual traffic|sorry/i.test(title);
    const tabs = [...document.querySelectorAll('[role="tablist"] [role="tab"]')];
    const cheapest = tabs.find(el => /^(Cheapest|Più economico)/i.test(((el as HTMLElement).innerText || '').trim().split('\n')[0]));
    const priceNode = cheapest?.querySelector('[role="text"], .hXU5Ud, .bU1Yvc span') as HTMLElement | null;
    const tabLabel = priceNode ? (priceNode.getAttribute('aria-label') || priceNode.textContent || '') : '';
    const labels = [...document.querySelectorAll('[aria-label^="From "]')]
      .map(el => el.getAttribute('aria-label') || '')
      .filter(label => /euro|dollar|pound/i.test(label));
    const note = Number((body.match(/for (\d+) passengers?/i) || [])[1] || 0);
    // Hidden templates in Google's page also contain "no flights": an empty result set is only real
    // when there are no cards at all *and* the results area says so.
    const noResults = labels.length === 0 && /\bNo results\b|\bNo flights found\b|Try changing your search/i.test(body);
    // Scoped to the results header: elsewhere the page keeps unrelated progress widgets.
    const scope = document.querySelector('[role="tablist"]') || document.body;
    const loading = [...scope.querySelectorAll('[data-progressvalue], [jscontroller="DFTXbf"]')].some(el => {
      const box = el.getBoundingClientRect();
      return box.width > 1 && box.height > 1;
    });
    return { href, title, blocked, tabLabel, labels, note, noResults, loading, text: labels.length ? '' : body.slice(0, 400) };
  });
  const cards = raw.labels
    .map((label: string) => parseResultLabel(label, ''))
    .filter((item: ParsedFare | null): item is ParsedFare => !!item)
    .sort((a: ParsedFare, b: ParsedFare) => a.price - b.price);
  return {
    tab: parseMoney(raw.tabLabel), listed: cards[0]?.price ?? 0, note: raw.note,
    cards, labels: raw.labels, noResults: raw.noResults, loading: !!raw.loading,
    blocked: raw.blocked ? `${raw.title} ${String(raw.href).slice(0, 80)}` : '', text: raw.text,
  };
}

/* ------------------------------------------------------------------ actions */

/** Travellers are set in Google's own panel; the result must confirm the party. */
async function ensureParty(page: any, adults: number, children: number, timeoutMs: number) {
  const wanted = adults + children;
  if (wanted <= 1) return true;
  const opened = await page.evaluate(() => {
    const button = [...document.querySelectorAll('[aria-label]')].find(el => /change number of passengers|modifica il numero di passeggeri/i.test(el.getAttribute('aria-label') || '')) as HTMLElement | undefined;
    if (!button) return false;
    button.click(); return true;
  });
  if (!opened) return false;
  await sleep(900);
  // Anonymous callbacks only: a named helper inside evaluate breaks under esbuild's keepNames.
  await page.evaluate((counts: { adults: number; children: number }) => {
    const addAdult = [...document.querySelectorAll('[aria-label]')].find(el => /^Add adult$|^Aggiungi adulto$/i.test(el.getAttribute('aria-label') || '')) as HTMLElement | undefined;
    const addChild = [...document.querySelectorAll('[aria-label]')].find(el => /^Add child aged 2 to 11$|^Aggiungi bambino dai 2 agli 11 anni$/i.test(el.getAttribute('aria-label') || '')) as HTMLElement | undefined;
    const done = [...document.querySelectorAll('[aria-label]')].find(el => /^Done$|^Fatto$/i.test(el.getAttribute('aria-label') || '')) as HTMLElement | undefined;
    for (let index = 1; index < counts.adults; index++) addAdult?.click();
    for (let index = 0; index < counts.children; index++) addChild?.click();
    done?.click();
  }, { adults, children });
  const deadline = Date.now() + Math.min(timeoutMs, 20_000);
  while (Date.now() < deadline) {
    await sleep(500);
    const reading = await readPage(page);
    if (reading.note === wanted) return true;
  }
  return false;
}

/** Switch the results to Google's "Cheapest" sort and prove it stuck through aria-selected. */
async function ensureCheapestSort(page: any) {
  const state = () => page.evaluate(() => {
    const tabs = [...document.querySelectorAll('[role="tablist"] [role="tab"]')];
    const cheapest = tabs.find(el => /^(Cheapest|Più economico)/i.test(((el as HTMLElement).innerText || '').trim().split('\n')[0]));
    return { found: !!cheapest, selected: cheapest ? cheapest.getAttribute('aria-selected') === 'true' : false };
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await state();
    if (!current.found) { await sleep(700); continue; }
    if (current.selected) return true;
    await page.evaluate(() => {
      const tabs = [...document.querySelectorAll('[role="tablist"] [role="tab"]')];
      (tabs.find(el => /^(Cheapest|Più economico)/i.test(((el as HTMLElement).innerText || '').trim().split('\n')[0])) as HTMLElement | undefined)?.click();
    });
    for (let wait = 0; wait < 10; wait++) { await sleep(400); if ((await state()).selected) return true; }
  }
  return false;
}

/**
 * Sample until the page stops moving. The recorded value is the one that survives, never the lowest
 * ever seen: a dip during a re-render (302 € for three travellers) is not a fare.
 */
async function settle(page: any, cell: FlightCell, wanted: number) {
  const startedAt = Date.now();
  const timeline: string[] = [];
  let previous = -1, stable = 0, latest: Reading | null = null, emptySamples = 0, sawLoading = false;
  while (Date.now() - startedAt < SETTLE_MAX_MS) {
    await page.evaluate(() => { window.scrollBy(0, Math.round(window.innerHeight * 0.9)); });
    const reading = await readPage(page);
    if (reading.blocked) return { blocked: reading.blocked, reading: null, timeline };
    // An empty list right after navigation is normal: only five consecutive empty samples mean it.
    if (reading.noResults) {
      emptySamples++;
      if (emptySamples >= 5) return { blocked: '', reading, timeline };
      await sleep(SAMPLE_MS);
      continue;
    }
    emptySamples = 0;
    // While Google's own progress is next to the price, the number is on its way: keep waiting.
    if (reading.loading) {
      stable = 0;
      sawLoading = true;
      debug(`${cell.key} ${Math.round((Date.now() - startedAt) / 1000)}s loading, €${reading.tab || '-'} so far`);
      await sleep(SAMPLE_MS);
      continue;
    }
    // A price that belongs to another party is not a price for this cell, in either direction: the
    // browser can carry three passengers over from an earlier watch, and a 3-person total recorded
    // as a single fare would understate the price threefold.
    if (reading.note && reading.note !== wanted) { await sleep(SAMPLE_MS); continue; }
    const current = Math.min(...[reading.tab, reading.listed].filter(value => value > 0));
    const value = Number.isFinite(current) ? current : 0;
    if (value && value === previous) stable++;
    else { stable = value ? 1 : 0; previous = value; timeline.push(`${Math.round((Date.now() - startedAt) / 1000)}s:${reading.tab === value ? 'tab' : 'list'} ${value}`); }
    latest = reading;
    debug(`${cell.key} ${Math.round((Date.now() - startedAt) / 1000)}s tab=${reading.tab || '-'} list=${reading.listed || '-'} note=${reading.note || '-'} stable=${stable}`);
    if (stable >= SETTLE_SAMPLES) return { blocked: '', reading, timeline };
    await sleep(SAMPLE_MS);
  }
  return { blocked: '', reading: latest, timeline, timedOut: true, stillLoading: sawLoading && !latest };
}

/* ------------------------------------------------------------------ scanner */

export class GoogleFlightsScanner {
  async run(cells: FlightCell[], watch: FlightWatch, options: ScanOptions = {}): Promise<ScanResult> {
    const { default: puppeteer } = await import('puppeteer-core');
    const pauseMs = Math.max(1_000, options.pauseMs ?? watch.pauseMs ?? 10_000);
    const jitterMs = Math.max(0, options.jitterMs ?? 2_000);
    const cellTimeoutMs = Math.max(8_000, options.cellTimeoutMs ?? 30_000);
    const wanted = watch.adults + (watch.children || 0);
    const startedAt = Date.now();
    const observations: FlightObservation[] = [], failures: ScanResult['failures'] = [];
    let blocked = false, aborted = false;

    const profileDir = options.profileDir || join(homedir(), '.travelmore', 'browser-profile');
    await mkdir(profileDir, { recursive: true }).catch(() => {});

    const connectUrl = options.connectUrl || (await detectDebuggableChrome());
    let browser: any, attached = false, spawned: any = null;
    if (connectUrl) {
      browser = await puppeteer.connect({ browserURL: connectUrl, defaultViewport: null, protocolTimeout: cellTimeoutMs + 30_000 });
      attached = true;
      console.log('[travelmore-flights] scanning inside the running Chrome session');
    } else {
      const started = await launchChrome(profileDir, { chromePath: options.chromePath, headless: options.headless });
      spawned = started.child;
      browser = await puppeteer.connect({ browserURL: started.url, defaultViewport: null, protocolTimeout: cellTimeoutMs + 30_000 });
    }

    try {
      // One tab, in front: a background tab would leave the visible window on about:blank.
      const open = await browser.pages().catch(() => [] as any[]);
      const blank = attached ? null : open.find((candidate: any) => (candidate.url() || '').startsWith('about:'));
      const page = blank || await browser.newPage();
      await page.bringToFront?.().catch?.(() => {});
      await page.setCookie(
        { name: 'SOCS', value: CONSENT_SOCS, domain: '.google.com' },
        { name: 'CONSENT', value: 'YES+', domain: '.google.com' },
      ).catch(() => {});
      await page.setRequestInterception(true);
      page.on('request', (request: any) => {
        const type = request.resourceType();
        if (type === 'image' || type === 'media' || type === 'font') request.abort().catch(() => {});
        else request.continue().catch(() => {});
      });

      for (const [index, cell] of cells.entries()) {
        if (options.signal?.aborted) { aborted = true; break; }
        const cellStarted = Date.now();
        options.onProgress?.({ index, total: cells.length, cellKey: cell.key, status: 'scanning', ms: 0 });
        const url = searchUrl(cell, watch);
        const fail = (status: 'empty' | 'failed' | 'blocked', message: string) => {
          failures.push({ cellKey: cell.key, status, message });
          options.onProgress?.({ index, total: cells.length, cellKey: cell.key, status, ms: Date.now() - cellStarted, message });
        };
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: cellTimeoutMs });
          // Let the first render land before touching the panel: an early click is ignored.
          let first = await readPage(page);
          for (let wait = 0; wait < 20 && !first.cards.length && !first.noResults && !first.blocked; wait++) { await sleep(700); first = await readPage(page); }
          if (first.blocked) { blocked = true; fail('blocked', first.blocked); break; }
          if (wanted > 1 && !(await ensureParty(page, watch.adults, watch.children || 0, cellTimeoutMs))) {
            fail('failed', `Could not set ${wanted} travellers: refusing to record a fare for another party.`);
            continue;
          }
          if (!first.noResults) await ensureCheapestSort(page);
          const settled = await settle(page, cell, wanted);
          if (settled.blocked) { blocked = true; fail('blocked', settled.blocked); break; }
          const reading = settled.reading;
          if (!reading) { fail('failed', 'The results page was never readable.'); continue; }
          if (reading.noResults) {
            const searched = resolvedCity(reading.text, String(cell.origin), String(cell.destination));
            fail('empty', `No flights found for ${cell.date}${searched ? `. Google searched “${searched}” for ${cell.destination}` : ''}: check that the airport code is the city you meant.`);
            continue;
          }
          const price = Math.min(...[reading.tab, reading.listed].filter(value => value > 0));
          if (!Number.isFinite(price) || price <= 0) { fail('empty', settled.timedOut ? 'The price never settled: cell skipped.' : `The page rendered no fare for ${cell.date}.`); continue; }
          const fromTab = reading.tab > 0 && reading.tab <= reading.listed;
          // Details belong to the card whose price is the recorded one (a tab can be one euro off).
          const details = reading.cards.find(card => Math.abs(card.price - price) <= Math.max(2, price * 0.01)) || null;
          if (watch.maxStops !== null && details && details.stops > watch.maxStops) {
            fail('empty', `The cheapest fare has ${details.stops} stops, above the limit of ${watch.maxStops}.`);
            continue;
          }
          const observation: FlightObservation = {
            cellKey: cell.key, tripId: watch.tripId, direction: watch.direction,
            origin: cell.origin, destination: cell.destination, date: cell.date,
            provider: PROVIDER,
            price,
            priceSource: fromTab ? 'header' : 'listed',
            currency: details?.currency || watch.currency,
            airline: details?.airline || '',
            stops: details?.stops ?? null,
            durationMinutes: details?.durationMinutes ?? null,
            departureAt: details?.departureAt ?? null,
            arrivalAt: details?.arrivalAt ?? null,
            options: reading.cards.length,
            maxStops: watch.maxStops,
            travellers: wanted,
            headerPrice: reading.tab || null,
            headerCheaper: fromTab,
            sourceUrl: url,
            provenance: `${PROVIDER} · settled at €${price} after ${settled.timeline.length} change${settled.timeline.length === 1 ? '' : 's'} (${settled.timeline.join(' → ') || 'no movement'})`,
            observedAt: new Date().toISOString(),
          };
          observations.push(observation);
          options.onProgress?.({ index, total: cells.length, cellKey: cell.key, status: 'observed', ms: Date.now() - cellStarted, price, observation });
        } catch (error: any) {
          fail('failed', String(error?.message || error).slice(0, 200));
        }
        if (index < cells.length - 1 && !options.signal?.aborted) await sleep(pauseMs + Math.round((Math.random() * 2 - 1) * jitterMs));
      }
    } finally {
      await (globalThis as any).__travelmoreScanPage?.close?.().catch?.(() => {});
      browser?.disconnect?.();
      if (spawned) { try { spawned.kill('SIGTERM'); } catch { /* already gone */ } }
    }
    return { observations, failures, blocked, aborted, durationMs: Date.now() - startedAt };
  }
}
