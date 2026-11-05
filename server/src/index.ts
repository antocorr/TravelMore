import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { decodeRpcMessage } from 'rpcable';
import { createApp } from './app.js';
import { TravelStore } from './store.js';
import { TravelService } from './services/travel.js';
import { MediaStore } from './services/media.js';
import { RPC_CHANNEL, UserSession } from './rpc/UserSession.js';
import { assertSafeOrigin } from './security.js';
import { devIntercomConfig, localDevIntercom } from './agent/devIntercom.js';
import { flightMonitor } from './services/flightMonitor.js';
import { placeGeocoder } from './services/geocode.js';
import { TravelProviderStorage, migrateLegacyProviders, startModelCatalog } from './services/providers.js';

const intercom = devIntercomConfig();
if (process.env.TRAVELMORE_DEV_INTERCOM === '1') console.log(`[travelmore-server] local dev intercom: ${intercom ? 'enabled (loopback UI only)' : 'disabled (requires development mode, target ID, CLI and dev proxy)'}`);
const store = new TravelStore(); await store.open();
// A scan cannot survive a restart: close out runs the previous process left behind.
await flightMonitor(store).recoverInterrupted().then(result => { if (result.recovered) console.log(`[travelmore-server] closed ${result.recovered} interrupted flight scan${result.recovered === 1 ? '' : 's'}`); }).catch(() => {});
const hasProviderFile = existsSync(join(store.root, 'providers.json'));
const providers = await TravelProviderStorage.open(store.root);
if (!hasProviderFile) {
  try {
    const snapshot = store.snapshot();
    const migrated = await migrateLegacyProviders(providers, { providers: snapshot.providers, tripProviders: snapshot.tripProviders });
    if (migrated.connections || migrated.scopes) await store.transaction(data => { data.providers = []; data.tripProviders = {}; return null; });
  } catch (error) { console.warn('[travelmore-server] legacy provider migration skipped:', (error as Error).message); }
}
// Boot refresh of the models.dev catalogue: cached metadata first, network second, never blocking the socket.
startModelCatalog(providers);
const travel = new TravelService(store), media = new MediaStore(store.root), app = createApp(travel, media), server = createServer(app), wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
server.on('upgrade', (request, socket, head) => {
  if (new URL(request.url || '/', 'http://travelmore.invalid').pathname !== '/rpc') return;
  try { assertSafeOrigin(request); } catch { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
});
wss.on('connection', (socket, request) => {
  const session = new UserSession(socket, travel, media, placeGeocoder, providers, localDevIntercom(request, intercom));
  socket.on('message', frame => { const envelope = decodeRpcMessage(frame, RPC_CHANNEL); if (envelope) void session.receive(envelope).catch(error => console.warn('[travelmore-server] rpc dispatch failed:', error.message)); });
  socket.on('close', () => session.destroy()); socket.on('error', () => session.destroy());
});
const rawPort = Number(process.env.PORT); const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : 0;
const host = process.env.HOST || '127.0.0.1';
// Binding the API to the network removes the only thing protecting it (loopback). It is possible for a
// single-user LAN setup, but only when asked for explicitly.
const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
if (!loopback && process.env.TRAVELMORE_ALLOW_LAN !== '1') throw new Error('TravelMore refuses non-loopback HOST. The client reaches the API through the dev proxy; set TRAVELMORE_ALLOW_LAN=1 to expose the API on the network anyway.');
if (!loopback) console.warn('[travelmore-server] WARNING: listening on the network. Anyone who can reach this port can read and edit your trips and use your AI provider.');
server.listen(port, host, () => { const address = server.address() as AddressInfo; console.log(`[travelmore-server] ready on http://${loopback ? '127.0.0.1' : host}:${address.port}`); console.log(`[travelmore-server] health check: http://127.0.0.1:${address.port}/api/health`); });
async function close() { for (const socket of wss.clients) socket.terminate(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void close().finally(() => process.exit(0)); });
