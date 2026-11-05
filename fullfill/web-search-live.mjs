import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { RpcAble, destroy } from 'rpcable'

const root = fileURLToPath(new URL('../', import.meta.url))
const dataDir = await mkdtemp(join(tmpdir(), 'travelmore-search-'))
const server = spawn(process.execPath, [fileURLToPath(import.meta.resolve('tsx/cli')), 'src/index.ts'], {
  cwd: join(root, 'server'),
  env: { ...process.env, TRAVELMORE_DATA_DIR: dataDir, TRAVELMORE_GEOCODER_URL: 'off', TRAVELMORE_SEARCH_URL: '', TRAVELMORE_SEARCH_PROVIDER: '', PORT: '0', HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let socket, rpc, output = ''
try {
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server readiness timed out: ${output}`)), 20_000)
    const onData = chunk => {
      output += chunk.toString()
      const found = output.match(/\[travelmore-server\] ready on (http:\/\/\S+)/)?.[1]
      if (found) { clearTimeout(timer); resolve(found) }
    }
    server.stdout.on('data', onData)
    server.stderr.on('data', onData)
    server.once('error', reject)
    server.once('exit', code => reject(new Error(`Server exited ${code}: ${output}`)))
  })
  socket = new WebSocket(url.replace(/^http/, 'ws') + '/rpc')
  await once(socket, 'open')
  rpc = new RpcAble({ transport: 'websocket', connection: socket, channel: '-userSession', role: 'user', targetReceiver: {} })
  const search = await rpc.searchWeb({ query: 'Fujian Tulou folk village UNESCO', limit: 3 })
  assert.equal(search.status, 'observed', `Expected live search, got ${JSON.stringify(search)}`)
  assert.equal(search.provider, 'exa')
  assert.ok(search.results.length > 0 && search.results.length <= 3)
  assert.ok(search.results.every(item => item.provider === 'exa' && item.url.startsWith('https://') && item.title && item.fetchedAt))
  console.log(JSON.stringify({ result: 'PASS', provider: search.provider, results: search.results.map(({ title, url }) => ({ title, url })) }))
} finally {
  if (rpc) destroy(rpc)
  if (socket) socket.close()
  server.kill('SIGTERM')
  await Promise.race([once(server, 'exit').catch(() => {}), new Promise(resolve => setTimeout(resolve, 2_000))])
  if (server.exitCode === null) server.kill('SIGKILL')
  await rm(dataDir, { recursive: true, force: true })
}
