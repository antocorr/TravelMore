import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, networkInterfaces, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { RpcAble, destroy } from 'rpcable';
import { devIntercomConfig } from '../server/src/agent/devIntercom.js';

// Only the model is a fixture: RPC, dev proxy, SDK tool, CLI and intercom broker are real.
const root = fileURLToPath(new URL('../', import.meta.url));
const cli = process.env.TRAVELMORE_INTERCOM_CLI || join(homedir(), '.pi/agent/npm/node_modules/pi-intercom/cli.mjs');
const { IntercomClient } = await import(pathToFileURL(join(dirname(cli), 'broker/client.ts')).href);
const peer = new IntercomClient();
peer.on('error', () => {});
const peerId = randomUUID();
const liveTarget = process.env.TRAVELMORE_INTERCOM_LIVE_TARGET;
let received = 0;
peer.on('message', async (from: any, message: any) => {
  received++;
  assert.match(message.content.text, /TravelMore · local dev/);
  assert.match(message.content.text, /development consultation, not authorization/);
  if (message.content.text.includes('WAIT-CANCEL')) return;
  await peer.send(from.id, { text: 'TravelMore intercom OK', replyTo: message.id });
});
await peer.connect({ name: `TravelMore-fullfill-${peerId}`, cwd: root, model: 'fullfill-peer', pid: process.pid, startedAt: Date.now(), lastActivity: Date.now() }, peerId);

const valid = { NODE_ENV: 'development', TRAVELMORE_DEV_INTERCOM: '1', TRAVELMORE_INTERCOM_TARGET: peerId, TRAVELMORE_DEV_LOCAL_TOKEN: 'x'.repeat(64), TRAVELMORE_INTERCOM_CLI: cli };
assert.ok(devIntercomConfig(valid));
assert.equal(devIntercomConfig({ ...valid, NODE_ENV: 'production' }), undefined);
assert.equal(devIntercomConfig({ ...valid, NODE_ENV: '' }), undefined);
assert.equal(devIntercomConfig({ ...valid, TRAVELMORE_DEV_INTERCOM: '0' }), undefined);
assert.equal(devIntercomConfig({ ...valid, TRAVELMORE_INTERCOM_TARGET: 'someone@remote' }), undefined);
assert.equal(devIntercomConfig({ ...valid, TRAVELMORE_INTERCOM_TARGET: '' }), undefined);

const dataDir = await mkdtemp(join(tmpdir(), 'travelmore-intercom-'));
let modelRequests: any[] = [];
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    const request = JSON.parse(body);
    modelRequests.push(request);
    const result = request.messages.findLast((message: any) => message.role === 'tool');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta: any, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (result) {
      emit({ role: 'assistant', content: `Intercom result: ${result.content}` }); emit({}, 'stop');
    } else {
      // Deliberately request it even when undeclared, to prove denied callers cannot execute it.
      emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'intercom-call', type: 'function', function: { name: 'dev_intercom', arguments: JSON.stringify({ message: body.includes('WAIT-CANCEL') ? 'WAIT-CANCEL' : 'Verification only. Please reply exactly: TravelMore intercom OK' }) } }] });
      emit({}, 'tool_calls');
    }
    res.end('data: [DONE]\n\n');
  });
});
await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve));
const mockPort = (mock.address() as any).port;
const child = spawn(process.execPath, ['dev.mjs'], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'development', TRAVELMORE_DEV_INTERCOM: '1', TRAVELMORE_INTERCOM_CLI: cli, TRAVELMORE_INTERCOM_TARGET: liveTarget || peerId, TRAVELMORE_DATA_DIR: dataDir, TRAVELMORE_GEOCODER_URL: 'off', TRAVELMORE_SEARCH_PROVIDER: 'off', PORT: '0', HOST: '127.0.0.1', TRAVELMORE_ALLOWED_ORIGINS: '' },
});
let output = '';
child.stdout.on('data', chunk => output += chunk);
child.stderr.on('data', chunk => output += chunk);
const connections: { socket: WebSocket; rpc: any }[] = [];
async function until(predicate: () => any, label: string, timeout = 25000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw new Error(`${label} timed out\n${output}`); await new Promise(resolve => setTimeout(resolve, 30)); }
}
async function connect(url: string, origin?: string, headers = {}) {
  const socket = new WebSocket(`${url.replace(/^http/, 'ws')}/rpc`, { ...(origin ? { origin } : {}), headers });
  await once(socket, 'open');
  const rpc = new RpcAble({ transport: 'websocket', connection: socket, channel: '-userSession', role: 'user', targetReceiver: { agentEvent() {}, chatUpdated() {}, travelUpdated() {} } });
  connections.push({ socket, rpc }); return rpc;
}
async function configure(rpc: any) {
  const saved = await rpc.saveProviderConnection({ name: 'Fullfill model', api: 'openai-completions', auth: 'apiKey', apiKey: 'fixture', baseUrl: `http://127.0.0.1:${mockPort}/v1` });
  await rpc.configureProvider({ scope: 'workspace', providerId: saved.connectionId, model: 'mock', api: 'openai-completions', contextWindow: 32768, maxTokens: 4096, reasoning: false, vision: false, thinking: 'off' });
}
async function run(rpc: any, enabled: boolean, text = 'Consult the developer through intercom.') {
  modelRequests = [];
  const before = received;
  rpc.startChat({ scope: 'workspace', text });
  await until(() => modelRequests.length, 'model request');
  assert.equal(modelRequests[0].tools.some((tool: any) => tool.function.name === 'dev_intercom'), enabled, 'Tool declaration must match connection capability');
  if (text.includes('WAIT-CANCEL')) {
    await until(() => received > before, 'inbound ask before cancellation');
    await rpc.cancelChat({ scope: 'workspace' });
  }
  const deadline = Date.now() + (liveTarget ? 135000 : 15000);
  let chat: any;
  do {
    chat = await rpc.getChat({ scope: 'workspace' });
    if (Date.now() > deadline) throw new Error('Agent never settled.');
    if (chat.state.running) await new Promise(resolve => setTimeout(resolve, 60));
  } while (chat.state.running);
  const toolResult = modelRequests.flatMap(request => request.messages).findLast((message: any) => message.role === 'tool');
  if (enabled && !text.includes('WAIT-CANCEL')) {
    assert.match(String(toolResult?.content), /TravelMore intercom OK/, 'Actual intercom reply reaches the model as tool output');
    assert.match(chat.entries.at(-1).text, /TravelMore intercom OK/, 'Reply reaches the visible chat');
  }
  if (!enabled) assert.equal(received, before, 'An undeclared tool cannot contact intercom');
  return chat;
}
try {
  await until(() => /client ready on (http:\/\/\S+)/.test(output), 'dev server readiness');
  const url = output.match(/client ready on (http:\/\/\S+)/)![1].replace(/\/$/, '');
  assert.match(output, /local dev intercom: enabled/);
  const local = await connect(url, url);
  await configure(local);
  assert.ok((await local.getAgentStatus({ scope: 'workspace' })).tools.includes('dev_intercom'));
  await run(local, true);
  console.log('PASS: local UI → RPC → SDK tool → CLI → real intercom broker → reply → model → chat');
  if (!liveTarget) {
    // Clear conversation between scenarios so the fixture model cannot reuse previous tool results.
    // Each request starts a fresh SDK session; prior chat is a plain user-message digest.
    const remoteOrigin = await connect(url, 'http://100.100.10.20:12345', { 'x-travelmore-dev-local': 'forged', 'x-forwarded-for': '127.0.0.1' });
    assert.ok(!(await remoteOrigin.getAgentStatus({ scope: 'workspace' })).tools.includes('dev_intercom'));
    await run(remoteOrigin, false);
    const noOrigin = await connect(url);
    await run(noOrigin, false);
    const lanIp = Object.values(networkInterfaces()).flat().find(address => address?.family === 'IPv4' && !address.internal)?.address;
    assert.ok(lanIp, 'A real non-loopback interface is required to verify LAN spoof rejection');
    const lanUrl = url.replace('localhost', lanIp).replace('127.0.0.1', lanIp);
    const lan = await connect(lanUrl, url, { host: new URL(url).host, 'x-travelmore-dev-local': 'forged', 'x-forwarded-for': '127.0.0.1' });
    await run(lan, false);
    console.log('PASS: Tailscale origin, missing origin and actual LAN socket (even with forged local headers) cannot declare or execute the tool');
    await run(local, true, 'WAIT-CANCEL');
    console.log('PASS: Cancel stops a pending intercom wait and the agent returns idle');
    for (const env of [{ NODE_ENV: 'production', TRAVELMORE_DEV_INTERCOM: '1' }, { NODE_ENV: 'development', TRAVELMORE_DEV_INTERCOM: '0' }]) {
      const isolated = await mkdtemp(join(tmpdir(), 'travelmore-intercom-denied-'));
      const token = 't'.repeat(64);
      const server = spawn(process.execPath, [fileURLToPath(import.meta.resolve('tsx/cli')), 'src/index.ts'], {
        cwd: join(root, 'server'), stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...env, TRAVELMORE_DEV_LOCAL_TOKEN: token, TRAVELMORE_INTERCOM_TARGET: peerId, TRAVELMORE_INTERCOM_CLI: cli, TRAVELMORE_DATA_DIR: isolated, TRAVELMORE_GEOCODER_URL: 'off', PORT: '0', HOST: '127.0.0.1' },
      });
      let log = '';
      server.stdout.on('data', chunk => log += chunk);
      server.stderr.on('data', chunk => log += chunk);
      try {
        await until(() => /ready on (http:\/\/\S+)/.test(log), 'disabled server readiness');
        const address = log.match(/ready on (http:\/\/\S+)/)![1];
        const disabled = await connect(address, address, { 'x-travelmore-dev-local': token });
        await configure(disabled);
        await run(disabled, false);
      } finally {
        const stopped = once(server, 'exit'); server.kill('SIGTERM'); await stopped;
        await rm(isolated, { recursive: true, force: true });
      }
    }
    console.log('PASS: production and opt-out processes cannot expose/execute intercom even with a valid local capability');
  }
} finally {
  for (const { socket, rpc } of connections) { destroy(rpc); socket.close(); }
  child.kill('SIGTERM');
  const stopped = once(child, 'exit');
  const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
  await stopped; clearTimeout(deadline);
  await new Promise<void>(resolve => mock.close(() => resolve()));
  await peer.disconnect();
  await rm(dataDir, { recursive: true, force: true });
}
