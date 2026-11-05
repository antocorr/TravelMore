import { RpcAble, destroy } from 'rpcable'
import { Signal, globals } from 'tinybubble'

export const RPC_CHANNEL = '-userSession'
export const clientSession = {}
export let userSession
let standalone

export function createRpcClient({ rpcUrl, status = Signal('offline'), clientSession: handlers = {} }) {
    const url = new URL(rpcUrl)
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password) throw new Error('rpcUrl must be an explicit WS(S) URL without credentials.')
    let socket, rpc, retry, closed = false
    const proxy = new Proxy({}, { get(_target, property) {
        if (property === 'then') return undefined
        if (!rpc) throw new Error('TravelMore RPC is not connected.')
        return rpc[property]
    } })
    const connect = () => {
        if (closed || socket && socket.readyState < WebSocket.CLOSING) return
        status.value = 'connecting'
        const current = new WebSocket(url.href)
        socket = current
        const remote = new RpcAble({ targetReceiver: handlers, transport: 'websocket', channel: RPC_CHANNEL, connection: current, role: 'user' })
        rpc = remote
        current.addEventListener('open', () => { if (!closed && socket === current) status.value = 'online' })
        current.addEventListener('close', () => {
            destroy(remote)
            if (socket !== current || closed) return
            status.value = 'offline'
            retry = setTimeout(connect, 1500)
        })
        current.addEventListener('error', () => { if (!closed && socket === current) status.value = 'offline' })
    }
    return { userSession: proxy, status, start: connect, close() {
        if (closed) return
        closed = true
        clearTimeout(retry)
        if (rpc) destroy(rpc)
        if (socket) socket.close()
        status.value = 'offline'
    } }
}

export function startSession() {
    if (standalone) return standalone
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    standalone = createRpcClient({ rpcUrl: `${protocol}//${location.host}/rpc`, clientSession })
    userSession = standalone.userSession
    globals.$rpcStatus = standalone.status
    standalone.start()
    window.addEventListener('pagehide', () => standalone.close(), { once: true })
    return standalone
}
