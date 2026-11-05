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
const dataDir = await mkdtemp(join(tmpdir(), 'travelmore-agent-search-'))
let mockCalls = 0, sawObservedSearch = false
const mock = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => body += chunk)
  req.on('end', () => {
    mockCalls++
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    if (mockCalls === 1) {
      emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_search', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: 'Fujian Tulou folk village UNESCO', limit: 3 }) } }] })
      emit({}, 'tool_calls')
    } else {
      sawObservedSearch = body.includes('whc.unesco.org/en/list/1113/') && body.includes('observed')
      emit({ role: 'assistant', content: 'I found the Fujian Tulou UNESCO listing.' })
      emit({}, 'stop')
    }
    res.end('data: [DONE]\n\n')
  })
})
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve))
const mockPort = mock.address().port
const server = spawn(process.execPath, [fileURLToPath(import.meta.resolve('tsx/cli')), 'src/index.ts'], {
  cwd: join(root, 'server'),
  env: { ...process.env, TRAVELMORE_DATA_DIR: dataDir, TRAVELMORE_GEOCODER_URL: 'off', TRAVELMORE_SEARCH_URL: '', TRAVELMORE_SEARCH_PROVIDER: '', PORT: '0', HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let socket, rpc, output = ''
const chatUpdates = []
try {
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server readiness timed out: ${output}`)), 20_000)
    const onData = chunk => { output += chunk.toString(); const found = output.match(/\[travelmore-server\] ready on (http:\/\/\S+)/)?.[1]; if (found) { clearTimeout(timer); resolve(found) } }
    server.stdout.on('data', onData); server.stderr.on('data', onData)
    server.once('error', reject); server.once('exit', code => reject(new Error(`Server exited ${code}: ${output}`)))
  })
  socket = new WebSocket(url.replace(/^http/, 'ws') + '/rpc')
  await once(socket, 'open')
  rpc = new RpcAble({ transport: 'websocket', connection: socket, channel: '-userSession', role: 'user', targetReceiver: { chatUpdated(payload) { chatUpdates.push(payload) } } })
  const trip = (await rpc.createNode({ parentId: null, title: 'Fujian research', type: 'trip' })).node
  const saved = await rpc.saveProviderConnection({ name: 'Search mock', api: 'openai-completions', auth: 'apiKey', apiKey: 'test', baseUrl: `http://127.0.0.1:${mockPort}/v1` })
  await rpc.configureProvider({ scope: trip.id, providerId: saved.connectionId, model: 'mock-model', api: 'openai-completions', contextWindow: 32768, maxTokens: 4096, reasoning: false, vision: false, thinking: 'off' })
  await rpc.startChat({ tripId: trip.id, text: 'Find the official Fujian Tulou listing and cite it.' })
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && !chatUpdates.some(update => update.entries?.some(entry => entry.text === 'I found the Fujian Tulou UNESCO listing.'))) await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(mockCalls, 2, 'Pi must call the web_search tool and then continue')
  assert.equal(sawObservedSearch, true, 'The model must receive an observed search result with the official URL')
  assert.ok((await rpc.getChat({ tripId: trip.id })).entries.some(entry => entry.text === 'I found the Fujian Tulou UNESCO listing.'))
  console.log(JSON.stringify({ result: 'PASS', scope: trip.id, tool: 'web_search', provider: 'exa', source: 'https://whc.unesco.org/en/list/1113/' }))
} finally {
  if (rpc) destroy(rpc)
  if (socket) socket.close()
  server.kill('SIGTERM')
  await Promise.race([once(server, 'exit').catch(() => {}), new Promise(resolve => setTimeout(resolve, 2_000))])
  if (server.exitCode === null) server.kill('SIGKILL')
  await new Promise(resolve => mock.close(resolve))
  await rm(dataDir, { recursive: true, force: true })
}
