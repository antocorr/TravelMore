import { globals, watch, collectEffects } from 'tinybubble'
import { extend } from 'rpcable'
import { clientSession } from '../rpc/session.js'
import { travel } from '../services/travel.js'
import { router } from '../router.js'
import TripTree from './TripTree.tiny.js'
import MapPanel from './MapPanel.tiny.js'
import NodeDetail from './NodeDetail.tiny.js'
import AssistantPanel from './AssistantPanel.tiny.js'
import PlaceAutocomplete from './PlaceAutocomplete.tiny.js'
import { LAYOUT_DEFAULTS, LAYOUT_LIMITS, readLayout, writeLayout, flushLayout } from '../layout.js'
import '../resize.css'

export default {
    name: 'TripWorkspace',
    components: { 'trip-tree': TripTree, 'map-panel': MapPanel, 'node-detail': NodeDetail, 'assistant-panel': AssistantPanel, 'place-autocomplete': PlaceAutocomplete },
    data() { return { trips: [], activeTripId: '', rows: [], nodes: [], collapsedStopIds: [], detail: null, revision: null, loading: false, saving: false, error: '', createOpen: false, leftOpen: false, rightOpen: false, pickMode: '', draftPin: null, detailPickedLocation: null, selectionTick: 0, leftWidth: LAYOUT_DEFAULTS.left, rightWidth: LAYOUT_DEFAULTS.right, split: LAYOUT_DEFAULTS.split, desktopLayout: typeof window === 'undefined' ? true : window.innerWidth >= 880, resizeKind: '', createDraft: { parentId: null, type: 'trip', title: '', description: '', lat: '', lng: '', address: '', locationSource: '' }, images: [], completing: false, detailModalOpen: false, detailModalSuspended: false } },
    init() { const layout = readLayout(); this.data.leftWidth.value = layout.left; this.data.rightWidth.value = layout.right; this.data.split.value = layout.split }, 
    template() { return /*html*/`
    <main class="travel-app">
        <header class="topbar"><a class="brand" href="/" aria-label="TravelMore home"><span class="brand-compass">◌</span><span>Travel<span>More</span></span></a><nav class="trip-crumbs" aria-label="Breadcrumb"><button type="button" class="crumb-back" @click="goHome">‹ All trips</button><span class="crumb-sep" aria-hidden="true">/</span><strong class="crumb-title">{{ activeTrip()?.title || 'Trip' }}</strong><span x-if="tripMeta()" class="crumb-meta">{{ tripMeta() }}</span></nav><div class="topbar-actions"><span class="connection-state"><i :class="{ connected: online() }"></i>{{ online() ? 'Synced' : 'Connecting' }}</span><button type="button" class="mobile-panel" @click="toggleLeft" :aria-expanded="leftOpen" aria-label="Toggle itinerary">☰</button><button type="button" class="mobile-panel" @click="toggleRight" :aria-expanded="rightOpen" aria-label="Toggle assistant">✦</button></div></header>
        <div x-if="error" class="app-error" role="alert"><span>{{ error }}</span><button type="button" @click="clearError" aria-label="Dismiss error">×</button></div>
        <div ref="workspace" class="workspace" :style="workspaceStyle()">
            <aside class="left-rail" :class="{ open: leftOpen }"><trip-tree :rows="rows" :selected-id="selectedId()" :trip-id="activeTripId" :loading="loading" :collapsed-stop-ids="collapsedStopIds" @collapse-change="setCollapsedStops" @select="selectFromRail" @create="openCreate"></trip-tree></aside>
            <button class="workspace-resize-handle resize-vertical" :class="{ dragging: resizeKind === 'left' }" :style="leftHandleStyle()" type="button" role="separator" tabindex="0" aria-orientation="vertical" aria-label="Resize itinerary panel" :aria-valuenow="leftWidth" :aria-valuemin="210" :aria-valuemax="420" @pointerdown="startResize('left', $event)" @pointermove="moveResize($event)" @pointerup="endResize($event)" @pointercancel="endResize($event)" @dblclick="resetDimension('left')" @keydown="resizeKey('left', $event)"></button>
            <section ref="mainColumn" class="main-column" :style="mainColumnStyle()"><map-panel :nodes="nodes" :images="images" :collapsed-stop-ids="collapsedStopIds" :completing="completing" :selection-tick="selectionTick" :selected-id="selectedId()" :draft-pin="draftPin" :picking="!!pickMode" @select="selectNode" @expand="openDetailModal" @pick="pickPoint" @move-pin="movePin" @cancel-pick="cancelPick" @add-pin="startCreatePin" @complete="completePlaces"></map-panel><node-detail :detail="detail" :picked-location="detailPickedLocation" :saving="saving" @save="saveNode" @add-todo="addTodo" @toggle-todo="toggleTodo" @delete-todo="deleteTodo" @add-image="addImage" @promote-image="promoteImage" @delete-image="deleteImage" @delete-node="deleteNode" @create-child="openCreate" @pick-location="startNodePick"></node-detail><button class="workspace-resize-handle resize-horizontal" :class="{ dragging: resizeKind === 'split' }" :style="splitHandleStyle()" type="button" role="separator" tabindex="0" aria-orientation="horizontal" aria-label="Resize map and detail" :aria-valuenow="split" :aria-valuemin="25" :aria-valuemax="70" @pointerdown="startResize('split', $event)" @pointermove="moveResize($event)" @pointerup="endResize($event)" @pointercancel="endResize($event)" @dblclick="resetDimension('split')" @keydown="resizeKey('split', $event)"></button></section>
            <button class="workspace-resize-handle resize-vertical" :class="{ dragging: resizeKind === 'right' }" :style="rightHandleStyle()" type="button" role="separator" tabindex="0" aria-orientation="vertical" aria-label="Resize assistant panel" :aria-valuenow="rightWidth" :aria-valuemin="280" :aria-valuemax="520" @pointerdown="startResize('right', $event)" @pointermove="moveResize($event)" @pointerup="endResize($event)" @pointercancel="endResize($event)" @dblclick="resetDimension('right')" @keydown="resizeKey('right', $event)"></button>
            <aside class="right-rail" :class="{ open: rightOpen }"><assistant-panel :scope="activeTripId || 'workspace'"></assistant-panel></aside>
            <button x-if="leftOpen || rightOpen" class="mobile-scrim" type="button" @click="closePanels" aria-label="Close side panels"></button>
        </div>
        <div x-if="detailModalOpen && detail" x-show="!detailModalSuspended" class="detail-modal-backdrop" @click="closeDetailModalFromBackdrop($event)"><section ref="detailDialog" class="detail-modal" role="dialog" aria-modal="true" :aria-label="modalTitle()" tabindex="-1"><header class="detail-modal-header"><span class="eyebrow">ITINERARY DETAILS</span><button type="button" class="round-button" @click="closeDetailModal" aria-label="Close details">×</button></header><node-detail :detail="detail" :picked-location="detailPickedLocation" :saving="saving" @save="saveNode" @add-todo="addTodo" @toggle-todo="toggleTodo" @delete-todo="deleteTodo" @add-image="addImage" @promote-image="promoteImage" @delete-image="deleteImage" @delete-node="deleteNode" @create-child="openCreate" @pick-location="startNodePick"></node-detail></section></div>
        <div x-if="createOpen" class="sheet-backdrop"><section class="create-sheet" role="dialog" aria-modal="true" aria-label="Create itinerary item"><header><div><span class="eyebrow">NEW {{ createDraft.type || 'item' }}</span><h2>{{ createHeading() }}</h2></div><button type="button" class="round-button" @click="closeCreate" aria-label="Close">×</button></header><form @submit-prevent="createNode"><div x-if="createDraft.type === 'trip'"><label>Name<input x-model="createDraft.title" required autocomplete="off" autofocus placeholder="Give this a meaningful name" /></label></div><div x-if="createDraft.type !== 'trip'"><place-autocomplete input-id="create-place-search" label="Name" :value="createDraft.title" :near="mapAnchor()" :autofocus="true" placeholder="Search a city, landmark or address" hint="Type two characters to search OpenStreetMap, or pick the pin on the map below." @input="setCreateTitle" @pick="applyCreatePlace"></place-autocomplete><div class="sheet-pin"><div class="sheet-pin-head"><span class="field-label">Map pin</span><span class="sheet-pin-value">{{ pinLabel() }}</span></div><div class="sheet-pin-actions"><button type="button" class="button-secondary" @click="pickCreateOnMap">{{ hasCreatePin() ? 'Move pin on map' : 'Pick pin on map' }}</button><button x-if="hasCreatePin()" type="button" class="text-danger" @click="clearCreatePin">Remove pin</button></div><p x-if="createDraft.address" class="sheet-pin-address">{{ createDraft.address }}</p></div></div><label>Type<select x-model="createDraft.type"><option value="trip">Trip</option><option value="stop">Stop</option><option value="place">Place</option></select></label><label>Intent <textarea x-model="createDraft.description" rows="4" placeholder="Why does this belong in the trip?"></textarea></label><div class="sheet-actions"><button type="button" class="button-secondary" @click="closeCreate">Cancel</button><button type="submit" class="button-primary" :disabled="saving || !createDraft.title.trim()">{{ saving ? 'Creating…' : 'Create' }}</button></div></form></section></div>
    </main>` },
    async mounted() {
        this.alive = true
        this.modalKeydownListener = event => this.handleModalKeydown(event)
        document.addEventListener('keydown', this.modalKeydownListener)
        this.layoutMedia = window.matchMedia('(max-width: 879px)')
        this.layoutMediaChange = event => { this.data.desktopLayout.value = !event.matches; if (event.matches) this.cancelResize() }
        this.layoutMedia.addEventListener('change', this.layoutMediaChange)
        this.tripEpoch = 0
        this.selectionEpoch = 0
        this.travelUpdated = () => {
            clearTimeout(this.refreshTimer)
            // Re-select whatever is current when the refresh runs: a stale capture would undo a fresh selection.
            this.refreshTimer = setTimeout(() => { if (this.alive && this.online() && !this.data.saving.value) void this.refreshTreeAndDetail() }, 180)
        }
        extend(clientSession, { travelUpdated: this.travelUpdated })
        this.disposers = collectEffects(() => { watch(globals.$rpcStatus, status => { if (status === 'online') void this.loadTrips(this.routeTripId()) }); watch(() => this.$route?.params?.id, tripId => { if (this.online()) void this.loadTrips(tripId || '') }) })
        if (this.online()) await this.loadTrips(this.routeTripId())
    },
    beforeDestroy() { this.alive = false; clearTimeout(this.refreshTimer); this.closeDetailModal(); document.removeEventListener('keydown', this.modalKeydownListener); this.cancelResize(); this.layoutMedia?.removeEventListener('change', this.layoutMediaChange); this.disposers?.forEach(dispose => dispose()); if (clientSession.travelUpdated === this.travelUpdated) delete clientSession.travelUpdated }, 
    online() { return globals.$rpcStatus.value === 'online' },
    workspaceStyle() { return this.data.desktopLayout.value ? { gridTemplateColumns: `${this.data.leftWidth.value}px minmax(480px, 1fr) ${this.data.rightWidth.value}px` } : null },
    mainColumnStyle() { return this.data.desktopLayout.value ? { gridTemplateRows: `minmax(220px, ${this.data.split.value}%) minmax(0, 1fr)` } : null },
    leftHandleStyle() { return this.data.desktopLayout.value ? { left: `${this.data.leftWidth.value}px` } : null },
    rightHandleStyle() { return this.data.desktopLayout.value ? { right: `${this.data.rightWidth.value}px` } : null },
    splitHandleStyle() { return this.data.desktopLayout.value ? { top: `${this.data.split.value}%` } : null },
    layoutWidth() { return this.refs?.workspace?.getBoundingClientRect?.().width || window.innerWidth },
    setDimension(kind, value, persist = true) {
        if (!this.data.desktopLayout.value) return
        if (kind === 'split') this.data.split.value = Math.min(LAYOUT_LIMITS.split.max, Math.max(LAYOUT_LIMITS.split.min, value))
        else {
            const opposite = kind === 'left' ? this.data.rightWidth.value : this.data.leftWidth.value
            const limits = LAYOUT_LIMITS[kind], availableMax = this.layoutWidth() - opposite - LAYOUT_LIMITS.centerMin
            const max = Math.min(limits.max, availableMax)
            if (max < limits.min) return
            this.data[kind === 'left' ? 'leftWidth' : 'rightWidth'].value = Math.round(Math.min(max, Math.max(limits.min, value)))
        }
        if (persist) writeLayout({ left: this.data.leftWidth.value, right: this.data.rightWidth.value, split: this.data.split.value })
    },
    startResize(kind, event) {
        if (!this.data.desktopLayout.value || event.button !== 0) return
        event.preventDefault()
        window.getSelection?.().removeAllRanges()
        event.currentTarget.focus?.({ preventScroll: true })
        this.data.resizeKind.value = kind
        this.resizeStart = { x: event.clientX, y: event.clientY, left: this.data.leftWidth.value, right: this.data.rightWidth.value, split: this.data.split.value, height: this.refs?.mainColumn?.getBoundingClientRect?.().height || 1 }
        event.currentTarget.setPointerCapture?.(event.pointerId)
        document.body.classList.add('workspace-resizing')
    },
    moveResize(event) {
        const kind = this.data.resizeKind.value, start = this.resizeStart
        if (!kind || !start) return
        const value = kind === 'left' ? start.left + event.clientX - start.x : kind === 'right' ? start.right - (event.clientX - start.x) : start.split + ((event.clientY - start.y) / start.height * 100)
        this.setDimension(kind, value)
    },
    endResize(event) {
        if (!this.data.resizeKind.value) return
        try { event.currentTarget.releasePointerCapture?.(event.pointerId) } catch { /* capture can already be released */ }
        this.data.resizeKind.value = ''; this.resizeStart = null
        document.body.classList.remove('workspace-resizing')
        flushLayout()
    },
    cancelResize() { if (!this.data.resizeKind.value) return; this.data.resizeKind.value = ''; this.resizeStart = null; document.body.classList.remove('workspace-resizing'); flushLayout() },
    resetDimension(kind) { this.setDimension(kind, LAYOUT_DEFAULTS[kind]); flushLayout() },
    resizeKey(kind, event) {
        const limits = LAYOUT_LIMITS[kind], step = event.shiftKey ? 24 : 8
        let value = null
        if (event.key === 'Home') value = limits.min
        else if (event.key === 'End') value = limits.max
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') value = this.dimensionValue(kind) - step
        else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') value = this.dimensionValue(kind) + step
        if (value === null) return
        event.preventDefault(); this.setDimension(kind, value); flushLayout()
    },
    dimensionValue(kind) { return kind === 'left' ? this.data.leftWidth.value : kind === 'right' ? this.data.rightWidth.value : this.data.split.value },
    clearError() { this.data.error.value = '' },
    routeTripId() { return this.$route?.params?.id || '' },
    goHome() { router.navigate('/') },
    /** The dashboard links here as `/trips/<id>?new=stop`; consume the intent once and clean the URL. */
    consumeStopIntent(tripId) {
        if (this.$route?.query?.new !== 'stop' || this.stopIntentFor === tripId) return
        this.stopIntentFor = tripId
        history.replaceState(null, '', `/trips/${encodeURIComponent(tripId)}`)
        this.openCreate({ parentId: tripId, type: 'stop' })
    },
    activeTrip() { return (this.data.trips.value || []).find(trip => trip.id === this.data.activeTripId.value) || null },
    shortDate(value) { if (!value) return ''; const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) },
    tripMeta() {
        const trip = this.activeTrip()
        if (!trip) return ''
        const parts = [], from = this.shortDate(trip.startDate), to = this.shortDate(trip.endDate)
        if (from && to) parts.push(`${from} – ${to}`)
        else if (from) parts.push(`from ${from}`)
        const stats = trip.stats
        if (stats && Number.isFinite(stats.stops)) parts.push(`${stats.stops} ${stats.stops === 1 ? 'stop' : 'stops'}`)
        return parts.join(' · ')
    },
    navigateTrip(tripId) { if (tripId) router.navigate(`/trips/${encodeURIComponent(tripId)}`) },
    async loadTrips(preferredId) {
        if (!this.online()) return
        const requestedTripId = preferredId || '', epoch = this.tripLoadEpoch = (this.tripLoadEpoch || 0) + 1
        this.data.loading.value = true; this.data.error.value = ''
        try {
            const response = await travel.listTrips(); const trips = response.trips || []
            if (!this.alive || epoch !== this.tripLoadEpoch || this.routeTripId() !== requestedTripId) return
            this.data.trips.value = trips
            const active = trips.find(trip => trip.id === preferredId)
            if (active) await this.openTrip(active.id)
            else { this.tripEpoch++; this.selectionEpoch++; this.data.activeTripId.value = ''; this.data.rows.value = []; this.data.nodes.value = []; this.data.collapsedStopIds.value = []; this.data.detail.value = null }
        } catch (error) { if (this.alive) this.data.error.value = error.message }
        finally { if (this.alive) this.data.loading.value = false }
    },
    async openTrip(tripId) {
        if (!tripId || !this.online()) return
        if (this.data.detailModalOpen.value) this.closeDetailModal()
        const epoch = ++this.tripEpoch
        this.selectionEpoch++
        this.data.loading.value = true; this.data.error.value = ''
        if (this.data.activeTripId.value !== tripId) this.data.collapsedStopIds.value = []
        this.data.activeTripId.value = tripId; this.data.detail.value = null
        try {
            const tree = await travel.tree(tripId)
            if (!this.alive || epoch !== this.tripEpoch || this.data.activeTripId.value !== tripId) return
            this.data.nodes.value = tree.nodes || []
            this.data.images.value = tree.images || []
            this.data.rows.value = this.flatten(tree.trip, tree.nodes || [])
            this.data.revision.value = tree.revision ?? null
            const selected = this.selectedId()
            const fallback = selected && (tree.nodes || []).some(node => node.id === selected) ? selected : tree.trip?.id || (tree.nodes || [])[0]?.id
            if (fallback) await this.selectNode(fallback)
            this.consumeStopIntent(tripId)
        } catch (error) { if (this.alive) this.data.error.value = error.message }
        finally { if (this.alive) this.data.loading.value = false; this.closePanels() }
    },
    flatten(trip, nodes) {
        const all = trip ? [trip, ...nodes.filter(node => node.id !== trip.id)] : nodes
        const childMap = new Map()
        for (const node of all) { const key = node.parentId || '__root__'; const bucket = childMap.get(key) || []; bucket.push(node); childMap.set(key, bucket) }
        for (const bucket of childMap.values()) bucket.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        const roots = trip ? [trip] : childMap.get('__root__') || []
        const rows = []; const seen = new Set()
        const visit = (node, depth) => { if (!node || seen.has(node.id)) return; seen.add(node.id); rows.push({ ...node, depth }); for (const child of childMap.get(node.id) || []) visit(child, depth + 1) }
        roots.forEach(node => visit(node, 0)); all.forEach(node => visit(node, 0))
        return rows
    },
    selectedId() { const node = this.data.detail.value?.node || this.data.detail.value; return node?.id || '' },
    setCollapsedStops(ids) { this.data.collapsedStopIds.value = ids },
    /** A rail click can re-select the same node: the tick tells the map to reopen that bubble. */
    selectFromRail(id) { this.data.selectionTick.value = (this.data.selectionTick.value || 0) + 1; return this.selectNode(id) },
    async selectNode(id) {
        if (this.data.detailModalOpen.value && this.selectedId() !== id) this.closeDetailModal()
        const tripId = this.data.activeTripId.value, tripEpoch = this.tripEpoch, selectionEpoch = ++this.selectionEpoch
        if (!id || !tripId || !this.online()) return
        this.data.error.value = ''
        try { const detail = await travel.detail(id); if (this.alive && tripEpoch === this.tripEpoch && selectionEpoch === this.selectionEpoch && this.data.activeTripId.value === tripId) this.data.detail.value = detail } catch (error) { if (this.alive && selectionEpoch === this.selectionEpoch && this.data.activeTripId.value === tripId) this.data.error.value = error.message }
        this.closePanels()
    },
    modalTitle() { return `${(this.data.detail.value?.node || this.data.detail.value)?.title || 'Place'} details` },
    async openDetailModal(id) {
        if (!id) return
        this.modalReturnFocus = document.activeElement
        if (this.selectedId() !== id) await this.selectNode(id)
        if (!this.alive || this.selectedId() !== id) return
        this.data.detailModalOpen.value = true
        this.data.detailModalSuspended.value = false
        this.refs.workspace.inert = true
        document.body.classList.add('detail-modal-open')
        requestAnimationFrame(() => { if (this.data.detailModalOpen.value) this.refs?.detailDialog?.focus() })
    },
    closeDetailModal() {
        if (!this.data.detailModalOpen.value) return
        this.data.detailModalOpen.value = false
        this.data.detailModalSuspended.value = false
        if (this.refs?.workspace) this.refs.workspace.inert = false
        document.body.classList.remove('detail-modal-open')
        const returnFocus = this.modalReturnFocus
        this.modalReturnFocus = null
        requestAnimationFrame(() => { if (returnFocus?.isConnected) returnFocus.focus?.({ preventScroll: true }) })
    },
    closeDetailModalFromBackdrop(event) { if (event.target === event.currentTarget) this.closeDetailModal() },
    handleModalKeydown(event) {
        if (!this.data.detailModalOpen.value || this.data.detailModalSuspended.value) return
        if (event.key === 'Escape') { event.preventDefault(); this.closeDetailModal(); return }
        if (event.key !== 'Tab') return
        const dialog = this.refs?.detailDialog
        const focusable = [...(dialog?.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]') || [])].filter(element => element.getClientRects().length)
        if (!focusable.length) { event.preventDefault(); dialog?.focus(); return }
        const first = focusable[0], last = focusable.at(-1)
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    },
    toggleLeft() { this.data.leftOpen.value = !this.data.leftOpen.value; this.data.rightOpen.value = false },
    toggleRight() { this.data.rightOpen.value = !this.data.rightOpen.value; this.data.leftOpen.value = false },
    closePanels() { this.data.leftOpen.value = false; this.data.rightOpen.value = false },
    openCreate(input = {}) {
        if (this.data.detailModalOpen.value) this.closeDetailModal()
        const selected = this.data.detail.value?.node || this.data.detail.value
        const type = input.type || 'place'
        this.data.pickMode.value = ''
        this.data.draftPin.value = null
        this.data.createDraft.value = { parentId: input.parentId ?? (type === 'trip' ? null : selected?.id || this.data.activeTripId.value || null), type, title: '', description: '', lat: '', lng: '', address: '', locationSource: '' }
        this.data.createOpen.value = true
    },
    closeCreate() { if (this.data.saving.value) return; this.data.createOpen.value = false; this.data.pickMode.value = ''; this.data.draftPin.value = null },
    validPoint(lat, lng) {
        if (lat === null || lat === undefined || lat === '' || lng === null || lng === undefined || lng === '') return null
        const latitude = Number(lat), longitude = Number(lng)
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null
        return { lat: Math.round(latitude * 1_000_000) / 1_000_000, lng: Math.round(longitude * 1_000_000) / 1_000_000 }
    },
    mapAnchor() {
        const node = this.data.detail.value?.node || this.data.detail.value
        return node ? this.validPoint(node.lat, node.lng) : null
    },
    hasCreatePin() { return !!this.validPoint(this.data.createDraft.value.lat, this.data.createDraft.value.lng) },
    pinLabel() { const point = this.validPoint(this.data.createDraft.value.lat, this.data.createDraft.value.lng); return point ? `${point.lat.toFixed(4)}, ${point.lng.toFixed(4)}` : 'Not placed yet' },
    setCreateTitle(value) { const draft = this.data.createDraft.value, typed = String(value || ''); if (draft.locationSource === 'search') { this.data.createDraft.value = { ...draft, title: typed, lat: '', lng: '', address: '', locationSource: '' }; this.data.draftPin.value = null } else this.data.createDraft.value = { ...draft, title: typed } },
    // A search result names the stop and drops its pin in one step.
    applyCreatePlace(place) {
        const point = place ? this.validPoint(place.lat, place.lng) : null
        if (!place || !point) return
        const draft = this.data.createDraft.value
        this.data.createDraft.value = { ...draft, title: place.name || draft.title, lat: point.lat, lng: point.lng, address: place.displayName || '', locationSource: 'search' }
        this.data.draftPin.value = { lat: point.lat, lng: point.lng, title: place.name || draft.title }
    },
    clearCreatePin() { const draft = this.data.createDraft.value; this.data.createDraft.value = { ...draft, lat: '', lng: '', address: '', locationSource: '' }; this.data.draftPin.value = null },
    pickCreateOnMap() {
        if (!this.online()) { this.data.error.value = 'Not connected to the server.'; return }
        this.data.createOpen.value = false
        this.data.pickMode.value = 'create'
    },
    // Quick add: aim at the map first, then name what the pin landed on.
    startCreatePin() {
        if (!this.data.activeTripId.value) { this.openCreate({ type: 'trip' }); return }
        const selected = this.data.detail.value?.node || this.data.detail.value
        this.data.createDraft.value = { parentId: selected?.id || this.data.activeTripId.value, type: selected?.type === 'trip' || !selected ? 'stop' : 'place', title: '', description: '', lat: '', lng: '', address: '', locationSource: '' }
        this.data.draftPin.value = null
        this.data.createOpen.value = false
        this.data.pickMode.value = 'create'
    },
    startNodePick(id) { if (!id || !this.online()) return; this.data.detailPickedLocation.value = null; this.data.pickMode.value = { kind: 'detail-draft', id }; if (this.data.detailModalOpen.value) { this.data.detailModalSuspended.value = true; this.refs.workspace.inert = false } this.closePanels() },
    cancelPick() {
        const mode = this.data.pickMode.value
        this.data.pickMode.value = ''
        if (mode === 'create') this.data.createOpen.value = true
        if (mode?.kind === 'detail-draft' && this.data.detailModalOpen.value) { this.data.detailModalSuspended.value = false; this.refs.workspace.inert = true; requestAnimationFrame(() => this.refs?.detailDialog?.focus()) }
    },
    async pickPoint(point) {
        const mode = this.data.pickMode.value
        const target = this.validPoint(point?.lat, point?.lng)
        if (!mode || !target) return
        this.data.pickMode.value = ''
        if (mode?.kind === 'detail-draft') {
            const id = mode.id
            const picked = { id, lat: target.lat, lng: target.lng, address: '' }
            this.data.detailPickedLocation.value = picked
            if (this.data.detailModalOpen.value) { this.data.detailModalSuspended.value = false; this.refs.workspace.inert = true; requestAnimationFrame(() => this.refs?.detailDialog?.focus()) }
            try {
                const response = await travel.reversePlace(target), place = response?.status === 'observed' ? response.place : null
                if (this.alive && this.data.activeTripId.value && this.data.detailPickedLocation.value?.id === id) this.data.detailPickedLocation.value = { ...picked, address: place?.displayName || place?.name || '' }
            } catch { /* coordinates are still a valid draft location */ }
            return
        }
        if (mode === 'create') {
            const draft = this.data.createDraft.value
            this.data.createDraft.value = { ...draft, lat: target.lat, lng: target.lng, address: '', locationSource: 'map' }
            this.data.draftPin.value = { lat: target.lat, lng: target.lng, title: draft.title }
            this.data.createOpen.value = true
            await this.describeCreatePin(target)
            return
        }
        await this.saveLocation(mode, target)
    },
    // Name an empty pin from the map click; never overwrites what the user typed.
    async describeCreatePin(point) {
        try {
            const response = await travel.reversePlace(point)
            if (!this.alive) return
            const place = response?.status === 'observed' ? response.place : null
            if (!place) return
            const draft = this.data.createDraft.value
            if (draft.lat !== point.lat || draft.lng !== point.lng) return
            const resolved = String(draft.title || '').trim() ? draft.title : place.name
            this.data.createDraft.value = { ...draft, title: resolved, address: place.displayName || place.name || '' }
            this.data.draftPin.value = { lat: point.lat, lng: point.lng, title: resolved }
        } catch { /* the pin stays usable without an address */ }
    },
    async movePin(move) { await this.saveLocation(move?.id, this.validPoint(move?.lat, move?.lng)) },
    async saveLocation(id, point) {
        if (!id || !point) return
        const tripId = this.data.activeTripId.value
        await this.saveNode({ id, patch: { lat: point.lat, lng: point.lng } })
        try {
            const response = await travel.reversePlace(point)
            const place = response?.status === 'observed' ? response.place : null
            if (!this.alive || !place || this.data.activeTripId.value !== tripId) return
            await this.saveNode({ id, patch: { address: place.displayName || place.name || '' } })
        } catch { /* coordinates are already saved */ }
    },
    createHeading() { return this.data.createDraft.value.type === 'trip' ? 'A new chapter.' : this.data.createDraft.value.type === 'stop' ? 'Add a meaningful stop.' : 'Mark a place to remember.' },
    async createNode() {
        const draft = { ...this.data.createDraft.value }
        if (!draft.title.trim()) return
        // Root nodes must be trips; child nodes must keep a concrete parent.
        const parentId = draft.type === 'trip' ? null : (draft.parentId || this.data.activeTripId.value || null)
        const point = draft.type === 'trip' ? null : this.validPoint(draft.lat, draft.lng)
        const input = { parentId, type: draft.type, title: draft.title.trim(), description: draft.description, lat: point ? point.lat : null, lng: point ? point.lng : null, address: point ? draft.address || '' : '' }
        this.data.saving.value = true; this.data.error.value = ''
        try {
            const result = await travel.createNode(input)
            this.data.createOpen.value = false
            this.data.draftPin.value = null
            this.data.pickMode.value = ''
            const tripId = input.type === 'trip' ? result.node.id : this.data.activeTripId.value
            if (input.type === 'trip') this.navigateTrip(tripId)
            else await this.loadTrips(tripId)
            if (input.type !== 'trip' && result.node?.id) await this.selectNode(result.node.id)
        } catch (error) { this.data.error.value = error.message }
        finally { if (this.alive) this.data.saving.value = false }
    },
    async refreshTreeAndDetail(id = this.selectedId()) {
        const tripId = this.data.activeTripId.value
        if (!tripId || !this.online()) return
        try {
            const tree = await travel.tree(tripId)
            if (!this.alive || this.data.activeTripId.value !== tripId) return
            this.data.nodes.value = tree.nodes || []
            this.data.images.value = tree.images || []
            this.data.rows.value = this.flatten(tree.trip, tree.nodes || [])
            const validIds = new Set((tree.nodes || []).filter(node => node.type === 'stop').map(node => node.id))
            this.data.collapsedStopIds.value = this.data.collapsedStopIds.value.filter(id => validIds.has(id))
            this.data.revision.value = tree.revision ?? this.data.revision.value
            const retained = id && (tree.trip?.id === id || (tree.nodes || []).some(node => node.id === id)) ? id : tree.trip?.id
            if (retained) await this.selectNode(retained)
        } catch (error) { if (this.alive) this.data.error.value = error.message }
    },
    /** Fill the empty places of this trip with a real pin, description and photo. */
    async completePlaces() {
        const tripId = this.data.activeTripId.value
        if (!tripId || !this.online() || this.data.completing.value) return
        this.data.completing.value = true; this.data.error.value = ''
        try {
            const result = await travel.completePlaces(tripId)
            await this.refreshTreeAndDetail()
            if (this.alive && result) {
                if (result.halted) this.data.error.value = result.halted
                else if (!result.completed && result.results?.length) this.data.error.value = result.results.find(item => item.reason)?.reason || 'No source returned details for these places.'
            }
        } catch (error) { if (this.alive) this.data.error.value = error.message }
        finally { if (this.alive) this.data.completing.value = false }
    },
    async saveNode(payload) {
        const tripId = this.data.activeTripId.value, epoch = this.tripEpoch
        this.data.saving.value = true; this.data.error.value = ''
        try { const result = await travel.updateNode({ ...payload, revision: this.data.revision.value ?? undefined }); if (!this.alive || epoch !== this.tripEpoch || tripId !== this.data.activeTripId.value) return; this.data.revision.value = result.revision ?? this.data.revision.value; await this.refreshTreeAndDetail(this.selectedId()) } catch (error) { if (this.alive && epoch === this.tripEpoch && tripId === this.data.activeTripId.value) this.data.error.value = error.message }
        finally { if (this.alive) this.data.saving.value = false }
    },
    async addTodo(todo) { await this.detailAction(() => travel.saveTodo(todo)) },
    async toggleTodo(todo) { await this.detailAction(() => travel.saveTodo({ id: todo.id, nodeId: todo.nodeId, title: todo.title, done: todo.done, position: todo.position })) },
    async deleteTodo(id) { await this.detailAction(() => travel.deleteTodo({ id })) },
    async addImage(image) { await this.imageAction(() => travel.saveImage(image)) },
    async promoteImage(image) { await this.imageAction(() => travel.saveImage(image)) },
    async deleteImage(id) { await this.imageAction(() => travel.deleteImage({ id })) },
    async deleteNode(node) {
        this.data.saving.value = true
        try { await travel.deleteNode({ id: node.id, revision: this.data.revision.value ?? undefined }); if (node.type === 'trip') router.navigate('/'); else await this.loadTrips(this.data.activeTripId.value) } catch (error) { this.data.error.value = error.message }
        finally { if (this.alive) this.data.saving.value = false }
    },
    async imageAction(action) { this.data.saving.value = true; this.data.error.value = ''; const tripId = this.data.activeTripId.value, epoch = this.tripEpoch; try { await action(); if (this.alive && epoch === this.tripEpoch && tripId === this.data.activeTripId.value) await this.refreshTreeAndDetail(this.selectedId()) } catch (error) { this.data.error.value = error.message } finally { if (this.alive) this.data.saving.value = false } },
    async detailAction(action) { this.data.saving.value = true; this.data.error.value = ''; const id = this.selectedId(); try { await action(); await this.selectNode(id) } catch (error) { this.data.error.value = error.message } finally { if (this.alive) this.data.saving.value = false } },
}
