import { PlanManager } from 'ai-provider-manager'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/compat'

/** Host-owned provider records; backing persistence is injected by browser/server. */
export class ProviderStorage {
    constructor(records = {}, persist = async () => {}, registryCache = null, persistRegistry = async () => {}) {
        this.records = records; this.persist = persist; this.registryCache = registryCache; this.persistRegistry = persistRegistry
    }
    /** Publish and persist a related set of records together; roll back rejected I/O.
     * @param {{bucket: string, id: string, value?: object}[]} changes
     */
    async commit(changes) {
        const previous = []
        for (const change of changes) {
            if (!this.records[change.bucket]) this.records[change.bucket] = {}
            previous.push(this.records[change.bucket][change.id])
            if (change.value === undefined) delete this.records[change.bucket][change.id]
            else this.records[change.bucket][change.id] = change.value
        }
        try { await this.persist(this.records, changes) }
        catch (error) {
            for (let i = 0; i < changes.length; i++) {
                const change = changes[i]
                if (this.records[change.bucket][change.id] !== change.value) continue
                if (previous[i] === undefined) delete this.records[change.bucket][change.id]
                else this.records[change.bucket][change.id] = previous[i]
            }
            throw error
        }
    }
    async save(bucket, value) { await this.commit([{ bucket, id: value.id, value }]); return value }
    async get(bucket, id) { return this.records[bucket] && this.records[bucket][id] || null }
    async remove(bucket, id) { await this.commit([{ bucket, id }]) }
    async list(bucket, key, value) { return Object.values(this.records[bucket] || {}).filter(item => item[key] === value) }
    saveProviderConfig(v) { return this.save('providers', v) }
    getProviderConfig(id) { return this.get('providers', id) }
    getProviderConfigsByUser(id) { return this.list('providers', 'userId', id) }
    deleteProviderConfig(id) { return this.remove('providers', id) }
    saveProviderAuth(v) { return this.save('auth', v) }
    getProviderAuth(id) { return this.get('auth', id) }
    getProviderAuthsByProviderConfig(id) { return this.list('auth', 'providerConfigId', id) }
    getProviderAuthsByUser(id) { return this.list('auth', 'userId', id) }
    deleteProviderAuth(id) { return this.remove('auth', id) }
    saveModelConfig(v) { return this.save('models', v) }
    getModelConfig(id) { return this.get('models', id) }
    getModelConfigsByUser(id) { return this.list('models', 'userId', id) }
    getModelConfigsByProvider(id) { return this.list('models', 'providerId', id) }
    deleteModelConfig(id) { return this.remove('models', id) }
    saveProjectConfig(v) { return this.save('projects', v) }
    getProjectConfig(id) { return this.get('projects', id) }
    deleteProjectConfig(id) { return this.remove('projects', id) }
    saveUserProjectConfig(v) { return this.save('userProjects', { ...v, id: `${v.projectId}:${v.userId}` }) }
    getUserProjectConfig(project, user) { return this.get('userProjects', `${project}:${user}`) }
    deleteUserProjectConfig(project, user) { return this.remove('userProjects', `${project}:${user}`) }
    async getRegistryCache() { return this.registryCache }
    async saveRegistryCache(v) {
        if (!v.providers || typeof v.providers !== 'object' || Array.isArray(v.providers)) throw new Error('Invalid models.dev catalogue.')
        for (const provider of Object.values(v.providers)) {
            if (!provider || typeof provider !== 'object' || Array.isArray(provider) || (provider.name !== undefined && typeof provider.name !== 'string') || !provider.models || typeof provider.models !== 'object' || Array.isArray(provider.models)) throw new Error('Invalid models.dev provider metadata.')
            for (const model of Object.values(provider.models)) {
                if (!model || typeof model !== 'object' || Array.isArray(model) || (model.name !== undefined && typeof model.name !== 'string')) throw new Error('Invalid models.dev model metadata.')
            }
        }
        await this.persistRegistry(v)
        this.registryCache = v
    }
}
export function planManager(storage) { return new PlanManager({ singleProviderSetting: false, storage, registry: {} }) }
/** Public metadata only: no project records or credentials enter the catalogue. */
export const modelCatalogDefaults = { status: 'loading', updatedAt: '', groups: [], omitted: 0 }
/** Project the real registry into protocols and text/tool models supported by Blueed/Pi.
 * @param {import('ai-provider-manager').RegistryCache | null} cache
 * @param {string} status
 */
export function projectModelCatalog(cache, status) {
    const groups = []
    let omitted = 0
    const protocols = { '@ai-sdk/openai-compatible': 'openai-completions', '@ai-sdk/openai': 'openai-responses', '@ai-sdk/anthropic': 'anthropic-messages', '@ai-sdk/google': 'google-generative-ai', '@openrouter/ai-sdk-provider': 'openai-completions' }
    const endpoints = { openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com', google: 'https://generativelanguage.googleapis.com/v1beta' }
    for (const providerId of Object.keys(cache && cache.providers || {}).sort()) {
        const provider = cache.providers[providerId]
        const models = []
        let groupApi = '', groupBaseUrl = '', groupAuth = ''
        for (const modelId of Object.keys(provider.models || {}).sort()) {
            const model = provider.models[modelId]
            const metadata = model.provider || {}
            const npm = metadata.npm || provider.npm
            let api = Object.hasOwn(protocols, npm) ? protocols[npm] : ''
            if (metadata.shape) {
                if (api && api.startsWith('openai') && ['responses', 'completions'].includes(metadata.shape)) api = metadata.shape === 'responses' ? 'openai-responses' : 'openai-completions'
                else api = ''
            }
            const baseUrl = metadata.api || provider.api || endpoints[providerId] || ''
            let endpointSupported = false
            try { const url = new URL(baseUrl); endpointSupported = url.protocol === 'https:' && !url.username && !url.password && !baseUrl.includes('${') } catch {}
            const limit = model.limit || {}, modalities = model.modalities || {}
            if (!api || !endpointSupported || model.tool_call !== true || !Array.isArray(modalities.input) || !modalities.input.includes('text') || !Array.isArray(modalities.output) || !modalities.output.includes('text') || !Number.isInteger(limit.context) || limit.context < 8192 || !Number.isInteger(limit.output) || limit.output < 256) { omitted++; continue }
            const contextWindow = Math.min(limit.context, 2000000)
            const auth = provider.env && provider.env.length ? 'apiKey' : 'none'
            if (!models.length) { groupApi = api; groupBaseUrl = baseUrl; groupAuth = auth }
            /** @type {import('./providers.js').ModelCatalogOption} */
            const option = { model: modelId, name: model.name || modelId, contextWindow, maxTokens: Math.min(limit.output, Math.floor(contextWindow / 2)) }
            if (api !== groupApi) option.api = api
            if (baseUrl !== groupBaseUrl) option.baseUrl = baseUrl
            if (auth !== groupAuth) option.auth = auth
            if (model.reasoning === true) option.reasoning = true
            if (modalities.input.includes('image')) option.vision = true
            models.push(option)
        }
        if (models.length) groups.push({ id: providerId, name: provider.name || providerId, api: groupApi, baseUrl: groupBaseUrl, auth: groupAuth, models })
    }
    groups.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    return { status, updatedAt: cache ? cache.updatedAt : '', groups, omitted }
}
/** Force one boot refresh, retain last-good metadata, and own network/storage rejections.
 * @param {ProviderStorage} storage
 * @param {(catalog: ReturnType<typeof projectModelCatalog>) => void} publish
 */
export async function refreshModelCatalog(storage, publish) {
    let cache = null
    let cachedCatalog = projectModelCatalog(null, 'loading')
    try {
        const stored = await storage.getRegistryCache()
        cachedCatalog = projectModelCatalog(stored, 'loading')
        cache = stored
    } catch {}
    publish(cachedCatalog)
    try {
        const manager = planManager(storage)
        await manager.updateRegistry()
        publish(projectModelCatalog(await manager.getRegistry(), 'fresh'))
    } catch {
        publish({ ...cachedCatalog, status: cache ? 'stale' : 'unavailable' })
    }
}
export const openAICodexConnection = { api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api', catalogId: 'openai-codex' }
// Static catalog shipped by the installed Pi OpenAI Codex provider; an account may expose only a subset.
export const openAICodexModels = [
    { model: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', contextWindow: 128000, maxTokens: 128000, reasoning: true, vision: false },
    { model: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 272000, maxTokens: 128000, reasoning: true, vision: true },
    { model: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', contextWindow: 272000, maxTokens: 128000, reasoning: true, vision: true },
    { model: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', contextWindow: 272000, maxTokens: 128000, reasoning: true, vision: true },
    { model: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', contextWindow: 272000, maxTokens: 128000, reasoning: true, vision: true },
    { model: 'gpt-6-astra', name: 'GPT-6 Astra', contextWindow: 272000, maxTokens: 128000, reasoning: true, vision: true },
    { model: 'gpt-6-luna', name: 'GPT-6 Luna', contextWindow: 272000, maxTokens: 128000, reasoning: true, vision: true },
    { model: 'gpt-6-sol', name: 'GPT-6 Sol', contextWindow: 272000, maxTokens: 128000, reasoning: true, vision: true },
    { model: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', contextWindow: 272000, maxTokens: 128000, reasoning: true, vision: true },
]
export const providerDefaults = { name: 'My provider', api: 'openai-completions', baseUrl: '', model: '', auth: 'none', apiKey: '', contextWindow: 32768, maxTokens: 4096, providerId: '', catalogId: '', reasoning: false, vision: false, thinking: 'off' }
/** Public host-wide connections. Credentials never enter this projection.
 * @param {ProviderStorage} storage
 */
export async function listProviderConnections(storage) {
    const connections = []
    const manager = planManager(storage)
    const models = await manager.getModelsByUser('owner')
    for (const provider of await manager.getProvidersByUser('owner')) {
        const auth = provider.currentAuthId ? await manager.getProviderAuth(provider.currentAuthId) : null
        const model = models.find(item => item.providerId === provider.id)
        connections.push({ id: provider.id, name: provider.name || 'My provider', baseUrl: provider.baseUrl || '', api: provider.api || (model ? model.options.api : '') || 'openai-completions', catalogId: provider.catalogId || '', auth: auth ? auth.type : 'none', hasKey: !!(auth && auth.type === 'apiKey' && auth.data.key) })
    }
    return connections.sort((a, b) => a.name.localeCompare(b.name))
}
/** Create or edit a reusable connection, retaining a key only on the same origin.
 * @param {ProviderStorage} storage
 * @param {object} config
 */
export async function saveProviderConnection(storage, config) {
    if (typeof config.name !== 'string' || !config.name.trim() || config.name.length > 200) throw new Error('Enter a connection name of at most 200 characters.')
    if (!URL.canParse(config.baseUrl)) throw new Error('Enter a valid HTTP(S) endpoint.')
    const url = new URL(config.baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) endpoint without embedded credentials.')
    if (!['openai-completions', 'openai-responses', 'openai-codex-responses', 'anthropic-messages', 'google-generative-ai'].includes(config.api)) throw new Error('Unsupported API protocol.')
    if (!['none', 'apiKey', 'oauth'].includes(config.auth)) throw new Error('Choose no auth, an API key or OAuth.')
    const manager = planManager(storage)
    const prior = config.id ? await manager.getProviderConfig(config.id) : null
    if (config.id && (!prior || prior.userId !== 'owner')) throw new Error('Connection not found.')
    const auth = prior && prior.currentAuthId ? await manager.getProviderAuth(prior.currentAuthId) : null
    const retainKey = auth && auth.type === 'apiKey' && new URL(prior.baseUrl).origin === url.origin
    if (config.auth === 'apiKey' && !config.apiKey && !retainKey) throw new Error('Enter an API key for this endpoint. Keys are never reused across origins.')
    if (config.auth === 'oauth' && (!prior || prior.api !== 'openai-codex-responses' || config.api !== 'openai-codex-responses' || config.baseUrl !== openAICodexConnection.baseUrl || !auth || auth.type !== 'oauth')) throw new Error('Connect OpenAI Codex with ChatGPT sign-in instead.')
    const fields = { name: config.name.trim(), baseUrl: config.baseUrl, api: config.api, catalogId: typeof config.catalogId === 'string' ? config.catalogId : '', npm: config.api === 'openai-codex-responses' ? '@earendil-works/pi-ai/openai-codex' : config.api.startsWith('openai') ? '@ai-sdk/openai-compatible' : config.api === 'anthropic-messages' ? '@ai-sdk/anthropic' : '@ai-sdk/google' }
    // Prepare both records off-host; endpoint and credential become visible together.
    const prepared = new ProviderStorage({ providers: prior ? { [prior.id]: prior } : {}, auth: auth ? { [auth.id]: auth } : {} })
    const editor = planManager(prepared)
    const provider = prior || await editor.createProviderConfig('owner', fields)
    if (auth) {
        if (config.auth !== auth.type || config.apiKey) await editor.updateProviderAuth(auth.id, { type: config.auth, data: config.auth === 'none' ? {} : { key: config.apiKey } })
    } else if (config.auth === 'none') await editor.setProviderNoAuth(provider.id, 'owner')
    else if (config.auth === 'apiKey') await editor.setProviderApiKey(provider.id, 'owner', config.apiKey)
    await editor.updateProviderConfig(provider.id, fields)
    const changes = []
    for (const bucket of ['providers', 'auth']) {
        for (const value of Object.values(prepared.records[bucket])) changes.push({ bucket, id: value.id, value })
    }
    await storage.commit(changes)
    return { connectionId: provider.id, connections: await listProviderConnections(storage) }
}
/** Create the server record before Pi writes its OAuth credential into it. */
export async function createOpenAICodexConnection(storage, name = 'OpenAI Codex') {
    if (typeof name !== 'string' || !name.trim() || name.length > 200) throw new Error('Enter a connection name of at most 200 characters.')
    const manager = planManager(storage)
    const provider = await manager.createProviderConfig('owner', { name: name.trim(), ...openAICodexConnection, npm: '@earendil-works/pi-ai/openai-codex' })
    return provider.id
}
/** Delete a host-wide connection, its credentials/models and affected project selections atomically. */
export async function deleteProviderConnection(storage, connectionId) {
    const manager = planManager(storage)
    const provider = await manager.getProviderConfig(connectionId)
    if (!provider || provider.userId !== 'owner') throw new Error('Connection not found.')
    const changes = [], modelIds = new Set()
    const disconnectedProjectIds = []
    for (const project of Object.values(storage.records.projects || {})) {
        if (!project || project.currentProviderId !== connectionId) continue
        disconnectedProjectIds.push(project.id)
        if (project.defaultModelId) modelIds.add(project.defaultModelId)
        changes.push({ bucket: 'projects', id: project.id })
    }
    for (const project of Object.values(storage.records.userProjects || {})) {
        if (!project || project.currentProviderId !== connectionId) continue
        if (project.currentModelId) modelIds.add(project.currentModelId)
        changes.push({ bucket: 'userProjects', id: project.id })
    }
    for (const auth of await manager.getProviderAuthsByProviderConfig(connectionId)) changes.push({ bucket: 'auth', id: auth.id })
    for (const model of await storage.getModelConfigsByProvider(connectionId)) modelIds.add(model.id)
    for (const id of modelIds) changes.push({ bucket: 'models', id })
    if ((await storage.get('preferences', 'new-scene-provider'))?.selection.providerId === connectionId) changes.push({ bucket: 'preferences', id: 'new-scene-provider' })
    changes.push({ bucket: 'providers', id: connectionId })
    await storage.commit(changes)
    return { connections: await listProviderConnections(storage), disconnectedProjectIds }
}
/** Select a model for one project without replacing the host-wide connection or key.
 * @param {ProviderStorage} storage
 * @param {string} projectId
 * @param {object} config
 */
async function preparedProviderSelection(storage, config) {
    if (!config || typeof config !== 'object') throw new Error('Choose a provider and model.')
    if (typeof config.model !== 'string' || !config.model.trim() || config.model.length > 200) throw new Error('Enter an exact model ID of at most 200 characters.')
    const manager = planManager(storage)
    const provider = await manager.getProviderConfig(config.providerId)
    if (!provider || provider.userId !== 'owner') throw new Error('Choose a configured provider.')
    const api = config.api || provider.api || 'openai-completions'
    if (!['openai-completions', 'openai-responses', 'openai-codex-responses', 'anthropic-messages', 'google-generative-ai'].includes(api)) throw new Error('Unsupported API protocol.')
    if (api === 'openai-codex-responses' && (provider.api !== api || provider.baseUrl !== openAICodexConnection.baseUrl)) throw new Error('Invalid OpenAI Codex connection.')
    if (!Number.isInteger(Number(config.contextWindow)) || Number(config.contextWindow) < 8192 || Number(config.contextWindow) > 2000000) throw new Error('Context window must be 8192–2000000 tokens.')
    if (!Number.isInteger(Number(config.maxTokens)) || Number(config.maxTokens) < 256 || Number(config.maxTokens) > Number(config.contextWindow) / 2) throw new Error('Output budget must be at least 256 and at most half the context window.')
    const reasoning = config.reasoning === true
    const thinking = config.thinking || 'off'
    if (!getSupportedThinkingLevels({ reasoning }).includes(thinking)) throw new Error('Thinking level is unavailable for this model.')
    return { provider, fields: { providerId: provider.id, model: config.model, options: { api, reasoning, vision: config.vision === true, thinking, contextWindow: Number(config.contextWindow), maxTokens: Number(config.maxTokens) } } }
}
/** Creation-time default is a standalone value, never a shared project model record. */
export async function saveDefaultProvider(storage, config) {
    if (config === null) { await storage.commit([{ bucket: 'preferences', id: 'new-scene-provider' }]); return defaultProviderInfo(storage) }
    const { fields } = await preparedProviderSelection(storage, config)
    const selection = { providerId: fields.providerId, model: fields.model, ...fields.options }
    await storage.commit([{ bucket: 'preferences', id: 'new-scene-provider', value: { id: 'new-scene-provider', selection } }])
    return defaultProviderInfo(storage)
}
export async function defaultProviderInfo(storage) {
    const saved = await storage.get('preferences', 'new-scene-provider')
    if (!saved) return { ...providerDefaults, configured: false }
    const connection = (await listProviderConnections(storage)).find(item => item.id === saved.selection.providerId)
    if (!connection) return { ...providerDefaults, configured: false }
    const { fields } = await preparedProviderSelection(storage, saved.selection)
    return { ...providerDefaults, ...fields.options, providerId: fields.providerId, model: fields.model, name: connection.name, baseUrl: connection.baseUrl, auth: connection.auth, apiKey: '', configured: true }
}
export async function configureProvider(storage, projectId, config) {
    const manager = planManager(storage)
    const { provider, fields } = await preparedProviderSelection(storage, config)
    const prior = await storage.getProjectConfig(projectId)
    const previousModel = prior ? await manager.getModelConfig(prior.defaultModelId) : null
    const prepared = new ProviderStorage({ models: prior ? { [prior.defaultModelId]: previousModel } : {} })
    const editor = planManager(prepared)
    const model = prior ? await editor.updateModelConfig(prior.defaultModelId, fields) : await editor.createModelConfig('owner', fields)
    const now = new Date().toISOString()
    const project = { id: projectId, name: projectId, ownerId: 'owner', providerConfigAvailability: 'owner', currentProviderId: provider.id, defaultModelId: model.id, createdAt: prior ? prior.createdAt : now, updatedAt: now }
    await storage.commit([{ bucket: 'models', id: model.id, value: model }, { bucket: 'projects', id: projectId, value: project }])
    return providerInfo(storage, projectId)
}
/** Delete project model/selection records; reusable host connections and credentials remain. */
export async function deleteProjectProvider(storage, projectId) {
    const project = await storage.getProjectConfig(projectId)
    if (project) {
        const manager = planManager(storage)
        await manager.deleteModelConfig(project.defaultModelId)
        await manager.deleteUserProjectConfig(projectId, 'owner')
        await manager.deleteProject(projectId)
    }
}
/** Public configuration deliberately excludes ProviderAuth.data. */
export async function providerInfo(storage, projectId) {
    const project = await storage.getProjectConfig(projectId)
    if (!project) return { ...providerDefaults, configured: false }
    const settings = await planManager(storage).getSettings(projectId, 'owner')
    return { name: settings.providerName, baseUrl: settings.baseUrl, model: settings.model, api: settings.options.api, contextWindow: settings.options.contextWindow, maxTokens: settings.options.maxTokens, auth: settings.auth.type, apiKey: '', providerId: project.currentProviderId, reasoning: settings.options.reasoning === true, vision: settings.options.vision === true, thinking: settings.options.thinking || 'off', configured: true }
}
/** @param {any} settings
 * @param {string} [sessionId] Stable Pi conversation identity, including compaction/resume.
 */
export function piModel(settings, sessionId) {
    const model = { id: settings.model, name: settings.model, provider: 'blueed-provider', api: settings.options.api,
        baseUrl: settings.baseUrl, reasoning: settings.options.reasoning === true, input: settings.options.vision === true ? ['text', 'image'] : ['text'], contextWindow: settings.options.contextWindow,
        maxTokens: settings.options.maxTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
        headers: { 'User-Agent': 'Blueed/0.1.0' },
    }
    if (sessionId && new URL(settings.baseUrl).origin === 'https://opencode.ai') model.headers['x-opencode-session'] = sessionId
    return model
}
export const agentPrompt = `You are Blueed, a skilled Three.js scene artist. Build and edit the actual scene using the scene tools. Start with get_scene_tree's depth-2 overview; expand only needed branches by id/path. Organize new work into shallow groups with short, meaningful names; preserve existing hierarchy unless asked to reorganize. Use UUIDs, radians and native Three.js JSON. Explain your changes briefly. Work incrementally with coherent names and pleasing materials. Do not limit modeling to primitives: build real topology, holes, curved blades, extruded profiles and reusable assemblies. For complex work, read get_modeling_api first; it describes the actual shared modeling helpers, retained geometry parameters, outline glyphs, persistent controls/drivers, procedural PBR and authored studio cameras. Use named controllers and shared geometry/materials, respect units/axes, and verify topology and controls. For procedural ShaderMaterial animation independent of the timeline, use modeling.driveUniform(material,'uTime',{source:'elapsedTime',speed:1,offset:currentPhase}) from get_modeling_api. Bindings persist; renderer ticks never edit saved uniforms. capture_viewport/capture_multiview timeSeconds gives a transient deterministic shader-clock sample. Do not serialize callbacks or simulate elapsed time with repeated scene edits. For host-facing asset parts, inspect list_exposed_children and author set_exposed_child/remove_exposed_child. Exposures are stable asset-local aliases mapped to explicit existing object UUIDs in versioned root metadata, not object names, host child IDs or gameplay state. Rebind the same alias explicitly when replacing a part; deleting a target leaves an unavailable alias, while removing a mapping never deletes geometry. Subtree duplication does not create or hijack aliases. Do not serialize host components/session state or claim this authoring catalog alone provides live rendered bindings/transform authority. Worker helpers are documented by get_modeling_api. For user-facing scene/object inputs, inspect list_controls and use define_control/set_control/remove_control: number, boolean switch, select, color and text values persist as named variables, with declarative multi-property bindings. A light/dark select can map scene background, material colors and light intensities together. Scene-root controls are visible without selecting an object. Numeric controls alone are animatable; custom function/callback controls are not implemented. Never claim an unbound variable changes rendering automatically. Native BufferGeometry vertex/index editing is available; convert edited primitive geometry to BufferGeometry so native JSON saves the edits. Viewer camera/gizmos are host-only; authored cameras and lights belong to the document. JavaScript runs on a disposable copy with scene, THREE, modeling and source (script text); no imports, network or host APIs. execute_js commits scene edits; its script return value is not a query result. Use execute_js_return with an explicit return of JSON data for measurements/computations: copy mutations are discarded, no Undo or save changes. Convert vectors/matrices with toArray(). For animated trajectories, use sample_animation with clipId, ids and explicit frames: it evaluates keys/easing/controls/drivers and parent transforms in isolation, without moving the live timeline or clearing drafts. Derive camera-follow positions/orientations from evaluated samples, not guessed base positions. World matrices are authoritative under non-uniform/sheared parents; bounds are world-space. Query results are limited to256 KiB and sampling to256frames/64objects/1024object-frame pairs; request smaller batches on errors, never assume truncated output. Be honest about unsupported arbitrary-mesh bevel/CSG, external images, Blender filesystem/UI, NLA/full graph editing and Cycles parity. Native animation tools create persistent clips/keyframes with frame-based FPS/ranges and outgoing easing. Inspect get_animations/get_animation; set_keyframes animates object UUID channels, including control.explode/control.lid_open_degrees, camera transforms/fov/zoom, and unwrapped rotation axes in radians. For all animation authoring (characters, objects, cameras and controls), prefer sparse, editable tracks over baked samples. Key only the channels needed for the requested motion and its meaningful changes; do not automatically key every bone, every transform channel or every frame. Use outgoing easing on set_keyframes: linear, hold, ease-in, ease-out, ease-in-out, or cubic Bezier [x1,y1,x2,y2] with all four values in [0,1]. Choose easing to match the intended timing; do not approximate an available easing curve with many intermediate keys. These curves shape interpolation over time, not arbitrary spatial paths or unrestricted tangents. Start with a small set of significant keys, inspect intermediate poses with sample_animation and captures, then add keys only where needed to correct the evaluated result. Use capture_contact_sheet to inspect 2–12 explicit frames or a sampled clip range in one labeled image, including intermediate poses; auto mode follows the evaluated shot cameras, while cameraMode:viewport compares motion from a fixed view. It does not move the live timeline or clear camera drafts. Use set_motion_paths with clipId and selected object/bone UUIDs to inspect evaluated world-space trajectories, parent motion and oscillations; these are transient x-ray annotations, not editable splines or IK. get_motion_paths reports samples and omitted key-marker counts. Include them in capture_contact_sheet with motionPaths:true for the same target viewport, or motionPaths:{ids,start,end,samples,keyframes} for explicit paths; each cell shows the common trajectory and its current position. A fixed viewport camera helps distinguish subject oscillations from camera motion. Marker labels are sampled frames, not all authored keys; do not infer an unobserved oscillation is absent at coarse density. Choose or refine sample frames yourself; do not invent automatic motion-phase detection. Verification samples are not authored keys: do not turn sampled frames into a baked track by default. Avoid redundant keys and unchanged channels, while retaining keys needed for holds, timing and motion fidelity. Before generating dense tracks, estimate their total key count and justify the density; per-frame baking requires an explicit user request or a verified technical need, not merely a convenient generation loop. Tool limits are safety ceilings, not target key counts. Inspect get_animations after authoring and report the resulting track/key counts briefly. Do not simplify or replace existing dense animation without authorization and verification that the intended motion is preserved. For multi-shot sequences, call set_camera_cuts with frame/cameraId keys; creating several cameras or animating their poses alone does not switch the active shot. Cuts are hold-only and share the clip timeline; use Shots / Follow camera cuts to watch them. set_viewport_grid hides or shows the reference grid in one viewport without scene edits. set_viewport_filters controls viewport-only geometry and helper overlays; hiding light icons never disables scene lighting. set_viewport_frame sets a camera/shot aspect ratio and gray outside-frame mask without authoring lens changes. list_reference_images lists this scene's uploaded references from chat or viewport; use the exact imageId with set_viewport_comparison, never invent an ID or URL. Comparison supports blend opacity, movable wipe, slices and difference in independently targeted user/agent views. capture_viewport includes that comparison and frame mask by default; set overlay:false for the render alone. capture_multiview is a clean four-view geometry inspection, not the reference comparison. When recreating a reference image, proactively use list_reference_images and set_viewport_comparison (blend, opacity:0.5) in the agent viewport to align camera, silhouette and proportions before details. Iterate from actual comparison captures; verify the render alone with capture_viewport overlay:false. Never claim a match from metadata alone. Animate the driving control instead of a derived transform. Key edits are undoable; preview time/playback is transient. Use set_animation_time to seek deterministically, then capture_viewport (optionally cameraId for the authored camera) to verify actual poses. play_animation requires a loaded editor clock. Never claim rendered animation/video export without producing it. Use tools for requested changes, never claim changes you have not made. Scene changes are undoable. View tools default to your private agent viewport. use_camera changes saved scene presentation, not your private navigation camera. For an authored camera, capture_viewport with cameraId selects that same read-only camera in Agent view and produces its image; frame_object/look_at/orbit_viewport control private navigation. Agent view distinguishes Live from Last capture (the exact most recent single/four-view or user-target image); chat tool results expose the original image. Do not claim the live viewport moved merely because a query sampled a camera or because capture_multiview rendered temporary fitted views. Explicitly set target:user to inspect or control the user's viewport when useful. Use frame_object to fit an object/group by UUID before inspecting it; get_viewport reports bounds, hidden ancestors and frustum intersection. Shading and isolation are viewport-only, not material/scene edits. Use capture_multiview for ONE labeled four-view image, or capture_viewport for the current camera/shading, when the selected model supports image input. Default maxSide 1024 is sufficient for routine inspection; higher resolutions up to 4096 are ONLY for exceptional fine-detail checks and consume more image tokens. Capture requires a loaded browser editor; never invent a screenshot or claim visual inspection without an image. Text-only models cannot use this tool. For motion that arrives from an external producer, use get_motion_target to describe the native rig, prepare_motion_candidate to build an isolated candidate, get_motion_candidate/preview_motion_candidate to read compact diagnostics and isolated poses, and apply_motion_candidate to author ONE native editable clip with ONE Undo entry. When the live host exposes generate_text_motion, use its shared local FlowMDM/CLIP service for text requests. State the prompt, unsigned seed, exact20FPS sample-count duration (2–196samples/0.1–9.8s), steps and selected q8(default) or fp16 encoder. Adapt the user's intent to a short body-action prompt, not a promised perfect prompt. Inspect its returned candidateId with the existing motion tools and apply explicitly as a new clip by default, then inspect native playback/contact sheets. No fingers, facial expression, recovered axial twist, contact solver or arbitrary-length composition is generated. The host backend is explicit; never claim qualified WebGPU hardware or silently switch backend/precision. Preparation/retention/offline flags never grant permission: when refused, ask the user to prepare via the Text panel or the trusted external host. Never try a tool consent argument or override a refusal, including for resident models. Hosts without the capability are honestly unavailable. When process_video_source is available, it processes only an already host-authorized local opaque sourceId through F5. Model preparation, local-media analysis and agent-derived movement permissions are distinct; tool input never grants any of them. No agent webcam acquisition tool exists; never fabricate a source or claim inference ran. Application refuses stale candidates (any commit since preparation, including edit-then-Undo) and unacknowledged data-loss diagnostics: re-prepare instead of overwriting, and state which channels were unsupported. Candidate previews are structure/budget diagnostics, not motion-quality or retargeting proof, and the three character presets have no facial morph slots, so face channels stay unavailable rather than inventing deformation. For the shared animation-authoring cycle use agent_motion_inspect first. Use the configured generate_text_motion or process_video_source, or prepare_motion_candidate for an explicit direct source. Use agent_motion_sample with BOTH explicit keys and non-key intermediate frames; classify them from native keys, not guesses. agent_motion_evidence may capture the unapplied native candidate via existing contact-sheet/motion-path authorities only when the host declares image capability; a text-only model simply receives the numeric reply. Otherwise state exactly: "No image capability: numeric evidence only; no image was captured or visually inspected." Never claim to see an unavailable image. agent_motion_refine supports ONLY measured key-reduction with explicit tolerance/maxKeysPerTrack/requestId; every iteration preserves the source and returns a new candidate with parent lineage, before/after counts and measured maximum deviation. At most 8 iterations; no unlimited autonomous loop. Gait/contact detection, smoothing, IK and morph reduction are unavailable. Sparse sheets do not certify continuous foot contact or artistic quality. agent_motion_compare uses the SAME explicit keys and intermediate frames before/after. Apply ONLY when explicitly authorized, using agent_motion_apply with requestId and explicit new-clip or replace mode; no apply during inspection/refinement. All sources remain native/manual editable with one Undo and unchanged revision/ABA guards. Agent text generation requires separate trusted host permission; model preparation alone is not consent. Never request credentials in chat.`
/** @param {any} registry
 * @param {any[]} definitions
 * @param {(imageId: string, signal?: AbortSignal) => Promise<{data: string, mimeType: string}>} [loadImage]
 */
export function piTools(registry, definitions, loadImage) {
    return definitions.map(tool => ({ name: tool.name, label: tool.name.replaceAll('_', ' '), description: tool.description,
        parameters: tool.parameters, executionMode: 'sequential',
        execute: async (_id, input, signal) => {
            const producesImage = tool.name === 'capture_viewport' || tool.name === 'capture_multiview' || tool.name === 'capture_contact_sheet'
            if (producesImage && !loadImage) throw new Error('The selected model does not support image input. Choose an image-capable model or enable image input for a supported custom model.')
            const result = await registry.dispatch(tool.name, tool.name === 'agent_motion_evidence' && !loadImage ? { ...input, numericOnly: true } : input, signal)
            if (tool.name === 'agent_motion_evidence' && result.artifact && loadImage) {
                const image = await loadImage(result.artifact.imageId, signal)
                if (signal && signal.aborted) throw new Error('Candidate evidence cancelled.')
                return { content: [{ type: 'text', text: JSON.stringify(result) }, { type: 'image', data: image.data, mimeType: image.mimeType, imageId: result.artifact.imageId }], details: result }
            }
            if (producesImage) {
                const image = await loadImage(result.imageId, signal)
                if (signal && signal.aborted) throw new Error('Capture cancelled.')
                return { content: [{ type: 'text', text: JSON.stringify(result) }, { type: 'image', data: image.data, mimeType: 'image/jpeg', imageId: result.imageId }], details: result }
            }
            return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }
        },
    }))
}
