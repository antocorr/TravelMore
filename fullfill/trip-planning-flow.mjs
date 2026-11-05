import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { RpcAble, destroy } from 'rpcable'

const root = fileURLToPath(new URL('../', import.meta.url))
const dataDir = await mkdtemp(join(tmpdir(), 'travelmore-fullfill-'))
const server = spawn(process.execPath, [fileURLToPath(import.meta.resolve('tsx/cli')), 'src/index.ts'], {
    cwd: join(root, 'server'),
    env: { ...process.env, TRAVELMORE_DATA_DIR: dataDir, TRAVELMORE_GEOCODER_URL: 'off', TRAVELMORE_SEARCH_PROVIDER: 'off', PORT: '0', HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
let socket
let mockCalls = 0
const mock = createServer((req, res) => { let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => { mockCalls++; const parentId = body.match(/[a-f0-9-]{36}/i)?.[0] || ''; const workspaceScope = body.includes('Scope: the whole travel library'); res.writeHead(200, { 'content-type': 'text/event-stream' }); const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`); if (workspaceScope) { emit({ role: 'assistant', content: 'Workspace ready.' }); emit({}, 'stop'); } else if (mockCalls === 1) { emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_create', type: 'function', function: { name: 'create_node', arguments: JSON.stringify({ parentId, type: 'stop', title: 'WS agent stop' }) } }] }); emit({}, 'tool_calls'); } else { emit({ role: 'assistant', content: 'Created WS agent stop.' }); emit({}, 'stop'); } res.end('data: [DONE]\n\n'); }); })
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve))
const mockPort = mock.address().port
const agentEvents = []
const chatUpdates = []
const travelUpdates = []
let rpc
const abort = new AbortController()
const timeout = setTimeout(() => abort.abort(new Error('Server readiness timed out.')), 20_000)
async function ready() {
    return new Promise((resolve, reject) => {
        const fail = error => reject(new Error(`Server failed: ${error.message}\n${output}`))
        const onData = chunk => {
            output += chunk.toString()
            const url = output.match(/\[travelmore-server\] ready on (http:\/\/\S+)/)?.[1]
            if (url) resolve(url)
        }
        server.stdout.on('data', onData)
        server.stderr.on('data', onData)
        server.once('error', fail)
        server.once('exit', code => fail(new Error(`exited ${code}`)))
        abort.signal.addEventListener('abort', () => fail(abort.signal.reason), { once: true })
    })
}
try {
    const url = await ready()
    socket = new WebSocket(url.replace(/^http/, 'ws') + '/rpc')
    await once(socket, 'open')
    rpc = new RpcAble({ transport: 'websocket', connection: socket, channel: '-userSession', role: 'user', targetReceiver: { agentEvent(payload) { agentEvents.push(payload) }, chatUpdated(payload) { chatUpdates.push(payload) }, travelUpdated(payload) { travelUpdates.push(payload) } } })
    assert.equal((await rpc.pings()).ok, true)

    const trip = (await rpc.createNode({ parentId: null, title: 'Cina', type: 'trip' })).node
    assert.match(trip.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, 'Each trip gets a UUID')
    assert.equal(trip.lat, null, 'A thematic trip has no geographic pin')
    await assert.rejects(rpc.createNode({ parentId: null, title: 'Natale alle Hawaii', type: 'trip', lat: 39, lng: -77 }), 'A thematic trip cannot acquire a pin from its title')
    await assert.rejects(rpc.updateNode({ id: trip.id, patch: { lat: 39, lng: -77 } }))
    assert.equal((await rpc.listTrips()).trips.length, 1, 'Rejected geocoded trip was not created')
    assert.equal((await rpc.getNodeDetail({ id: trip.id })).node.lat, null, 'Rejected location did not mutate the trip')
    const catalog = await rpc.getModelCatalog()
    assert.ok(['loading', 'fresh', 'stale', 'unavailable'].includes(catalog.status), 'The models.dev catalogue must always report a status')
    assert.ok(Array.isArray(catalog.groups) && typeof catalog.omitted === 'number', 'The catalogue projects into provider groups')
    assert.ok(catalog.groups.some(group => group.id === 'openai-codex' && group.auth === 'oauth'), 'ChatGPT models ship with the installed Pi provider, not models.dev')
    const idle = await rpc.getOpenAICodexLogin()
    assert.equal(typeof idle.active, 'boolean'); assert.equal(typeof idle.url, 'string')
    const rejected = await rpc.connectOpenAICodex({ name: ' ' })
    assert.equal(rejected.status, 'error', 'A blank connection name never starts a sign-in job')
    assert.equal(rejected.active, false)
    assert.equal((await rpc.listProviderConnections()).connections.length, 0, 'A rejected sign-in leaves no connection behind')
    await assert.rejects(rpc.saveProviderConnection({ name: 'Fake ChatGPT', api: 'openai-codex-responses', auth: 'oauth', baseUrl: 'https://chatgpt.com/backend-api' }), 'OAuth cannot be asserted from the browser')
    const saved = await rpc.saveProviderConnection({ name: 'Mock', api: 'openai-completions', auth: 'apiKey', apiKey: 'test', baseUrl: `http://127.0.0.1:${mockPort}/v1` })
    const providerId = saved.connectionId
    assert.equal(saved.connections.length, 1)
    assert.equal(saved.connections[0].hasKey, true, 'Connections never expose the key, only its presence')
    assert.equal(saved.connections[0].apiKey, undefined, 'The credential must not cross the RPC boundary')
    const selection = { model: 'mock-model', api: 'openai-completions', contextWindow: 32768, maxTokens: 4096, reasoning: false, vision: false, thinking: 'off' }
    const configured = await rpc.configureProvider({ scope: trip.id, providerId, ...selection })
    assert.equal(configured.configured, true)
    assert.equal(configured.model, 'mock-model')
    assert.equal(configured.inherited, false)
    await assert.rejects(rpc.configureProvider({ scope: trip.id, providerId, ...selection, maxTokens: 999999 }), 'Invalid token budgets are rejected')
    const stop = (await rpc.createNode({ parentId: trip.id, title: 'Chengdu', type: 'stop' })).node
    const place = (await rpc.createNode({ parentId: stop.id, title: 'Panda Center', type: 'place', lat: 30.731, lng: 104.146 })).node
    const changed = await rpc.updateNode({ id: place.id, patch: { notes: 'Visit in the morning.' } })
    const todo = (await rpc.saveTodo({ nodeId: place.id, title: 'Book entry', done: false })).todo
    const image = (await rpc.saveImage({ nodeId: place.id, url: 'https://example.org/panda.jpg', caption: 'Panda', sourceUrl: 'https://example.org/source' })).image
    assert.equal(image.isPrimary, true, 'First photo becomes the stop’s primary photo')
    const alternate = (await rpc.saveImage({ nodeId: place.id, url: 'https://example.org/panda-alternate.jpg', caption: 'Alternate' })).image
    assert.equal(alternate.isPrimary, false)
    await rpc.saveImage({ id: alternate.id, nodeId: place.id, isPrimary: true })
    assert.equal((await rpc.getTripTree({ tripId: trip.id })).images.find(item => item.id === alternate.id)?.isPrimary, true, 'Promoted image is visible to map pins')
    assert.equal((await rpc.getNodeDetail({ id: place.id })).assets.find(item => item.id === image.id)?.isPrimary, false, 'Promotion clears the old primary')
    await rpc.deleteImage({ id: alternate.id })
    assert.equal((await rpc.getNodeDetail({ id: place.id })).assets.find(item => item.id === image.id)?.isPrimary, true, 'Deleting primary promotes remaining photo')
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64')
    const denied = await fetch(`${url}/media?nodeId=${place.id}`, { method: 'PUT', headers: { origin: 'https://foreign.example', 'content-type': 'image/png' }, body: png })
    assert.equal(denied.status, 400, 'Foreign origin must not upload private media')
    const uploaded = await fetch(`${url}/media?nodeId=${place.id}`, { method: 'PUT', headers: { origin: url, 'content-type': 'image/png' }, body: png })
    assert.equal(uploaded.status, 201)
    const media = await uploaded.json()
    assert.equal((await fetch(`${url}${media.image.url}`)).status, 200)
    travelUpdates.length = 0
    await rpc.startChat({ tripId: trip.id, text: `Create a stop under trip ${trip.id}.` })
    const agentDeadline = Date.now() + 10_000
    while (Date.now() < agentDeadline && !chatUpdates.some(update => update.entries.some(entry => entry.text === 'Created WS agent stop.'))) await new Promise(resolve => setTimeout(resolve, 50))
    assert.ok(agentEvents.some(event => event.version === 2), 'Expected public agentEvent v2')
    assert.ok(travelUpdates.some(update => typeof update.revision === 'number'), 'Expected live travelUpdated after agent tool mutation')
    assert.ok(chatUpdates.some(update => update.entries.some(entry => entry.text === 'Created WS agent stop.')), `Expected public assistant chatUpdated delta: ${JSON.stringify(chatUpdates)}`)
    assert.ok((await rpc.getTripTree({ tripId: trip.id })).nodes.some(node => node.title === 'WS agent stop'), 'Expected agent tool mutation through public RPC')
    const tree = await rpc.getTripTree({ tripId: trip.id })
    assert.deepEqual(tree.nodes.map(node => node.title).sort(), ['Chengdu', 'Cina', 'Panda Center', 'WS agent stop'].sort())
    assert.equal(tree.nodes.find(node => node.id === place.id).notes, 'Visit in the morning.')
    const listed = (await rpc.listTrips()).trips.find(item => item.id === trip.id)
    assert.ok(listed?.stats, 'listTrips must enrich each trip with stats')
    assert.equal(listed.stats.stops, 2, 'Chengdu and the agent stop are stops')
    assert.equal(listed.stats.places, 1, 'Panda Center is the only place')
    assert.ok(listed.stats.stopNames.includes('Chengdu') && listed.stats.stopNames.includes('Panda Center'), 'Dashboard search needs stop names')
    assert.equal(typeof listed.stats.openTodos, 'number')
    assert.ok(listed.cover === null || typeof listed.cover === 'string')
    assert.equal(listed.nextStop?.title, 'Chengdu', 'The first stop without a start date is still the next stop')
    assert.equal((await rpc.getNodeDetail({ id: place.id })).todos[0].id, todo.id)
    assert.equal((await rpc.getNodeDetail({ id: place.id })).assets.some(asset => asset.id === image.id), true)
    assert.equal((await rpc.getNodeDetail({ id: place.id })).assets.some(asset => asset.id === media.image.id), true)
    const sharedMedia = (await rpc.saveImage({ nodeId: stop.id, url: media.image.url, provenance: 'Shared local upload' })).image
    await rpc.deleteImage({ id: sharedMedia.id })
    assert.equal((await fetch(`${url}${media.image.url}`)).status, 200, 'Shared media must remain while another record refers to it')
    await rpc.deleteImage({ id: media.image.id })
    assert.equal((await fetch(`${url}${media.image.url}`)).status, 404, 'Unreferenced private media must be removed')
    assert.ok(changed.revision >= 4)

    const searched = await rpc.searchFlights({ tripId: trip.id, origins: ['CTA'], destinations: ['SZX', 'CAN'], departure: { from: '2026-12-01', to: '2026-12-05' } })
    assert.equal(searched.search.origins[0], 'CTA')
    assert.equal(searched.search.destinations.length, 2)
    assert.ok(searched.search.sources.every(source => source.status === 'unavailable' || source.status === 'observed'))
    assert.ok(searched.results.every(candidate => candidate.price === null || candidate.provenance && candidate.fetchedAt))
    await assert.rejects(rpc.searchFlights({ origins: ['CTA'], destinations: ['SZX'], departure: { from: '2026-12-01', to: '2026-12-05' } }), 'Flight search must require a trip UUID')
    await assert.rejects(rpc.listFlightSearches({}), 'Flight listing must require a trip UUID')
    const otherTrip = (await rpc.createNode({ parentId: null, title: 'Giappone', type: 'trip' })).node
    assert.equal((await rpc.listFlightSearches({ tripId: otherTrip.id })).searches.length, 0, 'Other trip must not see Cina flight searches')
    assert.equal((await rpc.getChat({ tripId: otherTrip.id })).entries.length, 0, 'Other trip must not see Cina chat')
    const candidate = (await rpc.saveFlightCandidate({ searchId: searched.search.id, origin: 'CTA', destination: 'SZX', provider: 'manual', sourceUrl: 'https://example.org/flight', provenance: 'Saved by traveler from a cited page', selected: true, note: 'Flexible dates' })).candidate
    assert.equal(candidate.selected, true)
    assert.equal(candidate.price, null)
    assert.equal((await rpc.listFlightSearches({ tripId: trip.id })).candidates[0].id, candidate.id)
    await rpc.deleteFlightCandidate({ id: candidate.id })
    assert.equal((await rpc.listFlightSearches({ tripId: trip.id })).candidates.length, 0)
    assert.equal((await rpc.executeJs({ code: 'return input.value * 2', input: { value: 7 } })).result, 14)
    const search = await rpc.searchWeb({ query: 'Chengdu panda center' })
    assert.equal(search.status, 'unavailable', 'This offline fullfill explicitly disables the external search provider')
    const places = await rpc.searchPlaces({ query: 'Chengdu panda base' })
    assert.equal(places.status, 'unavailable', 'The offline fullfill disables the geocoder provider')
    assert.deepEqual(places.results, [])
    assert.equal((await rpc.reversePlace({ lat: 30.66, lng: 104.06 })).status, 'unavailable')
    await assert.rejects(rpc.searchPlaces({ query: 'x' }), 'Place search must require a real query')
    await assert.rejects(rpc.reversePlace({ lat: 120, lng: 0 }), 'Reverse lookup must validate coordinates')
    const pinned = (await rpc.updateNode({ id: place.id, patch: { address: 'Panda Base, Chenghua, Chengdu', lat: 30.731, lng: 104.146 } })).node
    assert.equal(pinned.address, 'Panda Base, Chenghua, Chengdu')
    assert.equal((await rpc.getTripTree({ tripId: trip.id })).nodes.find(node => node.id === place.id).address, 'Panda Base, Chenghua, Chengdu')

    // Workspace scope: one shared assistant and one shared provider for the whole library.
    const workspaceTrip = (await rpc.createNode({ parentId: null, title: 'Portogallo', type: 'trip' })).node
    assert.equal((await rpc.listTrips()).trips.find(item => item.id === workspaceTrip.id).stats.stops, 0, 'An empty trip reports zero stops')
    await rpc.configureProvider({ scope: 'workspace', providerId, ...selection, model: 'shared-model' })
    const inheritedProvider = await rpc.getProvider({ scope: workspaceTrip.id })
    assert.equal(inheritedProvider.providerId, providerId, 'A trip without its own provider inherits the workspace one')
    assert.equal(inheritedProvider.inherited, true)
    assert.equal(inheritedProvider.model, 'shared-model')
    await rpc.configureProvider({ scope: workspaceTrip.id, providerId, ...selection, model: 'trip-model' })
    assert.equal((await rpc.getProvider({ scope: workspaceTrip.id })).inherited, false, 'A trip override is not inherited')
    assert.equal((await rpc.getProvider({ scope: workspaceTrip.id })).model, 'trip-model')
    await rpc.configureProvider({ scope: workspaceTrip.id, providerId: null })
    assert.equal((await rpc.getProvider({ scope: workspaceTrip.id })).inherited, true, 'Clearing the override falls back to the workspace provider')
    await assert.rejects(rpc.configureProvider({ scope: 'workspace', providerId: null }), 'The workspace itself always needs a provider')
    await assert.rejects(rpc.getProvider({ scope: '00000000-0000-4000-8000-000000000000' }), 'Unknown scopes are rejected')
    assert.deepEqual((await rpc.getChat({ scope: 'workspace' })).entries, [], 'The workspace chat starts empty')
    await rpc.startChat({ scope: 'workspace', text: 'Start a new trip to Portugal.' })
    const workspaceDeadline = Date.now() + 10_000
    while (Date.now() < workspaceDeadline && !chatUpdates.some(update => update.scope === 'workspace' && update.entries.some(entry => entry.text === 'Workspace ready.'))) await new Promise(resolve => setTimeout(resolve, 50))
    assert.ok(chatUpdates.some(update => update.scope === 'workspace' && update.entries.some(entry => entry.text === 'Workspace ready.')), `Expected a workspace chatUpdated delta: ${JSON.stringify(chatUpdates.filter(update => update.scope === 'workspace'))}`)
    assert.ok(agentEvents.some(event => event.scope === 'workspace'), 'Workspace agent events carry their scope')
    const workspaceChat = await rpc.getChat({ scope: 'workspace' })
    assert.equal(workspaceChat.entries.length, 2, 'The workspace chat stores the question and the answer')
    assert.ok(workspaceChat.entries.every(entry => entry.scope === 'workspace'))
    assert.equal(workspaceChat.state.state, 'idle')
    assert.ok((await rpc.getChat({ scope: trip.id })).entries.every(entry => entry.scope === trip.id), 'The trip chat stays separate from the workspace chat')
    // Deleting a trip also drops its provider override, so nothing points at a dead scope.
    const doomed = (await rpc.createNode({ parentId: null, title: 'Da cancellare', type: 'trip' })).node
    await rpc.configureProvider({ scope: doomed.id, providerId, ...selection, model: 'doomed-model' })
    await rpc.deleteNode({ id: doomed.id })
    await assert.rejects(rpc.getProvider({ scope: doomed.id }), 'A deleted trip scope disappears with the trip')
    await rpc.getProvider({ scope: 'workspace' })
    assert.equal((await rpc.deleteProviderConnection({ id: providerId })).connections.length, 0)
    assert.equal((await rpc.getProvider({ scope: trip.id })).configured, false, 'Deleting the connection clears every selection')
    await rpc.getModelCatalog()
    console.log(JSON.stringify({ result: 'PASS', trip: trip.id, stop: stop.id, place: place.id, todo: todo.id, uploadedMedia: media.id, flightSearch: searched.search.id, jsResult: 14, note: 'Live fares unavailable; no price invented.' }))
} finally {
    clearTimeout(timeout)
    if (rpc) destroy(rpc)
    if (socket) socket.close()
    server.kill('SIGTERM')
    await Promise.race([once(server, 'exit'), new Promise(resolve => setTimeout(resolve, 2_000))])
    if (server.exitCode === null) server.kill('SIGKILL')
    await new Promise(resolve => mock.close(resolve))
    await rm(dataDir, { recursive: true, force: true })
}
