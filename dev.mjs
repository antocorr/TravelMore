import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { createServer as createPortProbe } from 'node:net'
import { fileURLToPath } from 'node:url'

const MIN_NODE = '22.19.0'
const root = fileURLToPath(new URL('.', import.meta.url))

/** Explain a missing prerequisite instead of throwing a bare ESM resolution stack. */
function preflight() {
    const [major, minor] = process.versions.node.split('.').map(Number)
    const [needMajor, needMinor] = MIN_NODE.split('.').map(Number)
    if (major < needMajor || (major === needMajor && minor < needMinor)) {
        console.error(`[dev] Node.js ${process.versions.node} is too old. TravelMore needs ${MIN_NODE} or newer (the Pi runtime requirement).`)
        console.error('[dev] Install a newer Node.js from https://nodejs.org/ and run this command again.')
        process.exit(1)
    }
    const require = createRequire(import.meta.url)
    let vite = false
    try { require.resolve('vite'); vite = true } catch { /* reported below */ }
    if (!vite) {
        console.error('[dev] Dependencies are not installed, so Vite cannot be loaded.')
        console.error('[dev] Run `npm install` in this directory first, then `npm run dev` again.')
        console.error('[dev] Use a normal install: `npm ci --omit=dev` and `npm install --production` skip Vite, tsx and the other development tools.')
        if (!existsSync(`${root}node_modules`)) console.error(`[dev] ${root}node_modules does not exist yet.`)
        process.exit(1)
    }
    try { require.resolve('tsx/cli') } catch {
        console.error('[dev] The `tsx` runner is missing. Run `npm install` (without `--omit=dev`) in this directory.')
        process.exit(1)
    }
}
preflight()
const { createServer } = await import('vite')
const clientRoot = fileURLToPath(new URL('./client/', import.meta.url))
const serverRoot = fileURLToPath(new URL('./server/', import.meta.url))
// Only this process can attest that a proxied request originated on this computer.
const devLocalToken = randomBytes(32).toString('hex')
const intercomTarget = process.env.TRAVELMORE_INTERCOM_TARGET || process.env.PI_INTERCOM_SESSION_ID || ''
const server = spawn(process.execPath, [fileURLToPath(import.meta.resolve('tsx/cli')), 'watch', '--clear-screen=false', 'src/index.ts'], {
    cwd: serverRoot,
    env: { ...process.env, NODE_ENV: 'development', TRAVELMORE_DEV_LOCAL_TOKEN: devLocalToken, TRAVELMORE_INTERCOM_TARGET: intercomTarget },
    stdio: ['ignore', 'pipe', 'inherit'],
})
let client
let stopping = false
const proxies = []
const closed = new Promise(resolve => server.once('close', resolve))

function availablePort() {
    return new Promise((resolve, reject) => {
        const probe = createPortProbe()
        probe.once('error', reject)
        probe.listen(0, '127.0.0.1', () => {
            const port = probe.address().port
            probe.close(error => error ? reject(error) : resolve(port))
        })
    })
}

async function stop() {
    if (stopping) return
    stopping = true
    server.kill('SIGTERM')
    if (client) await client.close()
}
process.once('SIGINT', () => { void stop() })
process.once('SIGTERM', () => { void stop() })
server.once('error', error => { console.error('[dev] Server launch failed:', error); process.exitCode = 1 })
server.once('exit', code => {
    if (!stopping) {
        console.error(`[dev] Server exited (${code}); stopping client.`)
        process.exitCode = code || 1
        void stop()
    }
})

try {
    for await (const line of createInterface({ input: server.stdout })) {
        console.log(line)
        const match = line.match(/^\[travelmore-server\] ready on (http:\/\/\S+)$/)
        if (!match || stopping) continue
        const backend = match[1]
        if (client) {
            for (const proxy of proxies) proxy.options.target = proxy.options.ws ? backend.replace(/^http/, 'ws') : backend
            console.log(`[dev] Reconnected backend at ${backend}`)
            continue
        }
        // Load only after the backend is listening. Vite and the API are both assigned free ports.
        const { default: config } = await import('./client/vite.config.js')
        for (const options of Object.values(config.server.proxy)) {
            options.target = options.ws ? backend.replace(/^http/, 'ws') : backend
            options.configure = proxy => {
                proxies.push(proxy)
                proxy.on('proxyReqWs', (proxyReq, req) => {
                    // Never trust an incoming capability or forwarding header, including on LAN/Tailscale.
                    proxyReq.removeHeader('x-travelmore-dev-local')
                    const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
                    let localOrigin = false
                    try {
                        const origin = new URL(req.headers.origin)
                        const host = new URL(`http://${req.headers.host}`)
                        const local = hostname => ['localhost', '127.0.0.1', '[::1]'].includes(hostname)
                        localOrigin = ['http:', 'https:'].includes(origin.protocol) && local(origin.hostname) && local(host.hostname)
                    } catch { /* missing or malformed origin/host is not a dev capability */ }
                    if (loopback && localOrigin) proxyReq.setHeader('x-travelmore-dev-local', devLocalToken)
                })
            }
        }
        process.chdir(clientRoot)
        // Bind every interface: the app is meant to be opened from a phone on the same network too.
        client = await createServer({ ...config, configFile: false, root: clientRoot, server: { ...config.server, host: true, port: await availablePort(), strictPort: false } })
        await client.listen()
        client.printUrls()
        console.log(`[dev] client ready on ${client.resolvedUrls.local[0]}`)
        // Vite lists every interface: the LAN address and, when Tailscale is up, the tailnet one.
        for (const url of client.resolvedUrls.network || []) {
            const tailnet = /^http:\/\/100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(url)
            console.log(`[dev] on your ${tailnet ? 'tailnet' : 'network'}: ${url}`)
        }
    }
} catch (error) {
    console.error('[dev] Launch failed:', error)
    process.exitCode = 1
} finally {
    await stop()
    await closed
    process.chdir(root)
}
