import { RpcAbleReceiver, RpcAbleSender, destroy, dispatch, type RpcEnvelope } from 'rpcable';
import type { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { TravelService } from '../services/travel.js';
import { executeJs, readWeb, searchWeb } from '../services/tools.js';
import { TravelAgent } from '../agent/TravelAgent.js';
import type { DevIntercomConfig } from '../agent/devIntercom.js';
import { MediaStore } from '../services/media.js';
import { PlaceGeocoder, placeGeocoder } from '../services/geocode.js';
import { PlaceLocator } from '../services/placeLocator.js';
import { placeInfoService } from '../services/placeInfo.js';
import { flightMonitor } from '../services/flightMonitor.js';
import { searchAirports } from '../services/airports.js';
import { getModelCatalog, refreshModelCatalog, listProviderConnections, saveProviderConnection, createOpenAICodexConnection, deleteProviderConnection, providerInfo, configureProvider, deleteScopeProvider, providerConfigured, agentSettings, type TravelProviderStorage } from '../services/providers.js';
import { createServer as createPortProbe } from 'node:net';
import { OPENAI_CODEX_PROVIDER, openAIDeviceId, openAICodexRuntime } from '../agent/OpenAICodex.js';

const methods = ['pings', 'listTrips', 'getTripTree', 'getNodeDetail', 'createNode', 'updateNode', 'moveNode', 'deleteNode', 'saveTodo', 'deleteTodo', 'saveImage', 'deleteImage', 'searchFlights', 'listFlightSearches', 'saveFlightCandidate', 'deleteFlightCandidate', 'getModelCatalog', 'refreshModelCatalog', 'listProviderConnections', 'saveProviderConnection', 'deleteProviderConnection', 'getProvider', 'configureProvider', 'connectOpenAICodex', 'completePlaces', 'placeInfo', 'searchAirports', 'resetFlightData', 'saveFlightWatch', 'listFlightWatches', 'previewFlightWatch', 'deleteFlightWatch', 'startFlightScan', 'getFlightScan', 'cancelFlightScan', 'rescanFlightCell', 'flightOverview', 'flightHistory', 'getOpenAICodexLogin', 'cancelOpenAICodexLogin', 'getChat', 'startChat', 'compactChat', 'cancelChat', 'getAgentStatus', 'searchPlaces', 'reversePlace', 'searchWeb', 'readWeb', 'executeJs'];
const permissions = Object.fromEntries(methods.map(method => [method, { call: ['user'] }]));
export const RPC_CHANNEL = '-userSession';
export type CodexLoginState = { id: string; status: 'idle' | 'preparing' | 'ready' | 'connected' | 'error' | 'cancelled'; active: boolean; url: string; error: string; connectionId: string; connections: any[] };
/** One WebSocket peer. Calls map directly to the frozen TravelMore RPC contract; no string router exists. */
export class UserSession {
  static peers = new Set<UserSession>();
  static runs = new Map<string, { agent: TravelAgent; abort: AbortController }>();
  static writes = new Map<string, Promise<unknown>>();
  /** One ChatGPT sign-in at a time per server: the OAuth callback port is shared. */
  static codexLoginOwner: UserSession | null = null;
  private codexLogin: AbortController | null = null;
  private codexLoginState: CodexLoginState = { id: '', status: 'idle', active: false, url: '', error: '', connectionId: '', connections: [] };
  readonly receiver: RpcAbleReceiver;
  readonly client: any;
  private closed = false;
  constructor(socket: WebSocket, readonly travel: TravelService, private media?: MediaStore, private places: PlaceGeocoder = placeGeocoder, readonly providers?: TravelProviderStorage, private devIntercom?: DevIntercomConfig) {
    this.receiver = new RpcAbleReceiver({ target: this, role: 'user', permissions });
    this.client = new RpcAbleSender({ target: {}, transport: 'websocket', connection: { send: (frame: string) => { if (socket.readyState === socket.OPEN) socket.send(frame); } }, channel: RPC_CHANNEL });
    UserSession.peers.add(this);
  }
  receive(envelope: RpcEnvelope) { return dispatch({ targetSender: this.client, targetReceiver: this }, envelope, { role: 'user' }); }
  destroy() { if (this.closed) return; this.closed = true; UserSession.peers.delete(this); if (!UserSession.peers.size) for (const run of UserSession.runs.values()) { run.abort.abort(); void run.agent.abort(); } destroy(this.client); }
  private changed(result: any) { if (typeof result?.revision === 'number') for (const peer of UserSession.peers) if (!peer.closed) peer.client.travelUpdated({ revision: result.revision }); return result; }
  pings() { return { ok: true, time: new Date().toISOString() }; }
  listTrips() { return this.travel.listTrips(); }
  getTripTree(input: any) { return this.travel.getTripTree(input); }
  getNodeDetail(input: any) { return this.travel.getNodeDetail(input); }
  async createNode(input: any) { const result: any = await this.travel.createNode(input), node = result?.node; if (node && node.type !== 'trip' && (!node.description || !node.notes || node.lat === null || node.lng === null)) void this.completeQuietly(node.id); return this.changed(result); }
  /** A new place is filled in the background: the pin, its description and its photo arrive without blocking the form. */
  private async completeQuietly(nodeId: string) {
    try { const result = await this.locator().complete(nodeId); if (result.located || result.described || result.image) this.changed({ revision: this.travel.store.snapshot().revision }); }
    catch { /* a source being unavailable must never fail the user's edit */ }
  }
  async updateNode(input: any) { return this.changed(await this.travel.updateNode(input)); }
  async moveNode(input: any) { return this.changed(await this.travel.moveNode(input)); }
  async deleteNode(input: any) { const root = this.travel.getNodeDetail({ id: input?.id }).node; if (root.type === 'trip' && UserSession.runs.has(root.id)) throw new Error('Cannot delete a trip while an agent operation is running.'); const before = this.travel.store.snapshot(), result = await this.travel.deleteNode(input); const deleted = new Set(result.deleted), afterUrls = new Set(this.travel.store.snapshot().images.map(image => image.url)); const ids = new Set(before.images.filter(image => deleted.has(image.nodeId)).map(image => image.url.match(/^\/media\/([a-f0-9-]{36})$/i)?.[1]).filter((id): id is string => !!id)); await Promise.all([...ids].filter(id => !afterUrls.has(`/media/${id}`)).map(id => this.media?.remove(id))); if (root.type === 'trip') await deleteScopeProvider(this.storage(), root.id).catch(() => {}); return this.changed(result); }
  async saveTodo(input: any) { return this.changed(await this.travel.saveTodo(input)); }
  async deleteTodo(input: any) { return this.changed(await this.travel.deleteTodo(input)); }
  async saveImage(input: any) { return this.changed(await this.travel.saveImage(input)); }
  async deleteImage(input: any) { const image = this.travel.store.snapshot().images.find(item => item.id === input?.id), result = await this.travel.deleteImage(input); const mediaId = image?.url.match(/^\/media\/([a-f0-9-]{36})$/i)?.[1]; if (mediaId && !this.travel.store.snapshot().images.some(item => item.url === `/media/${mediaId}`)) await this.media?.remove(mediaId); return this.changed(result); }
  async searchFlights(input: any) { return this.changed(await this.travel.searchFlights(input)); }
  listFlightSearches(input: any) { return this.travel.listFlightSearches(input); }
  async saveFlightCandidate(input: any) { return this.changed(await this.travel.saveFlightCandidate(input)); }
  async deleteFlightCandidate(input: any) { return this.changed(await this.travel.deleteFlightCandidate(input)); }
  getModelCatalog() { return getModelCatalog(); }
  async refreshModelCatalog() { return refreshModelCatalog(this.storage()); }
  getOpenAICodexLogin() { return structuredClone(this.codexLoginState); }
  cancelOpenAICodexLogin() { this.codexLogin?.abort(); }
  /** Start a job, not a request held open until the browser finishes signing in. */
  connectOpenAICodex(input: any): CodexLoginState {
    const state: CodexLoginState = { id: randomUUID(), status: 'preparing', active: true, url: '', error: '', connectionId: '', connections: [] };
    if (this.closed || UserSession.codexLoginOwner || UserSession.runs.size) return { ...state, status: 'error', active: false, error: 'Wait for the current sign-in or running agent to finish.' };
    if (typeof input?.name !== 'string' || !input.name.trim() || input.name.length > 200) return { ...state, status: 'error', active: false, error: 'Enter a connection name of at most 200 characters.' };
    this.codexLoginState = state;
    const controller = new AbortController();
    this.codexLogin = controller;
    UserSession.codexLoginOwner = this;
    // The job publishes public state only; OAuth responses and tokens never leave the server.
    void this.runOpenAICodexLogin(state, controller, input.name).catch(() => {});
    return this.getOpenAICodexLogin();
  }
  private publishCodexLogin(state: CodexLoginState) { if (this.closed) return; for (const peer of UserSession.peers) if (!peer.closed) peer.client.providerLoginEvent({ provider: OPENAI_CODEX_PROVIDER, state: structuredClone(state) }); }
  private async runOpenAICodexLogin(state: CodexLoginState, controller: AbortController, name: string) {
    let connectionId = '', storage: TravelProviderStorage | undefined;
    const prepareDeadline = setTimeout(() => controller.abort(new Error('Preparing the sign-in link timed out. Try again.')), 10_000);
    const loginDeadline = setTimeout(() => controller.abort(new Error('ChatGPT sign-in expired. Prepare a new link.')), 5 * 60 * 1000);
    try {
      // Pi otherwise silently falls back to manual code entry when the shared callback port is taken.
      await new Promise<void>((resolve, reject) => {
        const probe = createPortProbe();
        probe.once('error', () => reject(new Error('Port 1455 is in use. Cancel the other ChatGPT sign-in, then retry.')));
        probe.listen(1455, '127.0.0.1', () => probe.close(error => error ? reject(error) : resolve()));
      });
      controller.signal.throwIfAborted();
      storage = this.storage();
      connectionId = await createOpenAICodexConnection(storage, name);
      controller.signal.throwIfAborted();
      const deviceId = await openAIDeviceId(this.travel.store.root);
      const runtime = await openAICodexRuntime(storage, connectionId);
      await runtime.login(OPENAI_CODEX_PROVIDER, 'oauth', {
        signal: controller.signal,
        prompt: async (prompt: any) => {
          if (prompt.type === 'select') return 'browser';
          if (prompt.type !== 'manual_code') throw new Error('Unexpected ChatGPT sign-in prompt.');
          const signal = AbortSignal.any([controller.signal, ...(prompt.signal ? [prompt.signal] : [])]);
          return new Promise<string>((_resolve, reject) => {
            const cancel = () => reject(new Error('Sign-in cancelled'));
            if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
          });
        },
        notify: (event: any) => {
          if (event.type === 'auth_url' && !controller.signal.aborted) {
            clearTimeout(prepareDeadline);
            state.status = 'ready'; state.url = event.url;
            this.publishCodexLogin(state);
          }
        },
      }, { getDeviceId: () => deviceId, agentName: 'TravelMore' });
      state.connections = (await listProviderConnections(storage)).map(connection => ({ ...connection }));
      state.connectionId = connectionId;
      state.status = 'connected';
    } catch (error: any) {
      // A half-created connection must not linger with an unreachable endpoint.
      if (connectionId && storage) await deleteProviderConnection(storage, connectionId).catch(() => {});
      const reason = controller.signal.reason;
      state.status = controller.signal.aborted && reason?.name === 'AbortError' ? 'cancelled' : 'error';
      state.error = state.status === 'cancelled' ? '' : controller.signal.aborted && reason instanceof Error ? reason.message
        : String(error?.message).startsWith('Port 1455 is in use.') ? error.message : 'Could not complete ChatGPT sign-in. Retry or check the server storage.';
    } finally {
      clearTimeout(prepareDeadline); clearTimeout(loginDeadline);
      state.active = false; state.url = '';
      if (this.codexLogin === controller) this.codexLogin = null;
      if (UserSession.codexLoginOwner === this) UserSession.codexLoginOwner = null;
      this.publishCodexLogin(state);
    }
  }
  private storage() { if (!this.providers) throw new Error('Provider storage is not configured.'); return this.providers; }
  private locator() { return new PlaceLocator(this.travel, this.places); }
  /** Complete every place of a trip that is still missing a pin, a description or a picture. */
  async completePlaces(input: any) { return this.changed(await this.locator().completeTrip(input?.tripId, 25)); }
  placeInfo(input: any) { return placeInfoService.lookup(input); }
  searchAirports(input: any) { return { suggestions: searchAirports(input?.query, input?.limit) }; }
  resetFlightData(input: any) { return this.flights().reset(input?.tripId, input?.forgetWatch === true); }
  private flights() { return flightMonitor(this.travel.store); }
  async saveFlightWatch(input: any) { const watch = await this.flights().saveWatch(input?.tripId, input); return { ...watch, preview: this.flights().preview(input.tripId, watch.watch.direction) }; }
  listFlightWatches(input: any) { return this.flights().listWatches(input?.tripId); }
  previewFlightWatch(input: any) { return this.flights().preview(input?.tripId, input?.direction === 'return' ? 'return' : 'outbound'); }
  deleteFlightWatch(input: any) { return this.flights().deleteWatch(input?.tripId, input?.direction === 'return' ? 'return' : 'outbound'); }
  startFlightScan(input: any) { const run = this.flights().start(input?.tripId, input?.direction === 'return' ? 'return' : 'outbound'); for (const peer of UserSession.peers) if (!peer.closed) peer.client.travelUpdated({ revision: this.travel.store.snapshot().revision }); return run; }
  getFlightScan(input: any) { return this.flights().getRun(input?.runId); }
  cancelFlightScan(input: any) { return this.flights().cancel(input?.tripId); }
  rescanFlightCell(input: any) { const run = this.flights().rescanCell(input?.tripId, input?.cellKey); for (const peer of UserSession.peers) if (!peer.closed) peer.client.travelUpdated({ revision: this.travel.store.snapshot().revision }); return run; }
  flightOverview(input: any) { return this.flights().overview(input?.tripId); }
  flightHistory(input: any) { return this.flights().history(input?.tripId, input?.cellKey); }
  listProviderConnections() { return listProviderConnections(this.storage()).then(connections => ({ connections })); }
  async saveProviderConnection(input: any) { return saveProviderConnection(this.storage(), input); }
  async deleteProviderConnection(input: any) { return deleteProviderConnection(this.storage(), input?.id); }
  async getProvider(input: any) { return providerInfo(this.storage(), this.scopeOf(input)); }
  async configureProvider(input: any) {
    const scope = this.scopeOf(input)
    // `providerId: null` drops a trip override so it inherits the shared workspace selection again.
    if (input?.providerId === null) { if (scope === 'workspace') throw new Error('The workspace needs a provider.'); await deleteScopeProvider(this.storage(), scope); return providerInfo(this.storage(), scope) }
    return configureProvider(this.storage(), scope, input)
  }
  private scopeOf(input: any) { const scope = input?.scope ?? input?.tripId; if (scope !== 'workspace') this.travel.getTripTree({ tripId: scope }); return scope as string; }
  private chatScope(input: any) { return this.scopeOf(input) }
  async statusFor(scope: string) { const configured = await providerConfigured(this.storage(), scope), run = UserSession.runs.get(scope); return { state: !configured ? 'unconfigured' : run ? 'running' : 'idle', tools: ['trip_tree', 'node_detail', 'trip_crud', 'todo_crud', 'image_attach', 'place_search', 'flight_search', 'web_search', 'web_read', 'execute_js', ...(this.devIntercom ? ['dev_intercom'] : [])], running: !!run }; }
  getAgentStatus(input: any) { return this.statusFor(this.scopeOf(input)); }
  async getChat(input: any) { const scope = this.chatScope(input), data = this.travel.store.snapshot(); return { entries: data.chats.filter(entry => (entry.scope || entry.tripId) === scope), state: await this.statusFor(scope) }; }
  private static publishChat(payload: any) { for (const peer of UserSession.peers) if (!peer.closed) peer.client.chatUpdated(payload); }
  private static publishEvent(payload: any) { for (const peer of UserSession.peers) if (!peer.closed) peer.client.agentEvent(payload); }
  private static projectAgentEvent(scope: string, event: any) { const text = Array.isArray(event.message?.content) ? event.message.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('') : ''; return { version: 2, scope, ...(scope === 'workspace' ? {} : { tripId: scope }), state: { busy: true, streaming: event.type === 'message_update' ? text : '', activity: event.type === 'tool_execution_start' ? `Using ${String(event.toolName || 'tool').replaceAll('_', ' ')}…` : event.type === 'tool_execution_end' ? '' : '', error: event.type === 'message_end' && event.message?.errorMessage ? String(event.message.errorMessage) : '' } }; }
  async startChat(input: any) {
    const scope = this.chatScope(input), text = input?.text, scopeFields = scope === 'workspace' ? { scope } : { scope, tripId: scope };
    if (typeof text !== 'string' || !text.trim() || text.length > 50_000) throw new Error('Enter a chat message of at most 50000 characters.');
    if (UserSession.runs.has(scope)) throw new Error(scope === 'workspace' ? 'An agent operation is already running across your trips.' : 'An agent operation is already running for this trip.');
    const connection = await agentSettings(this.storage(), scope);
    const historyLines = this.travel.store.snapshot().chats.filter(entry => (entry.scope || entry.tripId) === scope).slice(-24).map(entry => `${entry.role}: ${entry.text}`); let prior = '', truncated = false; for (const line of historyLines.reverse()) { if (prior.length + line.length + 1 > 40_000) { truncated = true; break; } prior = prior ? `${line}\n${prior}` : line; } if (truncated) prior = `[Earlier history omitted for context budget]\n${prior}`;
    const user = { id: randomUUID(), ...scopeFields, role: 'user' as const, text: text.trim(), createdAt: new Date().toISOString() }; await this.travel.store.transaction(data => { data.chats.push(user); return null; });
    const runningState = await this.statusFor(scope);
    const controller = new AbortController(), agent = new TravelAgent(this.travel, scope, event => { UserSession.publishEvent(UserSession.projectAgentEvent(scope, event)); if (event.type === 'message_end' && event.message?.role === 'assistant') { const content = Array.isArray(event.message.content) ? event.message.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('') : ''; // A failed model call carries no content: surface the reason instead of staying silent.
        const failure = content ? '' : event.message.stopReason === 'error' ? String(event.message.errorMessage || 'The model call failed.') : ''; const text = content || failure; if (text) { const write = this.travel.store.transaction(data => { const entry = { id: randomUUID(), ...scopeFields, role: 'assistant' as const, text, createdAt: new Date().toISOString(), ...(failure ? { meta: { state: 'error' } } : {}) }; data.chats.push(entry); UserSession.publishChat({ version: 1, ...scopeFields, entries: [entry], state: runningState }); return null; }); UserSession.writes.set(scope, write); void write.finally(() => { if (UserSession.writes.get(scope) === write) UserSession.writes.delete(scope); }); } } }, revision => { for (const peer of UserSession.peers) if (!peer.closed) peer.client.travelUpdated({ revision }); }, this.devIntercom); UserSession.runs.set(scope, { agent, abort: controller });
    UserSession.publishChat({ version: 1, ...scopeFields, entries: [user], state: await this.statusFor(scope) });
    void (async () => { try { await agent.open(connection, this.storage()); if (!controller.signal.aborted) await agent.prompt(prior ? `Conversation so far:\n${prior}\n\nNew user request:\n${user.text}` : user.text); } catch (error: any) { const entry = { id: randomUUID(), ...scopeFields, role: 'assistant' as const, text: `Agent failed: ${error.message}`, createdAt: new Date().toISOString(), meta: { state: 'error' } }; await this.travel.store.transaction(data => { data.chats.push(entry); return null; }); UserSession.publishChat({ version: 1, ...scopeFields, entries: [entry], state: { state: 'error', running: false } }); } finally { await agent.abort().catch(() => {}); await UserSession.writes.get(scope)?.catch(() => {}); agent.dispose(); UserSession.runs.delete(scope); UserSession.publishChat({ version: 1, ...scopeFields, entries: [], state: await this.statusFor(scope) }); } })();
    return { version: 1, ...scopeFields, entries: [user], state: await this.statusFor(scope) };
  }
  async compactChat(input: any) { const scope = this.chatScope(input), run = UserSession.runs.get(scope); if (!run) throw new Error('No active agent session to compact.'); await run.agent.compact(); return { state: 'running' }; }
  async cancelChat(input: any) { const scope = this.chatScope(input), run = UserSession.runs.get(scope); if (run) { run.abort.abort(); await run.agent.abort(); } return { state: run ? 'cancelling' : 'idle' }; }
  searchWeb(input: any) { return searchWeb(input); }
  searchPlaces(input: any) { return this.places.search(input); }
  reversePlace(input: any) { return this.places.reverse(input); }
  readWeb(input: any) { return readWeb(input); }
  executeJs(input: any) { return executeJs(input); }
}
