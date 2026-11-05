import { extend } from 'rpcable'
import { watch, collectEffects, globals } from 'tinybubble'
import { clientSession } from '../rpc/session.js'
import { travel } from '../services/travel.js'
import { renderAssistantMarkdown } from './renderAssistantMarkdown.js'
import '../provider.css'

const TRIP_SUGGESTIONS = [
    'Shape this itinerary into a realistic day-by-day plan.',
    'Which days are still empty? Add what is missing.',
    'Find the best way to get around between my stops.',
]
const WORKSPACE_SUGGESTIONS = [
    'Plan a five-day trip in Sicily this June.',
    'Which trip still needs dates or flights?',
    'Create a trip to Japan in October with three stops.',
]
const PROTOCOLS = [
    ['openai-completions', 'OpenAI-compatible Chat Completions'],
    ['openai-responses', 'OpenAI Responses'],
    ['openai-codex-responses', 'OpenAI Codex Responses (ChatGPT account)'],
    ['anthropic-messages', 'Anthropic Messages'],
    ['google-generative-ai', 'Google Generative AI'],
]
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high']
const emptyModel = () => ({ model: '', api: '', contextWindow: 32768, maxTokens: 4096, reasoning: false, vision: false, thinking: 'off' })
const emptyConnection = () => ({ id: '', name: '', api: 'openai-completions', baseUrl: '', auth: 'apiKey', apiKey: '', catalogId: '', hasKey: false })
const originOf = value => { try { return new URL(value).origin } catch { return '' } }

/** Travel planner assistant. One panel, two scopes: a trip, or the whole workspace (`scope: 'workspace'`). */
export default {
    name: 'AssistantPanel', props: ['scope'],
    data() {
        return {
            prompt: '', messages: [], streaming: '', busy: false, activity: '', error: '', status: '',
            providerReady: false, inherited: false, selection: null,
            providers: [], catalog: { status: 'loading', updatedAt: '', groups: [], omitted: 0 },
            settingsOpen: false, saving: false, savingModel: false, catalogBusy: false, quickModel: '', quickConnectionId: '', codexLoggingIn: false, codexLoginUrl: '', codexLinkCopied: false, codexCancelling: false,
            editing: emptyConnection(), catalogSelection: 'custom', modelSelection: 'custom', modelDraft: emptyModel(),
        }
    },
    template() { return /*html*/`
    <aside class="assistant-panel panel" aria-label="Travel planner assistant"><header class="assistant-header"><div><span class="assistant-spark">✦</span><span class="eyebrow">TRAVELMORE</span><h2>{{ scopeTitle() }}</h2></div><button type="button" class="round-button" @click="openSettings" aria-label="Configure AI provider">⚙</button></header><div class="assistant-context"><span class="status-led" :class="{ online: online() }"></span><span>{{ contextLabel() }}</span></div><div class="chat-stream" aria-live="polite"><div x-if="!messages.length && !busy" class="assistant-blank"><span>✧</span><h3>{{ workspace() ? 'Your travel library' : 'Where to next?' }}</h3><p>{{ workspace() ? 'I can read every trip in your library — dates, stops, open todos and saved flights. Ask me to compare them, or to start a new one.' : 'Ask for route ideas, research, a packing checklist or help organizing this trip.' }}</p><button x-for="suggestion in suggestions()" :key="suggestion" type="button" @click="suggest(suggestion)">{{ suggestion }} <b>↗</b></button></div><article x-for="message in messages" :key="message.id" class="chat-bubble" :class="message.role + (message.status ? ' status' : '')"><span>{{ messageLabel(message) }}</span><div x-if="message.role === 'assistant' && !message.status" class="chat-markdown" x-html="renderMarkdown(message.text)"></div><p x-if="message.role === 'user' || message.status">{{ message.text }}</p></article><article x-if="streaming" class="chat-bubble assistant streaming"><span>PLANNER · WRITING</span><div class="chat-markdown" x-html="renderMarkdown(streaming)"></div></article><article x-if="busy && activity" class="chat-activity"><span class="loading-dot"></span>{{ activity }}</article><p x-if="error" class="panel-error" role="alert">{{ error }}</p></div><div x-if="providers.length" class="assistant-model-bar"><span class="assistant-model-label">{{ modelLabel() }}</span><select ref="quickSelect" :value="quickModel" @change="changeQuickModel" aria-label="AI model" :disabled="busy"><option value="">Choose a model…</option><option value="__settings">Custom model… (open settings)</option><option x-if="quickModel && !quickOptions().some(item => item.model === quickModel)" :value="quickModel">{{ quickModel }} · saved</option><option x-for="option in quickOptions()" :key="option.model" :value="option.model">{{ option.name }}{{ option.reasoning ? ' · Thinking' : '' }}{{ option.vision ? ' · Vision' : '' }}</option></select></div><form class="assistant-composer" @submit-prevent="send"><textarea ref="composer" x-model="prompt" :disabled="!ready() || busy || !online()" rows="3" aria-label="Message travel planner" placeholder="Ask for thoughtful travel help…" @keydown="keySubmit($event)"></textarea><div><span>{{ statusHint() }}</span><button x-if="!busy" class="send-button" type="submit" :disabled="!ready() || !prompt.trim() || !online()" aria-label="Send message">↑</button><button x-if="busy" class="stop-button" type="button" @click="cancel" aria-label="Stop planning">■</button></div></form>
    <div x-if="settingsOpen" class="sheet-backdrop" @click.self="closeSettings"><section class="provider-sheet" role="dialog" aria-modal="true" aria-label="AI provider connections"><header class="provider-head"><div><span class="eyebrow">AI CONNECTIONS</span><h2>Provider manager</h2><p class="provider-sub">{{ scopeIntro() }}</p></div><button type="button" class="round-button" @click="closeSettings" aria-label="Close provider manager">×</button></header>
        <div class="provider-layout">
            <div class="provider-list">
                <div class="provider-list-head"><span class="field-label">Connections</span><span class="provider-count">{{ providers.length }}</span></div>
                <div x-for="item in providers" :key="item.id" class="provider-choice" :class="{ active: editing.id === item.id }"><button type="button" class="provider-choice-main" @click="editConnection(item.id)"><strong>{{ item.name }}</strong><small>{{ authLabel(item) }}</small></button><button type="button" class="provider-delete" @click="removeConnection(item.id)" :aria-label="'Delete ' + item.name" :title="'Delete ' + item.name">×</button></div>
                <p x-if="!providers.length" class="provider-empty">No connection yet.</p>
                <button type="button" class="provider-add" @click="newConnection">＋ Add connection</button>
                <section class="provider-codex" aria-label="ChatGPT account"><span class="field-label">ChatGPT account</span><p class="provider-hint">Sign in with your ChatGPT plan instead of an API key. Tokens stay on this server.</p><button x-if="!codexLoggingIn" type="button" class="button-secondary provider-codex-start" @click="connectOpenAICodex" :disabled="saving || savingModel">Sign in with ChatGPT</button><p x-if="codexLoggingIn" class="catalog-status" role="status">{{ codexCancelling ? 'Cancelling sign-in…' : codexLoginUrl ? 'Link ready — waiting for your sign-in.' : 'Preparing the sign-in link…' }}</p><div x-if="codexLoginUrl" class="provider-codex-actions"><button type="button" class="button-primary" @click="openCodexPopup">Open sign-in page</button><button type="button" class="button-secondary" @click="copyCodexLoginLink">{{ codexLinkCopied ? 'Link copied' : 'Copy link' }}</button></div><button x-if="codexLoggingIn" type="button" class="text-danger provider-codex-cancel" :disabled="codexCancelling" @click="cancelOpenAICodexLogin">Cancel sign-in</button></section>
                <div class="provider-scope"><span class="field-label">Model for {{ workspace() ? 'the workspace' : 'this trip' }}</span><p class="provider-hint">{{ connectionLabel() }}</p><button x-if="!workspace() && selection && selection.configured && !inherited" type="button" class="text-danger" @click="clearOverride">Use the shared model again</button></div>
                <div class="provider-scope"><span class="field-label">Model catalogue</span><p class="catalog-status" role="status">{{ catalogStatus() }}</p><button x-if="catalog.status !== 'fresh'" type="button" class="button-secondary provider-retry" @click="refreshCatalog" :disabled="catalogBusy">{{ catalogBusy ? 'Refreshing…' : 'Retry catalogue' }}</button></div>
            </div>
            <form class="provider-form" @submit-prevent="saveConnection">
                <h3>{{ editing.id ? 'Edit connection' : 'New connection' }}</h3>
                <label>Provider<select ref="presetSelect" :value="catalogSelection" @change="selectPreset" aria-label="Connection provider"><option value="custom">Custom / local endpoint</option><option x-if="editing.api === 'openai-codex-responses'" value="openai-codex">OpenAI Codex (ChatGPT account)</option><option x-for="group in presetGroups()" :key="group.id" :value="group.id">{{ group.name }}</option></select></label>
                <div class="provider-grid"><label>Connection name<input x-model="editing.name" required placeholder="My provider" aria-label="Connection name" /></label><label>Authentication<select x-model="editing.auth" aria-label="Authentication"><option value="none">No authentication (local endpoint)</option><option value="apiKey">API key</option><option x-if="editing.api === 'openai-codex-responses'" value="oauth">ChatGPT sign-in (managed)</option></select></label></div>
                <label x-if="editing.auth === 'oauth'">Credential<p class="provider-hint">{{ editing.id ? 'Signed in with ChatGPT. Tokens are refreshed on the server.' : 'Save first, then sign in from the ChatGPT account box.' }}</p></label><label x-if="editing.auth === 'apiKey'">{{ editing.hasKey ? 'API key · leave blank to keep the stored key' : 'API key' }}<input type="password" autocomplete="off" x-model="editing.apiKey" :required="!editing.hasKey" placeholder="Stored on this server" aria-label="Provider API key" /></label>
                <div class="provider-grid"><label>Base URL<input x-model="editing.baseUrl" required placeholder="http://localhost:8080/v1" aria-label="Provider endpoint" /></label><label>API protocol<select x-model="editing.api" aria-label="API protocol"><option x-for="protocol in protocolOptions()" :key="protocol[0]" :value="protocol[0]">{{ protocol[1] }}</option></select></label></div>
                <p x-if="status" class="provider-ok" role="status">{{ status }}</p>
                <p x-if="error" class="provider-error" role="alert">{{ error }}</p>
                <div class="provider-form-actions"><button type="submit" class="button-primary" :disabled="saving || !editing.name.trim() || !editing.baseUrl.trim()">{{ saving ? 'Saving…' : 'Save connection' }}</button></div>
                <section x-if="editing.id" class="provider-model">
                    <h4>Model for {{ workspace() ? 'the workspace' : 'this trip' }}</h4>
                    <label>Model<select ref="modelSelect" :value="modelSelection" @change="chooseModel" aria-label="Model"><option value="custom">Custom model…</option><option x-if="modelDraft.model && !connectionModels().some(item => item.model === modelDraft.model)" :value="modelDraft.model">{{ modelDraft.model }} · saved</option><option x-for="option in connectionModels()" :key="option.model" :value="option.model">{{ option.name }}{{ option.reasoning ? ' · Thinking' : '' }}{{ option.vision ? ' · Vision' : '' }}</option></select></label>
                    <div x-if="modelSelection === 'custom'" class="provider-custom"><label>Exact model ID<input x-model="modelDraft.model" placeholder="Model ID served by your endpoint" aria-label="Custom model ID" /></label><label class="provider-check"><input type="checkbox" :checked="modelDraft.reasoning" @change="toggleReasoning" />This model supports thinking</label><label class="provider-check"><input type="checkbox" :checked="modelDraft.vision" @change="toggleVision" />This model supports image input</label></div>
                    <label x-if="modelDraft.reasoning">Thinking<select x-model="modelDraft.thinking" aria-label="Thinking level"><option x-for="level in thinkingLevels()" :key="level" :value="level">{{ levelLabel(level) }}</option></select></label>
                    <div class="model-grid"><label>Context tokens<input type="number" min="8192" max="2000000" x-model="modelDraft.contextWindow" aria-label="Context token budget" /></label><label>Output tokens<input type="number" min="256" x-model="modelDraft.maxTokens" aria-label="Output token budget" /></label></div>
                    <div class="provider-form-actions"><button type="button" class="button-primary" @click="applyModel" :disabled="savingModel || !modelDraft.model.trim()">{{ savingModel ? 'Applying…' : 'Use this model' }}</button><span x-if="modelInfo()" class="provider-hint">{{ modelInfo() }}</span></div>
                </section>
            </form>
        </div>
    </section></div></aside>` },
    async mounted() {
        this.alive = true; this.chatEpoch = 0; this.codexEpoch = 0; this.codexLoginId = ''
        this.chatUpdated = payload => { if (this.eventScope(payload) === this.props.scope) this.mergeChat(payload) }
        this.agentEvent = payload => { if (this.eventScope(payload) === this.props.scope) this.applyAgent(payload) }
        this.providerLogin = payload => { if (payload?.provider === 'openai-codex' && payload.state) this.applyCodexLogin(payload.state) }
        extend(clientSession, { chatUpdated: this.chatUpdated, agentEvent: this.agentEvent, providerLoginEvent: this.providerLogin })
        this.disposers = collectEffects(() => { watch(globals.$rpcStatus, status => { if (status === 'online') { void this.loadProviders(); void this.loadChat() } }); watch(() => this.props.scope, () => { this.resetScopeState(); void this.loadProviders(); void this.loadChat() }) })
        if (this.online()) { await this.loadProviders(); await this.loadChat() }
    },
    beforeDestroy() { this.alive = false; clearTimeout(this.catalogTimer); this.disposers?.forEach(dispose => dispose()); if (clientSession.chatUpdated === this.chatUpdated) delete clientSession.chatUpdated; if (clientSession.agentEvent === this.agentEvent) delete clientSession.agentEvent },
    online() { return globals.$rpcStatus.value === 'online' },
    workspace() { return this.props.scope === 'workspace' },
    ready() { return !!this.props.scope && this.data.providerReady.value },
    eventScope(payload) { return payload?.scope ?? payload?.tripId ?? '' },
    scopeTitle() { return this.workspace() ? 'Across your trips.' : 'Plan with intent.' },
    scopeIntro() { return this.workspace() ? 'A workspace connection is shared by every trip. Keys stay on this server.' : 'This trip inherits the workspace connection unless you pick a different model here.' },
    suggestions() { return this.workspace() ? WORKSPACE_SUGGESTIONS : TRIP_SUGGESTIONS },
    protocolOptions() { return PROTOCOLS },
    statusHint() {
        if (this.data.busy.value) return 'Working with your plan…'
        if (!this.data.providerReady.value) return 'Configure a provider to begin'
        return this.workspace() ? 'Can read and update every trip' : 'Tools can update your real itinerary'
    },
    contextLabel() {
        if (!this.props.scope) return 'No scope selected'
        if (!this.online()) return 'Reconnecting…'
        if (!this.data.providerReady.value) return 'Configure an AI provider'
        if (this.workspace()) return 'Shared provider · every trip'
        return this.data.inherited.value ? 'Using the shared AI provider' : 'AI provider ready for this trip'
    },
    resetScopeState() { this.chatEpoch++; this.providerEpoch = (this.providerEpoch || 0) + 1; this.applySelection(null); this.data.messages.value = []; this.data.streaming.value = ''; this.data.activity.value = ''; this.data.error.value = ''; this.data.status.value = ''; this.data.busy.value = false; this.data.providers.value = []; this.newConnection() },

    // ---- chat -------------------------------------------------------------------------------
    async loadChat() { const scope = this.props.scope; if (!scope || !this.online()) { this.data.messages.value = []; this.data.streaming.value = ''; return } const epoch = ++this.chatEpoch; try { const chat = await travel.getChat(scope); if (this.alive && epoch === this.chatEpoch && this.props.scope === scope) this.replaceChat(chat) } catch (error) { if (this.alive && this.props.scope === scope) this.data.error.value = error.message } },
    normalizeEntry(entry) { return { id: entry.id, role: entry.role === 'user' ? 'user' : 'assistant', status: entry.meta?.state || '', text: entry.text || '' } },
    applyState(state = {}) { this.data.busy.value = state.state === 'running' || state.running === true || state.busy === true; if (state.error) this.data.error.value = state.error },
    replaceChat(chat) { this.applyState(chat.state); this.data.messages.value = (chat.entries || []).filter(entry => entry.role !== 'tool').map(entry => this.normalizeEntry(entry)).filter(item => item.text) },
    mergeChat(payload) { this.applyState(payload.state); const merged = new Map(this.data.messages.value.map(item => [item.id, item])); for (const entry of payload.entries || []) if (entry.role !== 'tool' && entry.text) merged.set(entry.id, this.normalizeEntry(entry)); this.data.messages.value = [...merged.values()]; if (!this.data.busy.value) this.data.streaming.value = '' },
    messageLabel(message) { return message.role === 'user' ? 'YOU' : message.status ? `PLANNER · ${message.status}` : 'PLANNER' },
    renderMarkdown(text) { return renderAssistantMarkdown(text) },
    /** v2 is a server-side projection: raw Pi events never reach this UI. */
    applyAgent(payload) {
        if (payload.version !== 2 || !payload.state) return
        const state = payload.state
        this.data.busy.value = state.busy === true
        this.data.streaming.value = state.streaming || ''
        this.data.activity.value = state.activity || ''
        this.data.error.value = state.error || ''
        if (!state.busy && !state.streaming) void this.loadChat()
    },
    suggest(text) { this.data.prompt.value = text; this.refs.composer?.focus() },
    keySubmit(event) { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void this.send() } },
    async send() { const text = this.data.prompt.value.trim(); if (!text || !this.props.scope || !this.data.providerReady.value || this.data.busy.value || !this.online()) return; this.data.error.value = ''; this.data.prompt.value = ''; try { await travel.startChat({ scope: this.props.scope, text }); await this.loadChat() } catch (error) { this.data.error.value = error.message } },
    async cancel() { if (!this.props.scope) return; try { await travel.cancelChat(this.props.scope) } catch (error) { this.data.error.value = error.message } },

    // ---- providers --------------------------------------------------------------------------
    applySelection(info) {
        this.data.selection.value = info || null
        this.data.providerReady.value = !!info?.configured
        this.data.inherited.value = info?.inherited === true
    },
    async loadProviders() {
        const scope = this.props.scope
        if (!this.online()) return
        const epoch = this.providerEpoch = (this.providerEpoch || 0) + 1
        try {
            const listed = await travel.listProviderConnections()
            if (!this.alive || epoch !== this.providerEpoch || this.props.scope !== scope) return
            this.data.providers.value = listed.connections || []
            if (!scope) return
            const info = await travel.getProvider(scope)
            if (!this.alive || epoch !== this.providerEpoch || this.props.scope !== scope) return
            this.applySelection(info)
            // Show the effective connection in the editor without stealing focus from user input.
            // Seed the editor from the effective selection once per sheet open, never over mid-edit input.
            if (!this.autoSeeded && info?.configured && info.providerId) { this.autoSeeded = true; this.editConnection(info.providerId) }
            this.syncQuick()
        } catch (error) { if (this.alive && epoch === this.providerEpoch && this.props.scope === scope) this.data.error.value = error.message }
    },
    async loadCatalog() {
        try {
            const catalog = await travel.getModelCatalog()
            if (!this.alive) return
            this.data.catalog.value = catalog
            if (catalog.status === 'loading') this.pollCatalog()
            this.syncSelects()
        } catch (error) { if (this.alive) this.data.error.value = error.message }
    },
    /** models.dev metadata arrives after the first paint; poll while the server still says `loading`. */
    pollCatalog() {
        clearTimeout(this.catalogTimer)
        let attempts = 0
        const tick = async () => {
            if (!this.alive || attempts++ >= 10 || this.data.catalog.value.status !== 'loading') return
            try { this.data.catalog.value = await travel.getModelCatalog() } catch { /* keep the last-good cache */ }
            this.catalogTimer = setTimeout(tick, 3000)
        }
        this.catalogTimer = setTimeout(tick, 2500)
    },
    async refreshCatalog() {
        this.data.catalogBusy.value = true; this.data.error.value = ''
        try { const catalog = await travel.refreshModelCatalog(); this.data.catalog.value = catalog; if (catalog.status === 'loading') this.pollCatalog() }
        catch (error) { this.data.error.value = error.message }
        finally { if (this.alive) this.data.catalogBusy.value = false }
    },
    catalogGroups() { return this.data.catalog.value.groups || [] },
    /** The Codex group is a sign-in, not a form: it never appears as a preset. */
    presetGroups() { return this.catalogGroups().filter(group => group.auth !== 'oauth') },
    catalogStatus() {
        const catalog = this.data.catalog.value, when = catalog.updatedAt ? ` Last downloaded: ${new Date(catalog.updatedAt).toLocaleString()}.` : ''
        if (catalog.status === 'loading') return `Refreshing models.dev… ${catalog.groups.length ? 'Showing the last-good cache.' : 'Custom endpoints and model IDs remain available.'}${when}`
        if (catalog.status === 'stale') return `Refresh failed. Showing the last-good cache; custom settings remain available.${when}`
        if (catalog.status === 'unavailable') return 'Catalogue unavailable. Enter a custom endpoint and model ID.'
        return `models.dev catalogue ready.${when} ${catalog.omitted} unsupported models omitted.`
    },
    connectionModels() {
        const editing = this.data.editing.value, group = this.catalogGroups().find(item => item.id === editing.catalogId)
        if (!group) return []
        // Group defaults belong to the catalogue entry, not to a reused connection's old endpoint.
        return group.models.filter(item => !item.baseUrl || item.baseUrl === editing.baseUrl).map(item => ({ ...item, api: item.api || group.api }))
    },
    authLabel(connection) { if (connection.auth === 'oauth') return 'ChatGPT sign-in'; return connection.auth === 'apiKey' ? (connection.hasKey ? 'API key stored' : 'API key missing') : 'No authentication' },
    connectionLabel() {
        const selection = this.data.selection.value
        if (!this.data.providers.value.length) return 'No connection yet. Add one, then pick a model.'
        if (!this.data.providerReady.value) return 'No model selected for this scope yet.'
        const name = [selection?.name, selection?.model].filter(Boolean).join(' · ')
        if (this.workspace()) return `In use: ${name}.`
        return this.data.inherited.value ? `Inherited from the workspace: ${name}.` : `This trip overrides the workspace: ${name}.`
    },
    modelInfo() {
        const selection = this.data.selection.value, editing = this.data.editing.value
        if (!selection?.configured || selection.providerId !== editing.id) return ''
        return `${selection.model} · ${selection.contextWindow} ctx · ${selection.maxTokens} out${selection.thinking && selection.thinking !== 'off' ? ` · ${selection.thinking}` : ''}`
    },
    /** Regression guard: <option>s are inserted after the <select> binding runs, so reapply the value next frame. */
    /** `<option>`s render after the binding: reapply until the wanted value actually exists.
     * Timers, not rAF: the browser pauses animation frames in a hidden tab, which would leave the
     * selects showing the first option while the stored selection is correct. */
    syncSelects(attempt = 0) {
        const root = this.$element || document
        const preset = root.querySelector('select[aria-label="Connection provider"]'), model = root.querySelector('select[aria-label="Model"]')
        const wantedPreset = this.data.catalogSelection.value, wantedModel = this.data.modelSelection.value
        const has = (select, value) => !!select && [...select.options].some(option => option.value === value)
        const presetReady = !preset || has(preset, wantedPreset), modelReady = !model || has(model, wantedModel)
        if (presetReady && preset && preset.value !== wantedPreset) preset.value = wantedPreset
        if (modelReady && model && model.value !== wantedModel) model.value = wantedModel
        if ((!presetReady || !modelReady) && attempt < 20) setTimeout(() => this.syncSelects(attempt + 1), 30)
    },
    newConnection() {
        this.data.editing.value = emptyConnection()
        this.data.catalogSelection.value = 'custom'
        this.data.modelSelection.value = 'custom'
        this.data.modelDraft.value = emptyModel()
        this.data.status.value = ''
        this.data.error.value = ''
        this.syncSelects()
    },
    editConnection(id) {
        const connection = this.data.providers.value.find(item => item.id === id)
        if (!connection) return
        this.data.editing.value = { id: connection.id, name: connection.name, api: connection.api, baseUrl: connection.baseUrl, auth: connection.auth === 'oauth' ? 'oauth' : connection.auth === 'none' ? 'none' : 'apiKey', catalogId: connection.catalogId || '', apiKey: '', hasKey: connection.hasKey }
        this.data.catalogSelection.value = connection.catalogId || 'custom'
        const selection = this.data.selection.value
        if (selection?.configured && selection.providerId === id) {
            this.data.modelSelection.value = selection.model
            this.data.modelDraft.value = { model: selection.model, api: selection.api, contextWindow: selection.contextWindow, maxTokens: selection.maxTokens, reasoning: selection.reasoning, vision: selection.vision, thinking: selection.thinking }
        } else {
            const first = this.connectionModels()[0]
            this.data.modelSelection.value = first ? first.model : 'custom'
            this.data.modelDraft.value = first
                ? { model: first.model, api: first.api, contextWindow: first.contextWindow, maxTokens: first.maxTokens, reasoning: !!first.reasoning, vision: !!first.vision, thinking: 'off' }
                : { ...emptyModel(), api: connection.api }
        }
        this.data.status.value = ''
        this.data.error.value = ''
        this.syncSelects()
    },
    selectPreset(value) {
        const id = typeof value === 'string' ? value : ''
        this.data.catalogSelection.value = id
        const editing = this.data.editing.value, group = this.catalogGroups().find(item => item.id === id)
        if (!group) { this.data.editing.value = { ...editing, catalogId: '' }; return }
        // ChatGPT is a sign-in: its preset only labels the connection, it never rewrites the form.
        if (group.auth === 'oauth') return
        const sameOrigin = originOf(editing.baseUrl) === originOf(group.baseUrl)
        this.data.editing.value = {
            ...editing,
            catalogId: group.id,
            name: editing.id && editing.name ? editing.name : group.name,
            api: group.api,
            baseUrl: group.baseUrl,
            auth: group.auth === 'none' ? 'none' : 'apiKey',
            apiKey: sameOrigin ? editing.apiKey : '',
            hasKey: sameOrigin ? editing.hasKey : false,
        }
        const first = this.connectionModels()[0]
        if (first) {
            this.data.modelSelection.value = first.model
            this.data.modelDraft.value = { model: first.model, api: first.api, contextWindow: first.contextWindow, maxTokens: first.maxTokens, reasoning: !!first.reasoning, vision: !!first.vision, thinking: 'off' }
        }
        this.syncSelects()
    },
    chooseModel(value) {
        const id = typeof value === 'string' ? value : 'custom'
        this.data.modelSelection.value = id
        if (id === 'custom') { this.data.modelDraft.value = { ...this.data.modelDraft.value, model: '' }; return }
        const option = this.connectionModels().find(item => item.model === id)
        if (!option) return
        this.data.modelDraft.value = { model: option.model, api: option.api, contextWindow: option.contextWindow, maxTokens: option.maxTokens, reasoning: !!option.reasoning, vision: !!option.vision, thinking: 'off' }
        this.syncSelects()
    },
    thinkingLevels() { return this.data.modelDraft.value.reasoning ? THINKING_LEVELS : ['off'] },
    levelLabel(level) { return level === 'off' ? 'Off' : level.charAt(0).toUpperCase() + level.slice(1) },
    toggleReasoning(event) {
        const reasoning = event.target.checked
        this.data.modelDraft.value = { ...this.data.modelDraft.value, reasoning, thinking: reasoning ? this.data.modelDraft.value.thinking : 'off' }
    },
    toggleVision(event) { this.data.modelDraft.value = { ...this.data.modelDraft.value, vision: event.target.checked } },
    /** Fast path from Blueed: switch the model without opening the manager. */
    quickOptions() {
        const connection = this.data.providers.value.find(item => item.id === this.quickConnectionId)
        if (!connection) return []
        const group = this.catalogGroups().find(item => item.id === connection.catalogId)
        if (!group) return []
        return group.models.filter(item => !item.baseUrl || item.baseUrl === connection.baseUrl).map(item => ({ ...item, api: item.api || group.api }))
    },
    modelLabel() {
        if (!this.workspace() && this.data.inherited.value) return 'Model · inherited, change to override'
        return this.data.providerReady.value ? 'Model' : 'Model · none selected'
    },
    syncQuick() {
        const selection = this.data.selection.value
        const connection = (selection?.providerId && this.data.providers.value.find(item => item.id === selection.providerId)) || this.data.providers.value[0]
        this.quickConnectionId = connection?.id || ''
        this.data.quickModel.value = selection?.configured ? selection.model : ''
        requestAnimationFrame(() => { const select = this.refs.quickSelect; if (select && select.value !== this.data.quickModel.value) select.value = this.data.quickModel.value })
    },
    async changeQuickModel(value) {
        const model = typeof value === 'string' ? value : ''
        if (model === '__settings' || !model) { this.syncQuick(); this.openSettings(); return }
        const option = this.quickOptions().find(item => item.model === model)
        if (!option || !this.quickConnectionId) { this.syncQuick(); return }
        this.data.error.value = ''
        try {
            const selection = await travel.configureProvider({
                scope: this.props.scope,
                providerId: this.quickConnectionId,
                model: option.model,
                api: option.api,
                contextWindow: option.contextWindow,
                maxTokens: option.maxTokens,
                reasoning: !!option.reasoning,
                vision: !!option.vision,
                thinking: 'off',
            })
            this.applySelection(selection)
            this.data.status.value = `In use: ${selection.model}.`
            await this.loadProviders()
        } catch (error) { this.data.error.value = error.message; this.syncQuick() }
    },
    /** Server-driven sign-in state: the browser only ever receives a link and a status. */
    applyCodexLogin(state) {
        if (!this.alive || !this.data.codexLoggingIn.value || (this.codexLoginId && this.codexLoginId !== state.id)) return
        this.codexLoginId = state.id
        this.data.codexLoginUrl.value = state.status === 'ready' && !this.data.codexCancelling.value ? state.url : ''
        if (state.active) return
        clearTimeout(this.codexLoginTimer)
        this.data.codexLoggingIn.value = false; this.data.codexLinkCopied.value = false; this.data.codexCancelling.value = false
        if (state.status === 'connected') { this.data.status.value = 'Signed in with ChatGPT.'; void this.afterCodexLogin(state.connectionId) }
        else if (state.error) this.data.error.value = state.error
    },
    async afterCodexLogin(connectionId) {
        await this.loadProviders()
        if (connectionId) this.editConnection(connectionId)
        this.syncQuick()
    },
    async connectOpenAICodex() {
        if (this.data.codexLoggingIn.value || this.data.saving.value || this.data.savingModel.value) return
        const epoch = ++this.codexEpoch
        this.codexLoginId = ''
        this.data.codexLoggingIn.value = true; this.data.codexLoginUrl.value = ''; this.data.codexLinkCopied.value = false; this.data.codexCancelling.value = false; this.data.error.value = ''
        try {
            const state = await travel.connectOpenAICodex({ name: this.data.editing.value.name?.trim() || 'OpenAI Codex' })
            if (!this.alive || epoch !== this.codexEpoch) return
            this.applyCodexLogin(state)
            if (this.data.codexLoggingIn.value) this.codexLoginTimer = setTimeout(() => { void this.pollCodexLogin(epoch) }, 500)
        } catch (error) { if (!this.alive || epoch !== this.codexEpoch) return; this.data.codexLoggingIn.value = false; this.data.codexLoginUrl.value = ''; this.data.error.value = error.message }
    },
    async pollCodexLogin(epoch) {
        if (!this.alive || epoch !== this.codexEpoch || !this.data.codexLoggingIn.value) return
        try {
            const state = await travel.getOpenAICodexLogin()
            if (!this.alive || epoch !== this.codexEpoch) return
            this.applyCodexLogin(state)
            if (this.data.codexLoggingIn.value) this.codexLoginTimer = setTimeout(() => { void this.pollCodexLogin(epoch) }, 1000)
        } catch (error) {
            if (!this.alive || epoch !== this.codexEpoch) return
            void travel.cancelOpenAICodexLogin()
            this.data.codexLoggingIn.value = false; this.data.codexLoginUrl.value = ''
            this.data.error.value = `Could not check the ChatGPT sign-in: ${error.message}`
        }
    },
    cancelOpenAICodexLogin() {
        if (!this.data.codexLoggingIn.value) return
        this.data.codexLoginUrl.value = ''; this.data.codexLinkCopied.value = false; this.data.codexCancelling.value = true
        void travel.cancelOpenAICodexLogin()
    },
    openCodexPopup() {
        const url = this.data.codexLoginUrl.value
        if (!url) return
        window.open(url, 'travelmore-chatgpt-login', 'noopener')
    },
    async copyCodexLoginLink() {
        const url = this.data.codexLoginUrl.value
        if (!url) return
        try { await navigator.clipboard.writeText(url); if (this.alive && this.data.codexLoginUrl.value === url) this.data.codexLinkCopied.value = true }
        catch { if (this.alive) this.data.error.value = 'Could not copy the sign-in link. Allow clipboard access and try again.' }
    },
    async openSettings() {
        this.autoSeeded = false; this.data.settingsOpen.value = true
        // Load the catalogue first: presets and model options are catalogue-driven, and seeding the
        // editor from an empty catalogue would drop the selected model into the "custom" fallback.
        await this.loadCatalog()
        await this.loadProviders()
        this.syncSelects()
    },
    closeSettings() { if (this.data.codexLoggingIn.value) this.cancelOpenAICodexLogin(); this.data.codexLoginUrl.value = ''; this.data.settingsOpen.value = false },
    async saveConnection() {
        const editing = this.data.editing.value
        this.data.saving.value = true; this.data.error.value = ''; this.data.status.value = ''
        try {
            const result = await travel.saveProviderConnection({
                id: editing.id || undefined,
                name: editing.name.trim(),
                baseUrl: editing.baseUrl.trim(),
                api: editing.api,
                auth: editing.auth,
                apiKey: editing.apiKey || undefined,
                catalogId: editing.catalogId || '',
            })
            this.data.providers.value = result.connections || []
            const connection = (result.connections || []).find(item => item.id === result.connectionId)
            if (connection) this.editConnection(connection.id)
            // A workspace without a model cannot answer: adopt the first catalogue model once.
            if (this.workspace() && this.data.modelDraft.value.model && !this.data.selection.value?.configured) await this.applyModel()
            else { this.data.status.value = 'Connection saved.'; await this.loadProviders() }
        } catch (error) { this.data.error.value = error.message }
        finally { if (this.alive) this.data.saving.value = false }
    },
    async applyModel() {
        const scope = this.props.scope, editing = this.data.editing.value, draft = this.data.modelDraft.value
        if (!scope || !editing.id) return
        this.data.savingModel.value = true; this.data.error.value = ''; this.data.status.value = ''
        try {
            const selection = await travel.configureProvider({
                scope,
                providerId: editing.id,
                model: draft.model.trim(),
                api: draft.api || editing.api,
                contextWindow: Number(draft.contextWindow),
                maxTokens: Number(draft.maxTokens),
                reasoning: draft.reasoning === true,
                vision: draft.vision === true,
                thinking: draft.reasoning ? draft.thinking : 'off',
            })
            this.applySelection(selection)
            this.data.status.value = `In use: ${selection.model}.`
            await this.loadProviders()
            this.syncQuick()
        } catch (error) { this.data.error.value = error.message }
        finally { if (this.alive) this.data.savingModel.value = false }
    },
    async clearOverride() {
        if (!this.props.scope || this.workspace()) return
        this.data.savingModel.value = true; this.data.error.value = ''; this.data.status.value = ''
        try { const selection = await travel.configureProvider({ scope: this.props.scope, providerId: null }); this.applySelection(selection); this.data.status.value = 'Back to the shared workspace model.'; await this.loadProviders(); if (selection?.providerId) this.editConnection(selection.providerId); this.syncQuick() }
        catch (error) { this.data.error.value = error.message }
        finally { if (this.alive) this.data.savingModel.value = false }
    },
    async removeConnection(id) {
        const connection = this.data.providers.value.find(item => item.id === id)
        if (!connection || !confirm(`Delete “${connection.name}”? Trips using it fall back to the shared model.`)) return
        this.data.saving.value = true; this.data.error.value = ''; this.data.status.value = ''
        try {
            const result = await travel.deleteProviderConnection({ id })
            this.data.providers.value = result.connections || []
            if (this.data.editing.value.id === id) this.newConnection()
            this.data.status.value = 'Connection deleted.'
            await this.loadProviders()
        } catch (error) { this.data.error.value = error.message }
        finally { if (this.alive) this.data.saving.value = false }
    },
}
