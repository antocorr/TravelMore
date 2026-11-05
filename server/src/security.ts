import type { IncomingMessage } from 'node:http';

/**
 * Browser-facing server. Only local origins are trusted by default: a public website you happen to
 * visit must not be able to drive a server bound on your machine. A private-network address is
 * accepted so the app also works from a phone or a second computer on the same LAN.
 *
 * Tailscale counts as private: a tailnet address is only reachable by devices you invited, and the
 * magic-link URL (`http://100.x.y.z:port/` or `http://machine.tailnet.ts.net/`) is how the app gets
 * opened from a phone when you are away. 100.64.0.0/10 is the shared CGNAT block Tailscale hands
 * out; 100.128.0.0/10 above it is public internet and stays rejected.
 */
const PRIVATE_V4 = [
  /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];
export function isPrivateHostname(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return true;
  if (PRIVATE_V4.some(pattern => pattern.test(host))) return true;
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true;
  // mDNS names such as "macbook.local" only resolve inside the local network; MagicDNS names
  // ("machine.tailnet-xxxx.ts.net") only resolve inside the tailnet.
  return host.endsWith('.local') || host.endsWith('.ts.net');
}
export function isAllowedOrigin(value: string | undefined) {
  if (!value || value === 'null') return false;
  const explicit = process.env.TRAVELMORE_ALLOWED_ORIGINS?.split(',').map(origin => origin.trim()).filter(Boolean);
  if (explicit?.length) return explicit.includes(value);
  try { const origin = new URL(value); return origin.protocol === 'http:' && isPrivateHostname(origin.hostname); }
  catch { return false; }
}
/** Native/non-browser WS clients have no Origin. Browsers always do, so a foreign page is rejected. */
export function assertSafeOrigin(request: IncomingMessage) {
  const origin = request.headers.origin;
  if (origin && !isAllowedOrigin(origin)) { const error = new Error('Origin is not allowed.'); (error as any).statusCode = 403; throw error; }
}
