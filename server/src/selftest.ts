import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TravelStore } from './store.js';
import { TravelService } from './services/travel.js';
import { executeJs, searchExa } from './services/tools.js';
import { MediaStore } from './services/media.js';
import { TravelAgentTools } from './agent/travelTools.js';
import { GEOCODER_MIN_INTERVAL_MS, PlaceGeocoder, resetGeocoderClock } from './services/geocode.js';
import { PlaceLocator, searchableTitle } from './services/placeLocator.js';
import { imageUrl, titleMatches } from './services/placeInfo.js';
import { isAllowedOrigin, isPrivateHostname } from './security.js';
import { resolveAirportInput, searchAirports } from './services/airports.js';
import { buildCells, cellKey, datesBetween, normalizeWatch } from './services/flights/matrix.js';
import { cheapestByDate, priceSeries, recordObservation } from './services/flights/history.js';
import { parseResultLabel, resolvedCity, searchUrl } from './services/flights/googleScanner.js';
import { TravelProviderStorage, planManager, saveProviderConnection, createOpenAICodexConnection, deleteProviderConnection, configureProvider, deleteScopeProvider, providerInfo, listProviderConnections, agentSettings, migrateLegacyProviders, projectModelCatalog, codexCatalogGroup } from './services/providers.js';

const now = () => new Date().toISOString();
const root = await mkdtemp(join(tmpdir(), 'travelmore-test-'));
try {
  const store = new TravelStore(root); await store.open(); const travel = new TravelService(store);
  const trip = await travel.createNode({ parentId: null, type: 'trip', title: 'China' });
  const japan = await travel.createNode({ parentId: null, type: 'trip', title: 'Japan' });
  const japanStop = await travel.createNode({ parentId: japan.node.id, type: 'stop', title: 'Tokyo' });
  const providers = await TravelProviderStorage.open(root);
  await assert.rejects(() => saveProviderConnection(providers, { name: ' ', baseUrl: 'nope', api: 'nope', auth: 'nope' }), /name|HTTP/);
  // models.dev projection: only text+tool models on a public HTTPS endpoint survive.
  const projected = projectModelCatalog({ updatedAt: '2026-01-01T00:00:00.000Z', providers: {
    openai: { id: 'openai', name: 'OpenAI', npm: '@ai-sdk/openai', env: ['OPENAI_API_KEY'], models: {
      good: { id: 'good', name: 'Good model', npm: '@ai-sdk/openai', provider: { shape: 'responses' }, tool_call: true, reasoning: true, modalities: { input: ['text', 'image'], output: ['text'] }, limit: { context: 200_000, output: 8_000 } },
      noimage: { id: 'noimage', name: 'Tool-less', tool_call: false, modalities: { input: ['text'], output: ['text'] }, limit: { context: 100_000, output: 8_000 } },
      small: { id: 'small', name: 'Tiny context', tool_call: true, modalities: { input: ['text'], output: ['text'] }, limit: { context: 4096, output: 1024 } },
      audio: { id: 'audio', name: 'Audio only', tool_call: true, modalities: { input: ['audio'], output: ['text'] }, limit: { context: 100_000, output: 8_000 } },
    } },
    local: { id: 'local', name: 'Local', npm: '@ai-sdk/openai-compatible', api: 'http://127.0.0.1:11434/v1', env: [], models: {
      only: { id: 'only', name: 'Only', tool_call: true, modalities: { input: ['text'], output: ['text'] }, limit: { context: 100_000, output: 8_000 } },
    } },
  } }, 'fresh');
  // ChatGPT models are not on models.dev: the Codex group is always published first, never as a preset form.
  assert.equal(projected.groups[0].id, 'openai-codex'); assert.equal(projected.groups[0].api, 'openai-codex-responses'); assert.equal(projected.groups[0].auth, 'oauth');
  assert.ok(projected.groups[0].models.length >= 5 && projected.groups[0].models.every(model => model.reasoning === true));
  assert.equal(codexCatalogGroup().baseUrl, 'https://chatgpt.com/backend-api');
  assert.equal(projected.groups.length, 2, 'Non-HTTPS endpoints and unsupported models are dropped');
  assert.equal(projected.groups[1].id, 'openai');
  assert.equal(projected.groups[1].api, 'openai-responses', 'Model shape overrides the provider protocol');
  assert.equal(projected.groups[1].auth, 'apiKey');
  assert.deepEqual(projected.groups[1].models.map(model => model.model), ['good']);
  assert.equal(projected.groups[1].models[0].reasoning, true); assert.equal(projected.groups[1].models[0].vision, true);
  assert.equal(projected.omitted, 4);
  // The Nominatim rate limit is enforced by the process, not by convention.
  assert.ok(GEOCODER_MIN_INTERVAL_MS >= 1_000, 'The default pacing must respect the one-request-per-second policy');
  resetGeocoderClock();
  const requestAt: number[] = [];
  // Real timers, not a mock clock: macOS can fire a 60 ms timer a few ms early on a loaded machine,
  // so the tolerance covers jitter. The product default (1.100 ms) is asserted above.
  const PACE_MS = 60, PACE_TOLERANCE_MS = 15;
  const paced = new PlaceGeocoder({ minIntervalMs: PACE_MS, read: async url => { requestAt.push(Date.now()); return { status: 200, body: { place_id: 1, display_name: 'X', lat: '1', lon: '2', address: {} } } } });
  await Promise.all([paced.search({ query: 'first' }), paced.search({ query: 'second' }), paced.search({ query: 'third' })]);
  assert.equal(requestAt.length, 3, 'Three concurrent searches make three requests');
  const gaps = requestAt.slice(1).map((at, index) => at - requestAt[index]);
  assert.ok(gaps.every(gap => gap >= PACE_MS - PACE_TOLERANCE_MS), `Concurrent searches must be spaced out, got ${gaps.join(', ')}`);
  const sent = requestAt.length;
  await paced.search({ query: 'fourth' });
  assert.ok(requestAt[sent] - requestAt[sent - 1] >= PACE_MS - PACE_TOLERANCE_MS, 'A later search waits for the next slot');
  // A 403 pauses the provider instead of retrying it into a ban.
  resetGeocoderClock();
  let attempts = 0;
  const limited = new PlaceGeocoder({ minIntervalMs: 0, read: async () => { attempts++; return { status: 403, body: null } } });
  const first = await limited.search({ query: 'rate limited' });
  assert.equal(first.status, 'unavailable');
  assert.match(String(first.message), /rate limiting/);
  const second = await limited.search({ query: 'rate limited again' });
  assert.match(String(second.message), /rate limited: retry in/);
  assert.equal(attempts, 1, 'A paused provider receives exactly one request, not one per call');
  // Airports by name: nobody should have to remember IATA codes.
  const codeOf = (value: string) => { const resolved = resolveAirportInput(value); return 'code' in resolved ? resolved.code : ''; };
  assert.equal(codeOf('Shenzhen'), 'SZX', 'A city name resolves to its airport');
  assert.equal(codeOf('Catania'), 'CTA');
  assert.equal(codeOf('hong kong'), 'HKG');
  assert.equal(codeOf('Macau'), 'MFM', 'The dataset municipality is replaced by the name people type');
  assert.equal(codeOf('SZX'), 'SZX', 'A code still works');
  assert.equal(codeOf('SZH'), 'SZH', 'A valid but unexpected code is accepted…');
  const wrong = resolveAirportInput('SZH');
  assert.match('airport' in wrong && wrong.airport ? wrong.airport.city : '', /Shuozhou/, '…and it says which city it really is');
  assert.ok('error' in resolveAirportInput('Hong Kong Island'), 'An unknown place is refused instead of guessed');
  assert.ok('error' in resolveAirportInput('Nothing Like This'), 'and the message explains what to type');
  assert.equal(searchAirports('shenzhen', 3)[0].code, 'SZX');
  assert.equal(searchAirports('zzz', 3).length, 0);
  // LAN access: the app must work from a phone, but a public website must never drive the server.
  assert.equal(isAllowedOrigin('http://127.0.0.1:5173'), true);
  assert.equal(isAllowedOrigin('http://localhost:5173'), true);
  assert.equal(isAllowedOrigin('http://192.168.1.2:59181'), true, 'A private LAN origin is allowed');
  assert.equal(isAllowedOrigin('http://10.0.0.7:3000'), true);
  assert.equal(isAllowedOrigin('http://172.20.5.4:3000'), true);
  assert.equal(isAllowedOrigin('http://macbook.local:5173'), true, 'An mDNS name only resolves inside the LAN');
  // Tailscale: the magic link must work, both as a 100.x address and as a MagicDNS name.
  assert.equal(isAllowedOrigin('http://100.100.10.20:57156'), true, 'A tailnet address is allowed');
  assert.equal(isAllowedOrigin('http://100.64.0.1:57156'), true, '100.64.0.0/10 starts at 100.64');
  assert.equal(isAllowedOrigin('http://100.127.255.254:57156'), true, 'and ends at 100.127');
  assert.equal(isAllowedOrigin('http://100.128.0.1:57156'), false, '100.128 is outside the CGNAT block');
  assert.equal(isAllowedOrigin('http://100.63.255.255:57156'), false, 'so is 100.63');
  assert.equal(isAllowedOrigin('http://macbook.tailnet-1a2b.ts.net'), true, 'A MagicDNS name is allowed');
  assert.equal(isAllowedOrigin('http://ts.net.evil.example'), false, 'A lookalike domain is not');
  assert.equal(isAllowedOrigin('https://macbook.tailnet-1a2b.ts.net'), false, 'Origin check stays http-only');
  assert.equal(isAllowedOrigin('https://evil.example'), false, 'A public origin stays rejected');
  assert.equal(isAllowedOrigin('http://8.8.8.8'), false, 'A public IP stays rejected');
  assert.equal(isAllowedOrigin('http://172.32.0.1'), false, '172.32 is outside the private range');
  assert.equal(isAllowedOrigin('null'), false);
  assert.equal(isPrivateHostname('fe80::1'), true); assert.equal(isPrivateHostname('fd00::10'), true);
  assert.equal(isPrivateHostname('2001:4860:4860::8888'), false);
  process.env.TRAVELMORE_ALLOWED_ORIGINS = 'https://trips.example.com';
  assert.equal(isAllowedOrigin('https://trips.example.com'), true, 'An explicit allowlist wins');
  assert.equal(isAllowedOrigin('http://192.168.1.2:59181'), false, 'With an allowlist, nothing else is trusted');
  delete process.env.TRAVELMORE_ALLOWED_ORIGINS;
  // A flight run covers the whole matrix: no sampling, and the history only grows on a real change.
  const watchTrip = '11111111-1111-4111-8111-111111111111';
  const watch = normalizeWatch({ direction: 'outbound', origins: ['FCO'], destinations: ['MFM', 'HKG'], from: '2026-12-01', to: '2026-12-03', pauseMs: 5_000 }, watchTrip);
  const cells = buildCells(watch);
  assert.equal(cells.length, 6, 'One origin × two destinations × three dates is six cells');
  assert.deepEqual(datesBetween('2026-12-30', '2027-01-02'), ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02'], 'The window is inclusive and crosses the year');
  assert.equal(cells[0].key, 'outbound|FCO|MFM|2026-12-01');
  assert.throws(() => normalizeWatch({ origins: ['FCO'], destinations: ['MFM'], from: '2026-12-05', to: '2026-12-01' }, watchTrip), /ends before it starts/);
  assert.throws(() => normalizeWatch({ origins: ['FCO'], destinations: ['MFM'], from: '2026-12-01', to: '2026-12-02', pauseMs: 10 }, watchTrip), /pause/);
  assert.throws(() => normalizeWatch({ direction: 'sideways', origins: ['FCO'], destinations: ['MFM'], from: '2026-12-01', to: '2026-12-02' }, watchTrip), /Direction/);
  // Travellers: adults and children, nine in total, and never in the URL (it breaks the IATA query).
  const family = normalizeWatch({ origins: ['FCO'], destinations: ['MFM'], from: '2026-12-01', to: '2026-12-01', adults: 2, children: 1 }, watchTrip);
  assert.equal(family.adults, 2); assert.equal(family.children, 1);
  assert.throws(() => normalizeWatch({ origins: ['FCO'], destinations: ['MFM'], from: '2026-12-01', to: '2026-12-01', adults: 8, children: 4 }, watchTrip), /9 travellers/);
  assert.throws(() => normalizeWatch({ origins: ['FCO'], destinations: ['MFM'], from: '2026-12-01', to: '2026-12-01', children: 12 }, watchTrip), /Children/);
  const url = searchUrl({ origin: 'FCO', destination: 'MFM', date: '2026-12-01' }, family);
  assert.ok(url.includes('FCO') && url.includes('2026-12-01'), 'The URL carries route and date');
  assert.ok(!/adult|child/i.test(decodeURIComponent(url)), 'Travellers must be set in the panel, not in the query');
  // A wrong airport code must be explained, not just reported as "empty".
  const empty = 'Skip to main content Explore Flights Flight search One way 1 Economy Catania CTA Shuozhou SZH Filters All filters Search results No results';
  assert.equal(resolvedCity(empty, 'CTA', 'SZH'), 'Shuozhou', 'SZH is Shuozhou, and the platform says so');
  assert.equal(resolvedCity('Flight search One way 1 Economy Catania CTA Ho Chi Minh City SGN Filters', 'CTA', 'SGN'), 'Ho Chi Minh City');
  assert.equal(resolvedCity('nothing useful here', 'CTA', 'SZH'), '');
  const label = 'From 448 euros. 1 stop flight with Saudia. Leaves Leonardo da Vinci International Airport at 3:50 PM on Saturday, January 9 and arrives at Guangzhou Baiyun International Airport at 3:25 PM on Sunday, January 10. Total duration 15 hr 40 min. Layover (1 of 1) is a 2 hr 15 min layover at King Khalid International Airport.';
  const parsed = parseResultLabel(label, '2027-01-09');
  assert.equal(parsed?.price, 448); assert.equal(parsed?.currency, 'EUR'); assert.equal(parsed?.stops, 1); assert.equal(parsed?.airline, 'Saudia');
  assert.equal(parsed?.durationMinutes, 940); assert.equal(parsed?.departureAt, '2027-01-09T15:50'); assert.equal(parsed?.arrivalAt, '2027-01-10T15:25');
  assert.equal(parseResultLabel(label, '2026-12-20')?.departureAt, '2027-01-09T15:50', 'A January arrival rolls into the next year for a December cell');
  assert.equal(parseResultLabel('No flights found', '2027-01-09'), null);
  assert.equal(cellKey({ direction: 'return', origin: 'hkg', destination: 'fco', date: '2027-01-06' }), 'return|HKG|FCO|2027-01-06');
  // History: same price twice is one point, a different price is a second point.
  const data: any = { flightOffers: [], flightPrices: [] };
  const base = { cellKey: cells[0].key, tripId: watchTrip, direction: 'outbound' as const, origin: 'FCO', destination: 'MFM', date: '2026-12-01', provider: 'google-flights', price: 625, currency: 'EUR', airline: 'ITA', stops: 2, durationMinutes: 1225, departureAt: null, arrivalAt: null, sourceUrl: 'https://example.org/x', provenance: 'test' };
  assert.equal(recordObservation(data, { ...base, observedAt: '2026-10-26T10:00:00.000Z' }, 'run-1').priceRecorded, true);
  assert.equal(recordObservation(data, { ...base, observedAt: '2026-10-26T11:00:00.000Z' }, 'run-2').priceRecorded, false, 'An unchanged price must not add a history row');
  assert.equal(recordObservation(data, { ...base, price: 648, observedAt: '2026-10-26T12:00:00.000Z' }, 'run-3').priceRecorded, true);
  assert.equal(data.flightOffers.length, 1, 'The offer row is replaced, never duplicated');
  assert.equal(data.flightOffers[0].price, 648, 'The offer row carries the latest price');
  assert.deepEqual(priceSeries(data.flightPrices, cells[0].key).map(point => point.price), [625, 648]);
  assert.equal(cheapestByDate(data.flightOffers, watchTrip)[0].price, 648);
  // Place enrichment must clean titles and refuse a loose encyclopedia match.
  assert.equal(searchableTitle('G1 · Shenzhen Museum (Storia e Cultura)'), 'Shenzhen Museum');
  assert.equal(searchableTitle('G2 · Shenzhen Bay Park — passeggiata sul mare'), 'Shenzhen Bay Park');
  assert.equal(titleMatches('Shenzhen Museum', 'Shenzhen Museum'), true);
  assert.equal(titleMatches('Ping An Finance Centre', 'Ping An Finance Center'), true, 'British and American spellings must not block a match');
  assert.equal(titleMatches('Civic Center Piazza', 'Cara Lee'), false, 'A biography must never describe a city square');
  assert.equal(titleMatches('OCT-LOFT Creative Culture Park', 'Ningbo'), false);
  assert.equal(titleMatches('Shenzhen Talent Park', 'Talent Park station'), false, 'A metro station is not the park');
  assert.equal(titleMatches('Shenzhen Talent Park', 'Shenzhen Talent Park'), true);
  // Photographs must be https and used exactly as the source served them (Wikimedia rejects rewritten widths).
  assert.equal(imageUrl({ source: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/2560px-X.jpg' }), 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/2560px-X.jpg');
  assert.equal(imageUrl({ source: '//upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg' }), 'https://upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg');
  assert.equal(imageUrl({ source: 'http://insecure.example/x.jpg' }), null, 'Plain http images are refused');
  // Connection + selection lifecycle through the same code the RPC layer uses.
  const saved = await saveProviderConnection(providers, { name: 'Local mock', baseUrl: 'http://127.0.0.1:9999/v1', api: 'openai-completions', auth: 'apiKey', apiKey: 'secret-key' });
  assert.equal(saved.connections.length, 1); assert.equal(saved.connections[0].hasKey, true); assert.equal(saved.connections[0].auth, 'apiKey');
  const connectionId = saved.connectionId;
  await assert.rejects(() => saveProviderConnection(providers, { id: connectionId, name: 'Local mock', baseUrl: 'http://127.0.0.1:9997/v1', api: 'openai-completions', auth: 'apiKey' }), /API key/, 'A stored key is never reused across origins');
  // OAuth is a server-owned sign-in, never a form field the browser can assert.
  await assert.rejects(() => saveProviderConnection(providers, { name: 'Fake ChatGPT', baseUrl: 'https://chatgpt.com/backend-api', api: 'openai-codex-responses', auth: 'oauth' }), /sign-in/);
  await assert.rejects(() => saveProviderConnection(providers, { id: connectionId, name: 'Local mock', baseUrl: 'http://127.0.0.1:9999/v1', api: 'openai-completions', auth: 'oauth' }), /sign-in/);
  const codexId = await createOpenAICodexConnection(providers, 'Codex test');
  const codex = (await listProviderConnections(providers)).find(item => item.id === codexId)!;
  assert.equal(codex.api, 'openai-codex-responses'); assert.equal(codex.auth, 'none'); assert.equal(codex.hasKey, false);
  // Pi writes this record during sign-in; the selection cannot resolve without it.
  await planManager(providers).createProviderAuth('owner', codexId, { type: 'oauth', data: { access: 'token', refresh: 'refresh', accountId: 'acct' }, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), label: 'ChatGPT OAuth' });
  await configureProvider(providers, 'workspace', { providerId: codexId, model: 'gpt-6.1-sol', api: 'openai-codex-responses', contextWindow: 500_000, maxTokens: 128_000, reasoning: true, vision: true, thinking: 'high' });
  const codexInfo = await providerInfo(providers, 'workspace');
  assert.equal(codexInfo.model, 'gpt-6.1-sol'); assert.equal(codexInfo.auth, 'oauth'); assert.equal(codexInfo.thinking, 'high');
  const codexSettings = await agentSettings(providers, 'workspace');
  assert.equal(codexSettings.oauth, true); assert.equal(codexSettings.apiKey, '', 'ChatGPT sign-in never exposes a key to the agent settings');
  assert.equal(codexSettings.providerId, codexId);
  await deleteProviderConnection(providers, codexId);
  assert.equal((await providerInfo(providers, 'workspace')).configured, false, 'Deleting the Codex connection clears the selection');
  const retained = await saveProviderConnection(providers, { id: connectionId, name: 'Local mock', baseUrl: 'http://127.0.0.1:9999/v1', api: 'openai-completions', auth: 'apiKey' });
  assert.equal(retained.connections[0].hasKey, true, 'A blank key keeps the stored one on the same origin');
  const selection = { providerId: connectionId, model: 'mock-model', api: 'openai-completions', contextWindow: 128_000, maxTokens: 8192, reasoning: true, vision: false, thinking: 'low' };
  await assert.rejects(() => configureProvider(providers, 'workspace', { ...selection, maxTokens: 999_999 }), /half the context window/);
  await assert.rejects(() => configureProvider(providers, 'workspace', { ...selection, thinking: 'ultra' }), /Thinking level/);
  const workspaceInfo = await configureProvider(providers, 'workspace', selection);
  assert.equal(workspaceInfo.configured, true); assert.equal(workspaceInfo.model, 'mock-model'); assert.equal(workspaceInfo.inherited, false); assert.equal(workspaceInfo.thinking, 'low');
  const inheritedInfo = await providerInfo(providers, trip.node.id);
  assert.equal(inheritedInfo.inherited, true); assert.equal(inheritedInfo.providerId, connectionId);
  const ownInfo = await configureProvider(providers, trip.node.id, { ...selection, model: 'trip-model' });
  assert.equal(ownInfo.inherited, false); assert.equal(ownInfo.model, 'trip-model');
  const settings = await agentSettings(providers, trip.node.id);
  assert.equal(settings.model, 'trip-model'); assert.equal(settings.apiKey, 'secret-key'); assert.equal(settings.contextWindow, 128_000); assert.equal(settings.reasoning, true);
  await deleteScopeProvider(providers, trip.node.id);
  assert.equal((await providerInfo(providers, trip.node.id)).inherited, true, 'Removing the override returns to the shared selection');
  // Legacy records from the previous flat model are migrated once, keeping connections and selections.
  const legacyProviders = await TravelProviderStorage.open(join(root, 'legacy'));
  const legacy = await migrateLegacyProviders(legacyProviders, { providers: [{ id: 'c0ffee00-0000-4000-8000-000000000000', name: 'Old', provider: 'openai-completions', model: 'old-model', apiKey: 'old-key', baseUrl: 'http://127.0.0.1:9998/v1', createdAt: now(), updatedAt: now() }], tripProviders: { [japan.node.id]: 'c0ffee00-0000-4000-8000-000000000000' } });
  assert.deepEqual(legacy, { connections: 1, scopes: 1 });
  assert.equal((await providerInfo(legacyProviders, japan.node.id)).model, 'old-model');
  assert.equal((await listProviderConnections(legacyProviders))[0].hasKey, true);
  assert.equal((await deleteProviderConnection(providers, connectionId)).connections.length, 0);
  assert.equal((await providerInfo(providers, 'workspace')).configured, false, 'Deleting the connection also clears its selections');
  const agentTools = new TravelAgentTools(travel, trip.node.id);
  await assert.rejects(() => agentTools.execute('update_node', { id: trip.node.id, patch: { lat: 22.5, lng: 113.9, address: 'Airline HQ' } }), /Trip titles are not geocoded/);
  assert.ok(agentTools.definitions.some(tool => tool.name === 'place_info') && agentTools.definitions.some(tool => tool.name === 'complete_place') && agentTools.definitions.some(tool => tool.name === 'complete_places'));
  await assert.rejects(() => agentTools.execute('complete_place', { id: trip.node.id }), /Trip titles are not geocoded/);
  await assert.rejects(() => agentTools.execute('create_node', { parentId: japan.node.id, type: 'stop', title: 'Forbidden' }), /current trip/);
  await assert.rejects(() => agentTools.execute('get_node_detail', { id: japanStop.node.id }), /outside this chat trip/);
  await assert.rejects(() => agentTools.execute('save_todo', { nodeId: japanStop.node.id, title: 'Forbidden' }), /outside this chat trip/);
  const forcedSearch: any = await agentTools.execute('search_flights', { tripId: japan.node.id, origins: ['CTA'], destinations: ['SZX'], departure: { from: '2026-12-01', to: '2026-12-05' } }); assert.equal(forcedSearch.search.tripId, trip.node.id);
  const stop = await travel.createNode({ parentId: trip.node.id, type: 'stop', title: 'Chengdu', lat: 30.57, lng: 104.06, address: 'Chengdu, Sichuan, Cina', startDate: '2099-03-12' });
  const secondStop = await travel.createNode({ parentId: trip.node.id, type: 'stop', title: 'Rome', startDate: '2099-03-20' });
  const place = await travel.createNode({ parentId: stop.node.id, type: 'place', title: 'Panda Center' });
  assert.equal(stop.node.address, 'Chengdu, Sichuan, Cina'); assert.equal((await travel.updateNode({ id: stop.node.id, patch: { address: '  ' } })).node.address, null);
  await travel.saveTodo({ nodeId: stop.node.id, title: 'Book panda center' });
  const media = new MediaStore(root), uploaded = await media.put(Buffer.from([0xff, 0xd8, 0xff, 0x00]));
  const firstImage = (await travel.saveImage({ nodeId: stop.node.id, url: `/media/${uploaded.id}`, provenance: 'Local upload' })).image;
  const secondImage = (await travel.saveImage({ nodeId: stop.node.id, url: 'https://example.org/second.jpg', provenance: 'Second' })).image;
  assert.equal(firstImage.isPrimary, true); assert.equal(secondImage.isPrimary, false);
  assert.equal((await travel.saveImage({ id: secondImage.id, nodeId: stop.node.id, isPrimary: true })).image.isPrimary, true);
  assert.equal(travel.getNodeDetail({ id: stop.node.id }).assets.find(image => image.id === firstImage.id)?.isPrimary, false);
  await travel.deleteImage({ id: secondImage.id });
  assert.equal(travel.getNodeDetail({ id: stop.node.id }).assets.find(image => image.id === firstImage.id)?.isPrimary, true, 'Deleting the primary promotes the next image.');
  await travel.saveImage({ nodeId: trip.node.id, url: `/media/${uploaded.id}`, provenance: 'Shared local upload' });
  const dashboard = travel.listTrips().trips.find(item => item.id === trip.node.id)!; assert.deepEqual(dashboard.stats, { stops: 2, places: 1, images: 2, openTodos: 1, pinned: 1, stopNames: ['Chengdu', 'Panda Center', 'Rome'] }); assert.equal(dashboard.cover, `/media/${uploaded.id}`); assert.deepEqual(dashboard.nextStop, { id: stop.node.id, title: 'Chengdu', startDate: '2099-03-12' });
  assert.equal(travel.getTripTree({ tripId: trip.node.id }).nodes.length, 4);
  assert.equal(travel.getNodeDetail({ id: stop.node.id }).todos.length, 1); assert.equal(travel.getNodeDetail({ id: stop.node.id }).assets.length, 1);
  const flights = await travel.searchFlights({ tripId: trip.node.id, origins: ['CTA'], destinations: ['SZX'], departure: { from: '2026-12-01', to: '2026-12-05' } });
  assert.equal(flights.search.status, 'unavailable'); assert.equal(flights.results.length, 0); assert.equal(flights.search.sources.length, 2);
  const candidate = await travel.saveFlightCandidate({ searchId: flights.search.id, origin: 'CTA', destination: 'SZX', provider: 'Skyscanner API', sourceUrl: 'https://example.com/quote/1', provenance: 'licensed API quote #1', fetchedAt: '2026-01-01T00:00:00.000Z', price: 600, currency: 'EUR' });
  assert.equal(candidate.candidate.status, 'observed');
  const js = await executeJs({ code: 'return input.values.map(value => value * 2)', input: { values: [2, 3] } }); assert.deepEqual(js, { result: [4, 6] });
  const searchText = 'Title: Fujian Tulou - UNESCO\nURL: https://whc.unesco.org/en/list/1113/\nHighlights:\nWorld Heritage earthen houses.\n---\nTitle: Unsafe\nURL: http://internal.example/result\nHighlights:\nDiscard me.';
  const searchEnvelope = `event: message\ndata: ${JSON.stringify({ result: { content: [{ type: 'text', text: searchText }] } })}\n\n`;
  const exa = await searchExa('Fujian Tulou', 3, (async (url, init) => {
    assert.equal(url, 'https://mcp.exa.ai/mcp?tools=web_search_exa'); assert.equal(init?.redirect, 'error');
    const request = JSON.parse(String(init?.body)); assert.equal(request.params.arguments.query, 'Fujian Tulou');
    return new Response(searchEnvelope, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch);
  assert.equal(exa.status, 'observed'); assert.equal(exa.results.length, 1); assert.equal(exa.results[0].provider, 'exa');
  assert.equal(exa.results[0].url, 'https://whc.unesco.org/en/list/1113/'); assert.match(exa.results[0].snippet, /earthen houses/);
  // Place autocomplete: stubbed provider transport, deterministic and offline.
  const calls: string[] = [];
  const geocoder = new PlaceGeocoder({ minIntervalMs: 0, cacheTtlMs: 60_000, read: async url => {
    calls.push(url);
    if (url.includes('/reverse')) return { status: 200, body: { name: 'Panda Base', display_name: 'Panda Base, Chenghua, Chengdu, Cina', lat: '30.73', lon: '104.15', address: { city: 'Chengdu', country: 'Cina' } } };
    return { status: 200, body: [
      { place_id: 1, osm_type: 'node', osm_id: 2, lat: '30.731', lon: '104.146', category: 'tourism', type: 'attraction', name: 'Panda Base', display_name: 'Panda Base, Chengdu, Cina', importance: 0.5, address: { city: 'Chengdu', country: 'Cina' } },
      { place_id: 3, lat: 'broken', lon: 'nope', display_name: 'Broken record' },
    ] };
  } });
  const found = await geocoder.search({ query: 'Panda Base', limit: 5 });
  assert.equal(found.status, 'observed'); assert.equal(found.results.length, 1); assert.equal(found.results[0].lat, 30.731); assert.equal(found.results[0].locality, 'Chengdu'); assert.equal(found.cached, false);
  assert.match(calls[0], /\/search\?format=jsonv2&q=Panda\+Base/);
  const repeat = await geocoder.search({ query: 'Panda Base', limit: 5 }); assert.equal(repeat.cached, true); assert.equal(calls.length, 1, 'Repeated queries must be served from cache');
  const located = await geocoder.reverse({ lat: 30.73, lng: 104.15 }); assert.equal(located.status, 'observed'); assert.equal(located.place?.name, 'Panda Base'); assert.match(calls[1], /\/reverse\?format=jsonv2&lat=30\.73&lon=104\.15/);
  await assert.rejects(() => geocoder.search({ query: 'x' }), /2 to 200/);
  await assert.rejects(() => geocoder.reverse({ lat: 200, lng: 0 }), /valid lat and lng/);
  const flaky = new PlaceGeocoder({ minIntervalMs: 0, read: async () => { throw new Error('offline'); } });
  const unavailable = await flaky.search({ query: 'Chengdu' }); assert.equal(unavailable.status, 'unavailable'); assert.deepEqual(unavailable.results, []);
  assert.equal((await flaky.reverse({ lat: 1, lng: 1 })).status, 'unavailable');
  const agentPlaces: any = await new TravelAgentTools(travel, trip.node.id, geocoder).execute('search_places', { query: 'Panda Base' }); assert.equal(agentPlaces.results[0].name, 'Panda Base');
  await assert.rejects(() => travel.createNode({ parentId: null, type: 'trip', title: 'Natale alle Hawaii', lat: 39, lng: -77 }), /thematic/);
  const legacyTrip = await travel.createNode({ parentId: null, type: 'trip', title: 'Vacanza sul Nilo' });
  await store.transaction(data => { const legacy = data.nodes.find(node => node.id === legacyTrip.node.id)!; legacy.lat = 39; legacy.lng = -77; legacy.address = 'Old airline result'; });
  const legacyStop = await travel.createNode({ parentId: legacyTrip.node.id, type: 'stop', title: 'Fujian Tulou' });
  const legacyQueries: string[] = [];
  const legacyGeocoder = new PlaceGeocoder({ minIntervalMs: 0, read: async url => { legacyQueries.push(url); return { status: 200, body: [] }; } });
  await new PlaceLocator(travel, legacyGeocoder, { lookup: async () => ({ status: 'not_found' }) } as any).complete(legacyStop.node.id);
  assert.ok(legacyQueries.length > 0 && legacyQueries.every(url => !url.includes('viewbox=')), 'An old wrong trip pin must never bias place searches.');
  await travel.updateNode({ id: legacyStop.node.id, patch: { lat: 25.771, lng: 117.636 } });
  let releaseLookup!: () => void, lookupStarted!: () => void;
  const heldLookup = new Promise<void>(resolve => { releaseLookup = resolve; });
  const lookupEntered = new Promise<void>(resolve => { lookupStarted = resolve; });
  const delayed = new PlaceLocator(travel, legacyGeocoder, { lookup: async () => {
    lookupStarted(); await heldLookup;
    return { status: 'observed', title: 'Fujian Tulou', description: 'Stale source text', imageUrl: 'https://example.org/stale.jpg', pageUrl: 'https://example.org/article', attribution: 'Wikipedia', lat: 25.771, lng: 117.636 };
  } } as any);
  const pendingCompletion = delayed.complete(legacyStop.node.id);
  await lookupEntered;
  await travel.updateNode({ id: legacyStop.node.id, patch: { title: 'A different place' } });
  releaseLookup();
  const stale = await pendingCompletion;
  assert.match(stale.reason || '', /changed during research/);
  assert.equal(travel.getNodeDetail({ id: legacyStop.node.id }).node.description, '');
  assert.equal(travel.getNodeDetail({ id: legacyStop.node.id }).assets.length, 0, 'A renamed place must not inherit stale source photos');
  await assert.rejects(() => travel.updateNode({ id: legacyTrip.node.id, patch: { lat: 22 } }), /thematic/);
  const cleared = await travel.updateNode({ id: legacyTrip.node.id, patch: { lat: null, lng: null, address: '' } });
  assert.equal(cleared.node.lat, null); assert.equal(cleared.node.address, null);
  assert.ok(travel.getTripTree({ tripId: trip.node.id }).nodes.every(node => 'address' in node));
  const removed = await travel.deleteNode({ id: trip.node.id }); assert.equal(removed.deleted.length, 4); assert.throws(() => travel.listFlightSearches({ tripId: trip.node.id }), /Trip not found/);
  console.log('travelmore self-test: PASS');
} finally { await rm(root, { recursive: true, force: true }); }
