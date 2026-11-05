import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';

const MAX_WEB_BYTES = 512 * 1024;
const privateAddress = (address: string) => {
  const lower = address.toLowerCase().replace(/^::ffff:/, '');
  if (lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:') || lower.startsWith('ff') || lower.startsWith('2001:db8:')) return true;
  const octets = lower.split('.').map(Number); if (octets.length !== 4 || octets.some(Number.isNaN)) return false;
  return octets[0] === 0 || octets[0] === 10 || octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127 || octets[0] === 127 || octets[0] === 169 && octets[1] === 254 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31 || octets[0] === 192 && (octets[1] === 0 || octets[1] === 168) || octets[0] === 198 && (octets[1] === 18 || octets[1] === 19 || octets[1] === 51) || octets[0] === 203 && octets[1] === 0 && octets[2] === 113 || octets[0] >= 224;
};
const cleanUrl = async (value: unknown) => {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid URL.');
  const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Only public HTTPS URLs are allowed.');
  if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost')) throw new Error('Local URLs are not allowed.');
  const addresses = await lookup(url.hostname, { all: true, verbatim: true }); if (!addresses.length || addresses.some(answer => privateAddress(answer.address))) throw new Error('Private or unresolvable URL is not allowed.');
  return { url, addresses: addresses.map(answer => answer.address) };
};
export type PublicReadOptions = { accept?: string; userAgent?: string; timeoutMs?: number };
const DEFAULT_ACCEPT = 'text/html,text/plain,application/json;q=0.8';
const addressFamily = (address: string) => address.includes(':') ? 6 : 4;
/** Node 22 connects with `autoSelectFamily`, so the pinned address must be provided as an array too. */
const pinnedLookup = (addresses: string[]) => (_host: string, options: any, callback: any) => {
  if (options?.all) { callback(null, addresses.map(address => ({ address, family: addressFamily(address) }))); return; }
  callback(null, addresses[0], addressFamily(addresses[0]));
};
/** DNS-pinned public HTTPS reader; validates each redirect and bounds bytes while streaming. */
async function publicRead(raw: unknown, redirects = 0, options: PublicReadOptions = {}): Promise<{ url: string; status: number; body: Uint8Array; contentType: string }> {
  if (redirects > 3) throw new Error('Too many redirects.'); const target = await cleanUrl(raw);
  return new Promise((resolve, reject) => {
    let settled = false; const finish = (error?: Error, result?: { url: string; status: number; body: Uint8Array; contentType: string }) => { if (settled) return; settled = true; error ? reject(error) : resolve(result!); };
    const request = httpsRequest(target.url, { method: 'GET', headers: { accept: options.accept || DEFAULT_ACCEPT, 'user-agent': options.userAgent || 'TravelMore/0.1' }, timeout: options.timeoutMs ?? 10_000, lookup: pinnedLookup(target.addresses) as any }, response => {
      const status = response.statusCode || 0, location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && location) { response.resume(); void publicRead(new URL(location, target.url).toString(), redirects + 1, options).then(resolve, reject); return; }
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_WEB_BYTES) { request.destroy(new Error('Web response exceeds 512KB.')); return; } chunks.push(chunk); });
      response.on('end', () => finish(undefined, { url: target.url.toString(), status, body: Buffer.concat(chunks), contentType: String(response.headers['content-type'] || '') }));
      response.on('error', error => finish(error));
    });
    request.once('timeout', () => request.destroy(new Error('Web request timed out.'))); request.once('error', error => finish(error)); request.end();
  });
}
const EXA_MCP_URL = 'https://mcp.exa.ai/mcp?tools=web_search_exa';
const MAX_SEARCH_BYTES = 512 * 1024;
/** Keyless, fixed-destination Exa MCP search. Queries go to Exa; result text is untrusted. */
export async function searchExa(query: string, limit: number, request: typeof fetch = fetch) {
  const response = await request(EXA_MCP_URL, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'web_search_exa', arguments: { query, numResults: limit } } }),
  });
  if (!response.ok || !response.body) throw new Error('Exa search is unavailable.');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_SEARCH_BYTES) { await response.body.cancel().catch(() => {}); throw new Error('Exa search response exceeds the size limit.'); }
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  const payloads = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim());
  if (!payloads.length) payloads.push(raw);
  const envelope = payloads.map(line => { try { return JSON.parse(line); } catch { return null; } }).find(item => item?.result || item?.error);
  if (!envelope || envelope.error || envelope.result?.isError) throw new Error('Exa search returned an error.');
  const text = envelope.result?.content?.find((item: any) => item?.type === 'text' && typeof item.text === 'string')?.text;
  if (typeof text !== 'string') throw new Error('Exa search returned no text.');
  const fetchedAt = new Date().toISOString();
  const results = text.split(/(?=^Title:\s)/m).slice(0, limit * 2).flatMap(block => {
    const url = block.match(/^URL:\s*(https:\/\/\S+)/m)?.[1];
    if (!url) return [];
    try { const parsed = new URL(url); if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return []; } catch { return []; }
    const title = block.match(/^Title:\s*(.+)$/m)?.[1]?.trim().slice(0, 500) || url;
    const snippet = (block.split(/\n(?:Highlights:|Text:)\s*\n?/)[1] || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
    return [{ title, url, snippet, provider: 'exa', fetchedAt }];
  }).slice(0, limit);
  return { status: 'observed', results, provider: 'exa', message: results.length ? undefined : 'No usable search references found.' };
}
/** Public HTTPS SearxNG when configured; otherwise keyless Exa MCP. Never silently fail over a configured private search to Exa. */
export async function searchWeb(input: any) {
  if (typeof input?.query !== 'string' || !input.query.trim() || input.query.length > 500) throw new Error('Invalid search query.');
  if (process.env.TRAVELMORE_SEARCH_PROVIDER === 'off') return { status: 'unavailable', results: [], message: 'Web search is disabled by the server.' };
  const query = input.query.trim(), limit = Number.isInteger(input.limit) ? Math.max(1, Math.min(10, input.limit)) : 5;
  const endpoint = process.env.TRAVELMORE_SEARCH_URL;
  if (!endpoint) {
    try { return await searchExa(query, limit); }
    catch { return { status: 'unavailable', results: [], message: 'Exa web search is temporarily unavailable. Retry later or configure a public HTTPS SearxNG endpoint.' }; }
  }
  const url = new URL(endpoint); url.searchParams.set('q', query); url.searchParams.set('format', 'json'); const response = await publicRead(url.toString());
  if (response.status < 200 || response.status >= 300) return { status: 'unavailable', results: [], message: `Search provider responded ${response.status}.` };
  let body: any; try { body = JSON.parse(new TextDecoder().decode(response.body)); } catch { throw new Error('Search provider did not return JSON.'); }
  const results = Array.isArray(body.results) ? body.results.slice(0, limit).flatMap((result: any) => typeof result?.url === 'string' && result.url.startsWith('https://') ? [{ title: typeof result.title === 'string' ? result.title.slice(0, 500) : result.url, url: result.url, snippet: typeof result.content === 'string' ? result.content.slice(0, 2000) : '', provider: 'searxng', fetchedAt: new Date().toISOString() }] : []) : [];
  return { status: 'observed', results, provider: 'searxng' };
}
/** JSON variant of the same pinned reader, used by server-side geocoding. Non-2xx replies keep their status and an empty body. */
export async function publicJson(raw: string, options: PublicReadOptions = {}) {
  const response = await publicRead(raw, 0, { accept: 'application/json', ...options });
  if (response.status < 200 || response.status >= 300) return { url: response.url, status: response.status, body: null };
  try { return { url: response.url, status: response.status, body: JSON.parse(new TextDecoder().decode(response.body)) }; } catch { throw new Error('Response was not valid JSON.'); }
}
export async function readWeb(input: any) { const response = await publicRead(input?.url); const raw = new TextDecoder().decode(response.body), text = raw.replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>|<[^>]+>/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 32_000); return { url: response.url, status: response.status, fetchedAt: new Date().toISOString(), text }; }
const runner = String.raw`import vm from 'node:vm';
const request = JSON.parse(Buffer.from(process.argv[1], 'base64url').toString());
// No host object ever crosses into the context: the input is re-parsed inside the realm and string
// code generation is disabled, so a value such as input.constructor.constructor has nothing to reach.
// Without both measures the child could recover its own realm and, since Node's permission model
// does not cover networking, make outbound HTTP requests.
const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
const source = '(async () => { "use strict"; const input = JSON.parse(' + JSON.stringify(JSON.stringify(request.input ?? null)) + ');\n' + request.code + '\n})()';
const script = new vm.Script(source, { filename: 'travelmore-execute-js.js' });
try {
  const output = await script.runInContext(context, { timeout: 750 });
  process.stdout.write(JSON.stringify({ result: output === undefined ? null : output }));
} catch (error) {
  process.stderr.write(String(error && error.message ? error.message : error));
  process.exitCode = 1;
}`;
/** Off unless the operator opts in: the tool is a convenience, not a requirement for planning. */
export function executeJsEnabled() { return process.env.TRAVELMORE_AGENT_EXECUTE_JS === '1'; }
/** Pure computation in a permission-restricted child process. CRUD uses explicit typed agent tools, never host FS. */
export async function executeJs(input: any) {
  if (!executeJsEnabled()) throw new Error('execute_js is disabled on this server. Set TRAVELMORE_AGENT_EXECUTE_JS=1 to enable the sandboxed JavaScript tool, or compute the value with the typed tools.');
  if (typeof input?.code !== 'string' || !input.code.trim() || input.code.length > 8_000) throw new Error('execute_js accepts 1–8000 characters of JavaScript.');
  const payload = JSON.stringify({ code: input.code, input: input.input ?? null }); if (Buffer.byteLength(payload, 'utf8') > 64 * 1024) throw new Error('execute_js input exceeds 64KB.');
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(payload).toString('base64url'); const child = spawn(process.execPath, ['--experimental-permission', '--disable-warning=ExperimentalWarning', '--input-type=module', '--eval', runner, encoded], { stdio: ['ignore', 'pipe', 'pipe'], env: {} }); let stdout = '', stderr = '', done = false;
    const finish = (error?: Error, result?: unknown) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('execute_js timed out.')); }, 1_500);
    child.stdout.on('data', chunk => { stdout += chunk; if (Buffer.byteLength(stdout) > 128 * 1024) { child.kill('SIGKILL'); finish(new Error('execute_js result exceeds 64KB.')); } }); child.stderr.on('data', chunk => { stderr += chunk; if (Buffer.byteLength(stderr) > 16 * 1024) { child.kill('SIGKILL'); finish(new Error('execute_js failed.')); } }); child.once('error', error => finish(error)); child.once('close', code => { if (code !== 0) return finish(new Error(/timed out/i.test(stderr) ? 'execute_js timed out after 750 ms.' : `execute_js failed: ${stderr.slice(0, 500) || code}`)); try { const result = JSON.parse(stdout); if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 64 * 1024) throw new Error('execute_js result exceeds 64KB.'); finish(undefined, result); } catch (error: any) { finish(error); } });

  });
}
