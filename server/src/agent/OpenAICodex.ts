import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Credential, CredentialInfo, CredentialStore, AuthOperationOptions } from '@earendil-works/pi-ai';
import { planManager, type TravelProviderStorage } from '../services/providers.js';

/**
 * ChatGPT (OpenAI Codex) sign-in.
 *
 * Same shape as Blueed: Pi owns the OAuth flow and the token refresh, this module only adapts Pi's
 * credential store to the provider records in `providers.json`. TravelMore keeps every credential
 * server-side, so the browser never sees tokens — it only receives the sign-in link and a status.
 */

export const OPENAI_CODEX_PROVIDER = 'openai-codex';
export const OPENAI_CODEX_API = 'openai-codex-responses';
export const OPENAI_CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
export const OPENAI_CODEX_NPM = '@earendil-works/pi-ai/openai-codex';

/** Static catalogue shipped with the installed Pi OpenAI Codex provider; an account may expose less. */
export const openAICodexModels = [
  { model: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', contextWindow: 500_000, maxTokens: 128_000, reasoning: true, vision: true },
  { model: 'gpt-6-astra', name: 'GPT-6 Astra', contextWindow: 272_000, maxTokens: 128_000, reasoning: true, vision: true },
  { model: 'gpt-6-luna', name: 'GPT-6 Luna', contextWindow: 272_000, maxTokens: 128_000, reasoning: true, vision: true },
  { model: 'gpt-6-sol', name: 'GPT-6 Sol', contextWindow: 272_000, maxTokens: 128_000, reasoning: true, vision: true },
  { model: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', contextWindow: 272_000, maxTokens: 128_000, reasoning: true, vision: true },
  { model: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', contextWindow: 272_000, maxTokens: 128_000, reasoning: true, vision: true },
  { model: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', contextWindow: 272_000, maxTokens: 128_000, reasoning: true, vision: true },
];

/** Serializes token refreshes so an agent session and a status read never write concurrently. */
const credentialQueues = new Map<string, Promise<unknown>>();

function asCredential(auth: any): Credential | undefined {
  if (!auth || auth.type !== 'oauth' || typeof auth.data?.access !== 'string' || typeof auth.data?.refresh !== 'string' || typeof auth.data?.accountId !== 'string' || !auth.expiresAt) return undefined;
  const expires = Date.parse(auth.expiresAt);
  if (!Number.isFinite(expires)) return undefined;
  return { type: 'oauth', access: auth.data.access, refresh: auth.data.refresh, expires, clientId: auth.data.clientId, accountId: auth.data.accountId, scopes: auth.data.scopes };
}

/** Pi credential contract backed by the server-only provider records. */
export class OpenAICodexCredentialStore implements CredentialStore {
  constructor(private storage: TravelProviderStorage, private connectionId: string) {}
  private async auth() {
    const provider = await planManager(this.storage).getProviderConfig(this.connectionId);
    if (!provider?.currentAuthId) return null;
    return planManager(this.storage).getProviderAuth(provider.currentAuthId);
  }
  async read(providerId: string, options?: AuthOperationOptions) {
    options?.signal?.throwIfAborted();
    if (providerId !== OPENAI_CODEX_PROVIDER) return undefined;
    const credential = asCredential(await this.auth());
    options?.signal?.throwIfAborted();
    return credential;
  }
  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    return (await this.read(OPENAI_CODEX_PROVIDER, options)) ? [{ providerId: OPENAI_CODEX_PROVIDER, type: 'oauth' }] : [];
  }
  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions) {
    if (providerId !== OPENAI_CODEX_PROVIDER) return undefined;
    const previous = credentialQueues.get(this.connectionId) || Promise.resolve();
    const operation = (async () => {
      await previous.catch(() => {});
      options?.signal?.throwIfAborted();
      const manager = planManager(this.storage);
      const provider = await manager.getProviderConfig(this.connectionId);
      if (!provider) throw new Error('OpenAI Codex connection not found.');
      const auth = provider.currentAuthId ? await manager.getProviderAuth(provider.currentAuthId) : null;
      const next = await fn(asCredential(auth));
      options?.signal?.throwIfAborted();
      if (!next) return asCredential(auth);
      if (next.type !== 'oauth') throw new Error('OpenAI Codex requires ChatGPT sign-in.');
      const data = { access: next.access, refresh: next.refresh, clientId: next.clientId, accountId: next.accountId, scopes: next.scopes };
      const expiresAt = new Date(next.expires).toISOString();
      if (auth) await manager.updateProviderAuth(auth.id, { type: 'oauth', data, expiresAt, label: 'ChatGPT OAuth' });
      else await manager.createProviderAuth('owner', this.connectionId, { type: 'oauth', data, expiresAt, label: 'ChatGPT OAuth' });
      return next;
    })();
    credentialQueues.set(this.connectionId, operation.catch(() => {}));
    return operation;
  }
  async delete(providerId: string, options?: AuthOperationOptions) {
    if (providerId !== OPENAI_CODEX_PROVIDER) return;
    options?.signal?.throwIfAborted();
    const auth = await this.auth();
    if (auth) await planManager(this.storage).deleteProviderAuth(auth.id);
  }
}

export async function openAICodexRuntime(storage: TravelProviderStorage, connectionId: string) {
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  return ModelRuntime.create({ credentials: new OpenAICodexCredentialStore(storage, connectionId), modelsPath: null, refreshOnCreate: false });
}

/** The session model comes from Pi's own catalogue, so Codex keeps its native wire format. */
export function openAICodexModel(runtime: ModelRuntime, modelId: string, limits?: { contextWindow?: number; maxTokens?: number }) {
  const model: any = runtime.getModel(OPENAI_CODEX_PROVIDER, modelId);
  if (!model || model.api !== OPENAI_CODEX_API) throw new Error(`Unsupported OpenAI Codex model: ${modelId}.`);
  if (!limits) return model;
  const { contextWindow, maxTokens } = limits;
  if (typeof contextWindow !== 'number' || !Number.isSafeInteger(contextWindow) || contextWindow < 1 || typeof maxTokens !== 'number' || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > contextWindow) throw new Error('Invalid model context/output token settings.');
  return { ...model, contextWindow, maxTokens };
}

/** Stable per-server agent-host identity required by OpenAI's sign-in flow. */
export async function openAIDeviceId(root: string) {
  const path = join(root, 'openai-device.json');
  try {
    const saved = JSON.parse(await readFile(path, 'utf8'));
    if (saved && typeof saved.id === 'string') return saved.id;
  } catch { /* first sign-in on this machine */ }
  const id = randomUUID();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify({ id }), { encoding: 'utf8', mode: 0o600 });
  return id;
}
