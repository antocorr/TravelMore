import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TravelStore } from '../server/src/store.js';
import { TravelService } from '../server/src/services/travel.js';
import { TravelAgent } from '../server/src/agent/TravelAgent.js';

const root = await mkdtemp(join(tmpdir(), 'travelmore-pi-')), events: any[] = [];
let calls = 0;
const mock = createServer((req, res) => { let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => { calls++; const parentId = body.match(/[a-f0-9-]{36}/i)?.[0] || ''; res.writeHead(200, { 'content-type': 'text/event-stream' }); const chunk = (delta: any, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`); if (calls === 1) { chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_create', type: 'function', function: { name: 'create_node', arguments: JSON.stringify({ parentId, type: 'stop', title: 'Mock stop' }) } }] }); chunk({}, 'tool_calls'); } else { chunk({ role: 'assistant', content: 'Created Mock stop.' }); chunk({}, 'stop'); } res.end('data: [DONE]\n\n'); }); });
await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve)); const port = (mock.address() as any).port;
try {
  const store = new TravelStore(root); await store.open(); const travel = new TravelService(store); const trip = await travel.createNode({ parentId: null, type: 'trip', title: 'Mock trip' });
  const agent = new TravelAgent(travel, trip.node.id, event => events.push(event)); await agent.open({ name: 'Mock', api: 'openai-completions', model: 'mock', apiKey: 'test', baseUrl: `http://127.0.0.1:${port}/v1`, contextWindow: 32768, maxTokens: 4096, reasoning: false, vision: false, thinking: 'off' }); await agent.prompt(`Create a stop under trip ${trip.node.id}.`); await agent.abort(); agent.dispose();
  assert.equal(travel.getTripTree({ tripId: trip.node.id }).nodes.some(node => node.title === 'Mock stop'), true); assert.equal(events.some(event => event.type === 'tool_execution_end'), true); assert.equal(events.some(event => event.type === 'message_end' && event.message?.role === 'assistant'), true); console.log('pi-agent mock flow: PASS');
} finally { await new Promise<void>(resolve => mock.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
