import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdir } from 'node:fs/promises';
import type { FlightCell, FlightWatch } from './matrix.js';
import type { FlightObservation } from './history.js';
import {
  chromeExecutable, detectDebuggableChrome, launchChrome, parseMoney,
  type ScanOptions, type ScanProgress, type ScanResult,
} from './googleScanner.js';

/**
 * Skyscanner as a second price source.
 *
 * What is measured, and therefore what this file does:
 *
 * 1. A fresh browser is stopped by PerimeterX ("Sei una persona o un robot?"). Only a *warmed*
 *    profile — one a human has unlocked once — gets through, so the scan uses its own profile
 *    directory and stops with a clear message instead of fighting the challenge.
 * 2. The "whole month" calendar is not trustworthy: measured €435 for 20/11 while the same date
 *    quoted €651 on its own page, and only 2 of 30 days carried a price. It is not used.
 * 3. The single-date page publishes the number we want in `data-testid="FqsTab_CHEAPEST"`
 *    ("Il più economico € 298"), next to the party ("3 viaggiatori, Economy").
 * 4. Children are priced for real: `childrenv2=8|` carries the age, which Google cannot do.
 * 5. The page needs ten seconds or more before those numbers appear, and it must not be closed
 *    early: the tab stays open until the run ends.
 * 6. The published price is **per person**: one adult quotes €310, two adults plus an 8-year-old
 *    quote €298 each (the child fare pulls the average down). The party total is that times the
 *    number of travellers, and it is the value stored, so the two providers stay comparable.
 */

/** A warm profile is required; the default is the one kept next to the data. */
const DEFAULT_PROFILE = () => process.env.TRAVELMORE_SKYSCANNER_PROFILE || join(homedir(), '.travelmore', 'skyscanner-profile');
const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const debug = (message: string) => { if (process.env.TRAVELMORE_FLIGHTS_DEBUG) console.log(`[skyscanner] ${message}`); };

/** `childrenv2` wants the ages, pipe separated and URL encoded. */
export function childrenParam(ages: number[]) {
  return ages.length ? `${ages.map(age => Math.max(0, Math.min(17, Math.round(age)))).join('|')}|` : '';
}

/** Skyscanner route shape: /cta/szx/261129/ — two-digit year, month, day. */
export function skyscannerUrl(cell: Pick<FlightCell, 'origin' | 'destination' | 'date'>, watch: Pick<FlightWatch, 'adults' | 'children' | 'childrenAges'>) {
  const code = (value: string) => value.trim().toLowerCase();
  const days = watch.childrenAges?.length ? watch.childrenAges : Array.from({ length: watch.children || 0 }, () => 8);
  const params = new URLSearchParams({
    adultsv2: String(watch.adults),
    childrenv2: childrenParam(days),
    cabinclass: 'economy',
    rtn: '0',
    preferdirects: 'false',
  });
  return `https://www.skyscanner.it/transport/flights/${code(cell.origin)}/${code(cell.destination)}/${cell.date.slice(2, 4)}${cell.date.slice(5, 7)}${cell.date.slice(8, 10)}/?${params.toString()}`;
}

type Reading = { price: number; travellers: number; challenge: boolean; ready: boolean; stops: number | null; airline: string; text: string };

/** One snapshot: the declared cheapest, the party, and the first card's shape. */
async function readPage(page: any): Promise<Reading> {
  const raw = await page.evaluate(() => {
    const body = document.body.innerText.replace(/\s+/g, ' ');
    const challenge = /Sei una persona o un robot|Are you a robot|Access to this page has been denied/i.test(body);
    const tab = document.querySelector('[data-testid="FqsTab_CHEAPEST"]') as HTMLElement | null;
    const priceNode = document.querySelector('[data-testid="price-main-container"]') as HTMLElement | null;
    // The cheapest card: the first itinerary that carries a price, read with its surroundings.
    const card = priceNode?.closest('li, [data-testid*="itinerary"], [class*="Ticket"]') as HTMLElement | null;
    const travellers = Number((body.match(/(\d+)\s*(?:viaggiator|traveller)/i) || [])[1] || 0);
    return {
      challenge,
      tabText: tab ? (tab.innerText || '') : '',
      cardText: card ? (card.innerText || '').replace(/\s+/g, ' ').slice(0, 220) : '',
      travellers,
      text: body.slice(0, 300),
    };
  });
  const declared = raw.tabText.match(/(?:economico|cheapest)[^€]{0,12}€\s*([\d.,]+)/i) || raw.tabText.match(/€\s*([\d.,]+)/);
  const price = declared ? parseMoney(declared[1]) : 0;
  const stopsMatch = raw.cardText.match(/(\d+)\s*scal[oi]/i) || raw.cardText.match(/(\d+)\s*stop/i);
  const direct = /diretto|nonstop/i.test(raw.cardText);
  const airline = (raw.cardText.match(/\b([A-Z][A-Za-z&.\-]+(?:\s+[A-Z][A-Za-z&.\-]+){0,2})\b(?=[^€]*€)/) || [])[1] || '';
  return {
    price, travellers: raw.travellers, challenge: raw.challenge,
    ready: price > 0,
    stops: direct ? 0 : stopsMatch ? Number(stopsMatch[1]) : null,
    airline: /Voli|Skyscanner|Risultati/i.test(airline) ? '' : airline,
    text: raw.text,
  };
}

/** Wait for the results and then for the declared cheapest to stop changing. */
async function settle(page: any, cell: FlightCell, timeoutMs: number) {
  const startedAt = Date.now();
  const timeline: string[] = [];
  let previous = 0, stable = 0, latest: Reading | null = null;
  const maxMs = Math.max(25_000, Math.min(60_000, timeoutMs * 2));
  while (Date.now() - startedAt < maxMs) {
    const reading = await readPage(page);
    if (reading.challenge) return { challenge: true, reading, timeline };
    latest = reading;
    if (!reading.ready) { await sleep(1_000); continue; }
    if (reading.price === previous) stable++;
    else { stable = 1; previous = reading.price; timeline.push(`${Math.round((Date.now() - startedAt) / 1000)}s:€${reading.price}`); }
    debug(`${cell.key} ${Math.round((Date.now() - startedAt) / 1000)}s price=${reading.price} travellers=${reading.travellers || '-'} stable=${stable}`);
    // Four identical readings: the page has stopped moving and the number is the one on screen.
    if (stable >= 4 && Math.abs(Date.now() - startedAt) > 6_000) return { challenge: false, reading, timeline };
    await sleep(1_000);
  }
  return { challenge: false, reading: latest, timeline, timedOut: true };
}

export class SkyscannerScanner {
  async run(cells: FlightCell[], watch: FlightWatch, options: ScanOptions = {}): Promise<ScanResult> {
    const { default: puppeteer } = await import('puppeteer-core');
    const pauseMs = Math.max(1_000, options.pauseMs ?? watch.pauseMs ?? 10_000);
    const jitterMs = Math.max(0, options.jitterMs ?? 2_000);
    const cellTimeoutMs = Math.max(10_000, options.cellTimeoutMs ?? 30_000);
    const wanted = watch.adults + (watch.children || 0);
    const startedAt = Date.now();
    const observations: FlightObservation[] = [], failures: ScanResult['failures'] = [];
    let blocked = false, aborted = false;

    const profileDir = options.profileDir || DEFAULT_PROFILE();
    await mkdir(profileDir, { recursive: true }).catch(() => {});
    const connectUrl = options.connectUrl || (await detectDebuggableChrome());
    let browser: any, spawned: any = null;
    if (connectUrl) {
      browser = await puppeteer.connect({ browserURL: connectUrl, defaultViewport: null, protocolTimeout: cellTimeoutMs + 60_000 });
    } else {
      const started = await launchChrome(profileDir, { chromePath: options.chromePath ?? chromeExecutable(), headless: options.headless });
      spawned = started.child;
      browser = await puppeteer.connect({ browserURL: started.url, defaultViewport: null, protocolTimeout: cellTimeoutMs + 60_000 });
    }
    try {
      const open = await browser.pages().catch(() => [] as any[]);
      const blank = connectUrl ? null : open.find((candidate: any) => (candidate.url() || '').startsWith('about:'));
      // The tab stays open for the whole run: closing it while it loads is how prices get missed.
      const page = blank || await browser.newPage();
      await page.bringToFront?.().catch?.(() => {});
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
        const url = skyscannerUrl(cell, watch);
        const fail = (status: 'empty' | 'failed' | 'blocked', message: string) => {
          failures.push({ cellKey: cell.key, status, message });
          options.onProgress?.({ index, total: cells.length, cellKey: cell.key, status, ms: Date.now() - cellStarted, message });
        };
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: cellTimeoutMs });
          const settled = await settle(page, cell, cellTimeoutMs);
          if (settled.challenge) {
            blocked = true;
            fail('blocked', 'Skyscanner asked for a human check: open that window, solve it, then run again.');
            break;
          }
          const reading = settled.reading;
          if (!reading || !reading.ready) {
            fail('empty', settled.timedOut ? `Skyscanner never published a price for ${cell.date}.` : `No fare was shown for ${cell.date}.`);
            continue;
          }
          if (wanted > 1 && reading.travellers !== wanted) {
            fail('failed', `Skyscanner is quoting ${reading.travellers || 'an unknown number of'} travellers instead of ${wanted}: cell skipped.`);
            continue;
          }
          // Per-person quote → party total, which is what every other provider stores.
          const perPerson = reading.price;
          const total = Math.round(perPerson * wanted * 100) / 100;
          const observation: FlightObservation = {
            cellKey: cell.key, tripId: watch.tripId, direction: watch.direction,
            origin: cell.origin, destination: cell.destination, date: cell.date,
            provider: 'skyscanner',
            price: total,
            priceSource: 'header',
            currency: 'EUR',
            airline: reading.airline,
            stops: reading.stops,
            durationMinutes: null, departureAt: null, arrivalAt: null,
            options: 0,
            maxStops: watch.maxStops,
            travellers: wanted,
            headerPrice: total,
            headerCheaper: true,
            sourceUrl: url,
            provenance: `skyscanner · €${perPerson} per person × ${wanted} = €${total}, settled after ${settled.timeline.length} change${settled.timeline.length === 1 ? '' : 's'} (${settled.timeline.join(' → ') || 'none'})`,
            observedAt: new Date().toISOString(),
          };
          observations.push(observation);
          options.onProgress?.({ index, total: cells.length, cellKey: cell.key, status: 'observed', ms: Date.now() - cellStarted, price: total, observation });
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

export type { ScanOptions, ScanProgress, ScanResult };
export { MONTHS };
