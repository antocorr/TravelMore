import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PlanManager } from 'ai-provider-manager';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/compat';
import { OPENAI_CODEX_API, OPENAI_CODEX_BASE_URL, OPENAI_CODEX_NPM, OPENAI_CODEX_PROVIDER, openAICodexModels } from '../agent/OpenAICodex.js';

/**
 * Provider connections, credentials and model selections.
 *
 * Same architecture as Blueed: `ai-provider-manager` owns the provider/auth/model records and the
 * models.dev registry, this module owns the JSON persistence and the public projections. The
 * difference is the selection scope: TravelMore selects a model per assistant scope
 * (`'workspace'` for the shared default, a trip UUID for an override), so a scope is just a
 * provider-manager project id.
 */

export type ModelCatalogOption = { model: string; name: string; contextWindow: number; maxTokens: number; api?: string; baseUrl?: string; auth?: string; reasoning?: boolean; vision?: boolean };
export type ModelCatalogGroup = { id: string; name: string; api: string; baseUrl: string; auth: string; models: ModelCatalogOption[] };
export type ModelCatalog = { status: 'loading' | 'fresh' | 'stale' | 'unavailable'; updatedAt: string; groups: ModelCatalogGroup[]; omitted: number };
export type ProviderConnection = { id: string; name: string; baseUrl: string; api: string; catalogId: string; auth: 'none' | 'apiKey' | 'oauth'; hasKey: boolean };
export type ProviderSelection = { providerId: string; model: string; api: string; baseUrl: string; contextWindow: number; maxTokens: number; reasoning: boolean; vision: boolean; thinking: string; thinkingLevels: string[]; name: string; auth: string; configured: boolean; inherited?: boolean };
export type AgentSettings = { providerId: string; name: string; api: string; baseUrl: string; apiKey: string; model: string; oauth?: boolean; contextWindow: number; maxTokens: number; reasoning: boolean; vision: boolean; thinking: string };

const OWNER = 'owner';
const WORKSPACE = 'workspace';
export const SUPPORTED_APIS = ['openai-completions', 'openai-responses', 'openai-codex-responses', 'anthropic-messages', 'google-generative-ai'] as const;
export const modelCatalogDefaults: ModelCatalog = { status: 'loading', updatedAt: '', groups: [], omitted: 0 };
const npmForApi = (api: string) => api === 'openai-codex-responses' ? '@earendil-works/pi-ai/openai-codex' : api.startsWith('openai') ? '@ai-sdk/openai-compatible' : api === 'anthropic-messages' ? '@ai-sdk/anthropic' : '@ai-sdk/google';
export const apiForNpm: Record<string, string> = { '@earendil-works/pi-ai/openai-codex': 'openai-codex-responses', '@ai-sdk/openai-compatible': 'openai-completions', '@ai-sdk/openai': 'openai-responses', '@ai-sdk/anthropic': 'anthropic-messages', '@ai-sdk/google': 'google-generative-ai', '@openrouter/ai-sdk-provider': 'openai-completions' };
const endpoints: Record<string, string> = { openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com', google: 'https://generativelanguage.googleapis.com/v1beta' };

type Records = Record<string, Record<string, any>>;
type Change = { bucket: string; id: string; value?: any };

/** Atomic JSON write shared by both provider files. */
async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}
async function readJson(path: string, fallback: any) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; } }

/**
 * `ai-provider-manager` IStorage implementation over two private files.
 * Records live in `providers.json`; the models.dev cache keeps its own file so a catalogue
 * refresh never rewrites credentials.
 */
export class TravelProviderStorage {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly path: string, public records: Records = {}, private catalogPath?: string, private registryCache: any = null) {}
  static async open(root: string) {
    const path = join(root, 'providers.json');
    const raw = await readJson(path, {});
    const records: Records = {};
    for (const bucket of ['providers', 'auth', 'models', 'projects', 'userProjects']) records[bucket] = raw && typeof raw[bucket] === 'object' && !Array.isArray(raw[bucket]) ? raw[bucket] : {};
    const catalogPath = join(root, 'model-catalog.json');
    const registryCache = await readJson(catalogPath, null);
    return new TravelProviderStorage(path, records, catalogPath, registryCache);
  }
  /** Publish a related record set atomically; a rejected write restores memory. */
  async commit(changes: Change[]) {
    const previous: any[] = [];
    for (const change of changes) {
      if (!this.records[change.bucket]) this.records[change.bucket] = {};
      previous.push(this.records[change.bucket][change.id]);
      if (change.value === undefined) delete this.records[change.bucket][change.id];
      else this.records[change.bucket][change.id] = change.value;
    }
    try { await this.persist() } catch (error) {
      for (let index = 0; index < changes.length; index++) {
        const change = changes[index];
        if (this.records[change.bucket][change.id] !== change.value) continue;
        if (previous[index] === undefined) delete this.records[change.bucket][change.id];
        else this.records[change.bucket][change.id] = previous[index];
      }
      throw error;
    }
  }
  private persist() {
    const snapshot = { providers: this.records.providers || {}, auth: this.records.auth || {}, models: this.records.models || {}, projects: this.records.projects || {}, userProjects: this.records.userProjects || {} };
    const write = this.queue.then(() => writeJson(this.path, snapshot));
    this.queue = write.then(() => undefined, () => undefined);
    return write;
  }
  async save(bucket: string, value: any) { await this.commit([{ bucket, id: value.id, value }]); return value; }
  async get(bucket: string, id: string) { return this.records[bucket] && this.records[bucket][id] || null; }
  async remove(bucket: string, id: string) { await this.commit([{ bucket, id }]); }
  async list(bucket: string, key: string, value: unknown) { return Object.values(this.records[bucket] || {}).filter(item => item[key] === value); }
  saveProviderConfig(v: any) { return this.save('providers', v); }
  getProviderConfig(id: string) { return this.get('providers', id); }
  getProviderConfigsByUser(id: string) { return this.list('providers', 'userId', id); }
  deleteProviderConfig(id: string) { return this.remove('providers', id); }
  saveProviderAuth(v: any) { return this.save('auth', v); }
  getProviderAuth(id: string) { return this.get('auth', id); }
  getProviderAuthsByProviderConfig(id: string) { return this.list('auth', 'providerConfigId', id); }
  getProviderAuthsByUser(id: string) { return this.list('auth', 'userId', id); }
  deleteProviderAuth(id: string) { return this.remove('auth', id); }
  saveModelConfig(v: any) { return this.save('models', v); }
  getModelConfig(id: string) { return this.get('models', id); }
  getModelConfigsByUser(id: string) { return this.list('models', 'userId', id); }
  getModelConfigsByProvider(id: string) { return this.list('models', 'providerId', id); }
  deleteModelConfig(id: string) { return this.remove('models', id); }
  saveProjectConfig(v: any) { return this.save('projects', v); }
  getProjectConfig(id: string) { return this.get('projects', id); }
  deleteProjectConfig(id: string) { return this.remove('projects', id); }
  saveUserProjectConfig(v: any) { return this.save('userProjects', { ...v, id: `${v.projectId}:${v.userId}` }); }
  getUserProjectConfig(projectId: string, userId: string) { return this.get('userProjects', `${projectId}:${userId}`); }
  deleteUserProjectConfig(projectId: string, userId: string) { return this.remove('userProjects', `${projectId}:${userId}`); }
  async getRegistryCache() { return this.registryCache; }
  async saveRegistryCache(value: any) {
    if (!value || !value.providers || typeof value.providers !== 'object' || Array.isArray(value.providers)) throw new Error('Invalid models.dev catalogue.');
    for (const provider of Object.values(value.providers) as any[]) {
      if (!provider || typeof provider !== 'object' || Array.isArray(provider) || (provider.name !== undefined && typeof provider.name !== 'string') || !provider.models || typeof provider.models !== 'object' || Array.isArray(provider.models)) throw new Error('Invalid models.dev provider metadata.');
      for (const model of Object.values(provider.models) as any[]) if (!model || typeof model !== 'object' || Array.isArray(model) || (model.name !== undefined && typeof model.name !== 'string')) throw new Error('Invalid models.dev model metadata.');
    }
    this.registryCache = value;
    if (this.catalogPath) await writeJson(this.catalogPath, value);
  }
}

export function planManager(storage: TravelProviderStorage) { return new PlanManager({ singleProviderSetting: false, storage, registry: {} }); }

/** ChatGPT models are not on models.dev: they ship with Pi's own Codex provider. */
export function codexCatalogGroup(): ModelCatalogGroup {
  return { id: OPENAI_CODEX_PROVIDER, name: 'OpenAI Codex (ChatGPT account)', api: OPENAI_CODEX_API, baseUrl: OPENAI_CODEX_BASE_URL, auth: 'oauth', models: openAICodexModels };
}
/** Public metadata only: no records or credentials enter the catalogue. */
export function projectModelCatalog(cache: any, status: ModelCatalog['status']): ModelCatalog {
  const groups: ModelCatalogGroup[] = [];
  let omitted = 0;
  for (const providerId of Object.keys(cache && cache.providers || {}).sort()) {
    const provider = cache.providers[providerId];
    const models: ModelCatalogOption[] = [];
    let groupApi = '', groupBaseUrl = '', groupAuth = '';
    for (const modelId of Object.keys(provider.models || {}).sort()) {
      const model = provider.models[modelId], metadata = model.provider || {}, npm = metadata.npm || provider.npm;
      let api = Object.hasOwn(apiForNpm, npm) ? apiForNpm[npm] : '';
      if (metadata.shape) {
        if (api && api.startsWith('openai') && ['responses', 'completions'].includes(metadata.shape)) api = metadata.shape === 'responses' ? 'openai-responses' : 'openai-completions';
        else api = '';
      }
      const baseUrl = metadata.api || provider.api || endpoints[providerId] || '';
      let endpointSupported = false;
      try { const url = new URL(baseUrl); endpointSupported = url.protocol === 'https:' && !url.username && !url.password && !baseUrl.includes('${'); } catch {}
      const limit = model.limit || {}, modalities = model.modalities || {};
      if (!api || !endpointSupported || model.tool_call !== true || !Array.isArray(modalities.input) || !modalities.input.includes('text') || !Array.isArray(modalities.output) || !modalities.output.includes('text') || !Number.isInteger(limit.context) || limit.context < 8192 || !Number.isInteger(limit.output) || limit.output < 256) { omitted++; continue; }
      const contextWindow = Math.min(limit.context, 2_000_000), auth = provider.env && provider.env.length ? 'apiKey' : 'none';
      if (!models.length) { groupApi = api; groupBaseUrl = baseUrl; groupAuth = auth; }
      const option: ModelCatalogOption = { model: modelId, name: model.name || modelId, contextWindow, maxTokens: Math.min(limit.output, Math.floor(contextWindow / 2)) };
      if (api !== groupApi) option.api = api;
      if (baseUrl !== groupBaseUrl) option.baseUrl = baseUrl;
      if (auth !== groupAuth) option.auth = auth;
      if (model.reasoning === true) option.reasoning = true;
      if (modalities.input.includes('image')) option.vision = true;
      models.push(option);
    }
    if (models.length) groups.push({ id: providerId, name: provider.name || providerId, api: groupApi, baseUrl: groupBaseUrl, auth: groupAuth, models });
  }
  groups.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { status, updatedAt: cache ? cache.updatedAt : '', groups: [codexCatalogGroup(), ...groups], omitted };
}

let catalog: ModelCatalog = { ...modelCatalogDefaults };
let refreshing: Promise<ModelCatalog> | null = null;
/** Last published catalogue. Never performs I/O, so RPC snapshots stay immediate. */
export function getModelCatalog() { return catalog }
/** Boot refresh: the cached catalogue is published first, then models.dev metadata replaces it. */
export function refreshModelCatalog(storage: TravelProviderStorage): Promise<ModelCatalog> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const stored = await storage.getRegistryCache().catch(() => null);
      catalog = projectModelCatalog(stored, 'loading');
      try {
        await planManager(storage).updateRegistry();
        catalog = projectModelCatalog(await planManager(storage).getRegistry(), 'fresh');
      } catch {
        catalog = { ...catalog, status: stored ? 'stale' : 'unavailable' };
      }
    } catch {
      catalog = projectModelCatalog(null, 'unavailable');
    }
    return catalog;
  })().finally(() => { refreshing = null; });
  return refreshing;
}
/** Start of day refresh hook: call once at boot, without blocking the socket. */
export function startModelCatalog(storage: TravelProviderStorage) { void refreshModelCatalog(storage).catch(() => {}); }

export async function listProviderConnections(storage: TravelProviderStorage): Promise<ProviderConnection[]> {
  const manager = planManager(storage), models = await manager.getModelsByUser(OWNER), connections: ProviderConnection[] = [];
  for (const provider of await manager.getProvidersByUser(OWNER)) {
    const auth = provider.currentAuthId ? await manager.getProviderAuth(provider.currentAuthId) : null;
    const model = models.find(item => item.providerId === provider.id) as any;
    connections.push({ id: provider.id, name: provider.name || 'My provider', baseUrl: provider.baseUrl || '', api: (provider as any).api || (model && model.options && model.options.api) || 'openai-completions', catalogId: (provider as any).catalogId || '', auth: auth ? auth.type as ProviderConnection['auth'] : 'none', hasKey: !!(auth && auth.type === 'apiKey' && auth.data.key) });
  }
  return connections.sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveProviderConnection(storage: TravelProviderStorage, config: any) {
  if (typeof config?.name !== 'string' || !config.name.trim() || config.name.length > 200) throw new Error('Enter a connection name of at most 200 characters.');
  if (typeof config?.baseUrl !== 'string' || !URL.canParse(config.baseUrl)) throw new Error('Enter a valid HTTP(S) endpoint.');
  const url = new URL(config.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) endpoint without embedded credentials.');
  if (!SUPPORTED_APIS.includes(config.api)) throw new Error('Unsupported API protocol.');
  if (!['none', 'apiKey', 'oauth'].includes(config.auth)) throw new Error('Choose no auth, an API key or ChatGPT sign-in.');
  const manager = planManager(storage);
  const prior = config.id ? await manager.getProviderConfig(config.id) : null;
  if (config.id && (!prior || prior.userId !== OWNER)) throw new Error('Connection not found.');
  const auth = prior && prior.currentAuthId ? await manager.getProviderAuth(prior.currentAuthId) : null;
  const retainKey = !!(auth && auth.type === 'apiKey' && prior && new URL(prior.baseUrl || config.baseUrl).origin === url.origin);
  if (config.auth === 'apiKey' && !config.apiKey && !retainKey) throw new Error('Enter an API key for this endpoint. Keys are never reused across origins.');
  // OAuth is a sign-in, never a form: only the server-owned Codex connection can carry it.
  const isCodex = (value: any) => value?.api === OPENAI_CODEX_API && value?.baseUrl === OPENAI_CODEX_BASE_URL;
  if (config.auth === 'oauth' && !(isCodex(config) && prior && isCodex(prior) && auth?.type === 'oauth')) throw new Error('Connect a ChatGPT account with the sign-in button instead.');
  const fields = { name: config.name.trim(), baseUrl: config.baseUrl, api: config.api, catalogId: typeof config.catalogId === 'string' ? config.catalogId : '', npm: npmForApi(config.api) } as any;
  // Prepare both records off-store, then publish endpoint and credential together.
  const prepared = new TravelProviderStorage(storage.path, { providers: prior ? { [prior.id]: prior } : {}, auth: auth ? { [auth.id]: auth } : {} });
  const editor = planManager(prepared);
  const provider = prior || await editor.createProviderConfig(OWNER, fields);
  if (auth && config.auth !== 'oauth') {
    if (config.auth !== auth.type || config.apiKey) await editor.updateProviderAuth(auth.id, { type: config.auth as any, data: config.auth === 'none' ? {} : { key: config.apiKey } });
  } else if (config.auth === 'none') await editor.setProviderNoAuth(provider.id, OWNER);
  else await editor.setProviderApiKey(provider.id, OWNER, config.apiKey);
  await editor.updateProviderConfig(provider.id, fields);
  const changes: Change[] = [];
  for (const bucket of ['providers', 'auth']) for (const value of Object.values(prepared.records[bucket] || {})) changes.push({ bucket, id: value.id, value });
  await storage.commit(changes);
  return { connectionId: provider.id, connections: await listProviderConnections(storage) };
}

/** Create the server record before Pi writes its OAuth credential into it. */
export async function createOpenAICodexConnection(storage: TravelProviderStorage, name = 'OpenAI Codex') {
  if (typeof name !== 'string' || !name.trim() || name.length > 200) throw new Error('Enter a connection name of at most 200 characters.');
  const provider = await planManager(storage).createProviderConfig(OWNER, { name: name.trim(), api: OPENAI_CODEX_API, baseUrl: OPENAI_CODEX_BASE_URL, catalogId: OPENAI_CODEX_PROVIDER, npm: OPENAI_CODEX_NPM } as any);
  return provider.id;
}

/** Delete a connection with its credentials, model records and every selection pointing at it. */
export async function deleteProviderConnection(storage: TravelProviderStorage, connectionId: string) {
  const manager = planManager(storage);
  const provider = await manager.getProviderConfig(connectionId);
  if (!provider || provider.userId !== OWNER) throw new Error('Connection not found.');
  const changes: Change[] = [], modelIds = new Set<string>(), disconnectedScopes: string[] = [];
  for (const project of Object.values(storage.records.projects || {})) {
    if (!project || project.currentProviderId !== connectionId) continue;
    disconnectedScopes.push(project.id);
    if (project.defaultModelId) modelIds.add(project.defaultModelId);
    if (project.id !== WORKSPACE) changes.push({ bucket: 'projects', id: project.id });
  }
  for (const project of Object.values(storage.records.userProjects || {})) {
    if (!project || project.currentProviderId !== connectionId) continue;
    if (project.currentModelId) modelIds.add(project.currentModelId);
    if (String(project.id).startsWith(`${WORKSPACE}:`)) continue;
    changes.push({ bucket: 'userProjects', id: project.id });
  }
  if (disconnectedScopes.includes(WORKSPACE)) {
    const project = storage.records.projects?.[WORKSPACE];
    if (project?.defaultModelId) modelIds.add(project.defaultModelId);
    changes.push({ bucket: 'projects', id: WORKSPACE });
    changes.push({ bucket: 'userProjects', id: `${WORKSPACE}:${OWNER}` });
  }
  for (const auth of await manager.getProviderAuthsByProviderConfig(connectionId)) changes.push({ bucket: 'auth', id: auth.id });
  for (const model of await storage.getModelConfigsByProvider(connectionId)) modelIds.add(model.id);
  for (const id of modelIds) changes.push({ bucket: 'models', id });
  changes.push({ bucket: 'providers', id: connectionId });
  await storage.commit(changes);
  return { connections: await listProviderConnections(storage), disconnectedScopes };
}

/** Validate a model selection the way the agent will use it. */
async function preparedSelection(storage: TravelProviderStorage, config: any) {
  if (!config || typeof config !== 'object') throw new Error('Choose a provider and model.');
  if (typeof config.model !== 'string' || !config.model.trim() || config.model.length > 200) throw new Error('Enter an exact model ID of at most 200 characters.');
  const manager = planManager(storage);
  const provider = await manager.getProviderConfig(config.providerId);
  if (!provider || provider.userId !== OWNER) throw new Error('Choose a configured provider.');
  const api = config.api || (provider as any).api || 'openai-completions';
  if (!SUPPORTED_APIS.includes(api)) throw new Error('Unsupported API protocol.');
  if (!Number.isInteger(Number(config.contextWindow)) || Number(config.contextWindow) < 8192 || Number(config.contextWindow) > 2_000_000) throw new Error('Context window must be 8192–2000000 tokens.');
  if (!Number.isInteger(Number(config.maxTokens)) || Number(config.maxTokens) < 256 || Number(config.maxTokens) > Number(config.contextWindow) / 2) throw new Error('Output budget must be at least 256 and at most half the context window.');
  const reasoning = config.reasoning === true, thinking = config.thinking || 'off';
  if (!getSupportedThinkingLevels({ reasoning } as any).includes(thinking as any)) throw new Error('Thinking level is unavailable for this model.');
  return { provider, fields: { providerId: provider.id, model: config.model, options: { api, reasoning, vision: config.vision === true, thinking, contextWindow: Number(config.contextWindow), maxTokens: Number(config.maxTokens) } } };
}

/** Store the model selection for one scope. A trip scope overrides the shared workspace choice. */
export async function configureProvider(storage: TravelProviderStorage, scope: string, config: any) {
  const manager = planManager(storage), { provider, fields } = await preparedSelection(storage, config);
  const prior = await storage.getProjectConfig(scope);
  const previousModel = prior ? await manager.getModelConfig(prior.defaultModelId).catch(() => null) : null;
  // Reuse the scope's model record when it still exists; otherwise create one so a half-deleted scope is recoverable.
  const reuse = !!(prior && previousModel);
  const prepared = new TravelProviderStorage(storage.path, { models: reuse ? { [prior!.defaultModelId]: previousModel } : {} });
  const editor = planManager(prepared);
  const model = reuse ? await editor.updateModelConfig(prior!.defaultModelId, fields as any) : await editor.createModelConfig(OWNER, fields as any);
  const now = new Date().toISOString();
  const project = { id: scope, name: scope === WORKSPACE ? 'workspace' : scope, ownerId: OWNER, providerConfigAvailability: 'owner', currentProviderId: provider.id, defaultModelId: model.id, createdAt: reuse ? prior!.createdAt : now, updatedAt: now };
  await storage.commit([{ bucket: 'models', id: model.id, value: model }, { bucket: 'projects', id: scope, value: project }]);
  return providerInfo(storage, scope);
}

/** Remove a scope override (a deleted trip, or a trip returning to the shared provider). */
export async function deleteScopeProvider(storage: TravelProviderStorage, scope: string) {
  const project = await storage.getProjectConfig(scope);
  if (!project) return { cleared: false };
  const manager = planManager(storage);
  await manager.deleteModelConfig(project.defaultModelId).catch(() => {});
  await manager.deleteUserProjectConfig(scope, OWNER).catch(() => {});
  await manager.deleteProject(scope).catch(() => {});
  return { cleared: true };
}

const emptySelection = (configured = false): ProviderSelection => ({ providerId: '', name: '', model: '', api: 'openai-completions', baseUrl: '', contextWindow: 32768, maxTokens: 4096, reasoning: false, vision: false, thinking: 'off', thinkingLevels: getSupportedThinkingLevels({ reasoning: false } as any), auth: 'none', configured });

/** Effective selection for a scope: its own records, or the workspace ones. Credentials are never returned. */
export async function providerInfo(storage: TravelProviderStorage, scope: string): Promise<ProviderSelection> {
  const manager = planManager(storage);
  const read = async (target: string) => {
    const project = await storage.getProjectConfig(target);
    if (!project) return null;
    const settings = await manager.getSettings(target, OWNER) as any, provider = await manager.getProviderConfig(project.currentProviderId) as any;
    const reasoning = settings.options?.reasoning === true;
    return {
      ...emptySelection(true),
      providerId: project.currentProviderId,
      name: settings.providerName || 'My provider',
      baseUrl: settings.baseUrl || '',
      model: settings.model,
      api: settings.options?.api || provider?.api || 'openai-completions',
      contextWindow: Number(settings.options?.contextWindow) || 32768,
      maxTokens: Number(settings.options?.maxTokens) || 4096,
      reasoning,
      vision: settings.options?.vision === true,
      thinking: settings.options?.thinking || 'off',
      thinkingLevels: getSupportedThinkingLevels({ reasoning } as any),
      auth: settings.auth?.type || 'none',
    };
  };
  let own = null;
  try { own = await read(scope); } catch { own = null; }
  if (own) return { ...own, inherited: false };
  if (scope !== WORKSPACE) { try { const shared = await read(WORKSPACE); if (shared) return { ...shared, inherited: true }; } catch {} }
  return { ...emptySelection(false), inherited: scope !== WORKSPACE };
}

/** What the agent needs to open a Pi session; throws with a user-facing message when unusable. */
export async function agentSettings(storage: TravelProviderStorage, scope: string): Promise<AgentSettings> {
  const manager = planManager(storage);
  const resolve = async (target: string) => {
    const project = await storage.getProjectConfig(target);
    if (!project) return null;
    const settings = await manager.getSettings(target, OWNER) as any;
    return { project, settings };
  };
  const own = await resolve(scope).catch(() => null);
  const chosen = own || (scope === WORKSPACE ? null : await resolve(WORKSPACE).catch(() => null));
  if (!chosen) throw new Error('No provider is configured. Add a connection in the assistant settings.');
  const { project, settings } = chosen;
  const provider = await manager.getProviderConfig(project.currentProviderId);
  const api = settings.options?.api || (provider as any)?.api || 'openai-completions';
  if (!SUPPORTED_APIS.includes(api)) throw new Error('The configured provider uses an unsupported API protocol.');
  const baseUrl = String(settings.baseUrl || ''), apiKey = String(settings.apiKey || '');
  if (!baseUrl.trim()) throw new Error('The configured provider has no endpoint. Update it in Settings.');
  const oauth = settings.auth?.type === 'oauth';
  if (api !== OPENAI_CODEX_API && settings.auth?.type === 'apiKey' && !apiKey.trim()) throw new Error('The configured provider has no API key. Update it in Settings.');
  const contextWindow = Number(settings.options?.contextWindow) || 32768, maxTokens = Number(settings.options?.maxTokens) || 4096;
  if (!provider?.currentAuthId || !(await storage.getProviderAuth(provider.currentAuthId))) throw new Error('The configured provider has no stored authentication. Update it in Settings.');
  return { providerId: project.currentProviderId, name: settings.providerName || 'My provider', api, baseUrl, apiKey, model: settings.model, oauth, contextWindow, maxTokens, reasoning: settings.options?.reasoning === true, vision: settings.options?.vision === true, thinking: settings.options?.thinking || 'off' };
}

export async function providerConfigured(storage: TravelProviderStorage, scope: string) {
  const info = await providerInfo(storage, scope).catch(() => null);
  return !!info?.configured;
}

/**
 * One-shot migration of the pre-`ai-provider-manager` records that lived in `travelmore.json`.
 * Runs only when no provider file exists yet, and never deletes data it cannot translate.
 */
export async function migrateLegacyProviders(storage: TravelProviderStorage, legacy: { providers?: any[]; tripProviders?: Record<string, string> }) {
  const providers = Array.isArray(legacy?.providers) ? legacy.providers : [];
  const selections = legacy?.tripProviders && typeof legacy.tripProviders === 'object' ? legacy.tripProviders : {};
  if (!providers.length && !Object.keys(selections).length) return { connections: 0, scopes: 0 };
  const manager = planManager(storage), idByLegacy = new Map<string, string>(), migrated: string[] = [];
  for (const record of providers) {
    if (!record || typeof record !== 'object') continue;
    const api = SUPPORTED_APIS.includes(record.provider) ? record.provider : 'openai-completions';
    try {
      const provider = await manager.createProviderConfig(OWNER, { name: record.name || 'My provider', baseUrl: record.baseUrl || '', api, npm: npmForApi(api), catalogId: '' } as any);
      if (record.apiKey) await manager.setProviderApiKey(provider.id, OWNER, String(record.apiKey));
      else await manager.setProviderNoAuth(provider.id, OWNER);
      idByLegacy.set(record.id, provider.id);
      migrated.push(record.id);
    } catch { /* keep going: one unreadable record must not block the rest */ }
  }
  let scopes = 0;
  for (const [scope, legacyId] of Object.entries(selections)) {
    const providerId = idByLegacy.get(legacyId);
    const record = providers.find(item => item?.id === legacyId);
    if (!providerId || !record) continue;
    try {
      await configureProvider(storage, scope, { providerId, model: record.model, api: SUPPORTED_APIS.includes(record.provider) ? record.provider : 'openai-completions', contextWindow: 32768, maxTokens: 4096, reasoning: false, vision: false, thinking: 'off' });
      scopes++;
    } catch { /* a stale selection is safer to drop than to guess */ }
  }
  return { connections: migrated.length, scopes };
}
