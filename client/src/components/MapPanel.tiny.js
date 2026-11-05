import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { watchProp, collectEffects } from 'tinybubble'

export default {
    name: 'MapPanel', props: ['nodes', 'images', 'collapsedStopIds', 'selectedId', 'selectionTick', 'draftPin', 'picking', 'completing'], emits: ['select', 'expand', 'pick', 'movePin', 'cancelPick', 'addPin', 'complete'],
    template() { return /*html*/`
    <section class="map-panel" :class="{ picking: picking }" aria-label="Map">
        <div class="map-toolbar"><div><span class="eyebrow">PLACE CONTEXT</span><strong>{{ mappedCount() ? mappedCount() + ' mapped places' : 'Map your places' }}</strong></div><div class="map-toolbar-actions"><button x-if="pendingCount()" type="button" class="map-action map-action-complete" @click="complete" :disabled="completing" :title="completing ? 'OpenStreetMap allows one request per second, so this takes a few seconds per place.' : 'Fill the empty pins, descriptions and photos from OpenStreetMap and Wikipedia'" :aria-label="'Complete ' + pendingCount() + ' places with a pin, description and photo'">{{ completing ? 'Completing… ~1 place/second' : 'Complete ' + pendingCount() + (pendingCount() === 1 ? ' place' : ' places') }}</button><button type="button" class="map-action map-action-pin" @click="addPin" aria-label="Add a pin on the map">＋ Pin</button><button type="button" class="map-action" @click="fit">Fit itinerary</button></div></div>
        <div ref="map" class="map-canvas" role="application" aria-label="Interactive OpenStreetMap. Select a point to open its detail."></div>
        <div x-if="picking" class="map-pick-hint" role="status"><span class="map-pick-dot" aria-hidden="true"></span><span>Click the map to drop the pin</span><button type="button" class="map-action" @click="cancelPick">Cancel</button></div>
        <p x-if="!mappedCount() && !picking" class="map-empty">Add coordinates to a stop or place to see it here.</p>
        <p x-if="mappedCount() && pendingCount() && !picking" class="map-pending">{{ pendingLabel() }}</p>
        <small class="map-osm">© OpenStreetMap contributors</small>
    </section>` },
    mounted() {
        this.map = L.map(this.refs.map, { zoomControl: false, attributionControl: true, scrollWheelZoom: true }).setView([25, 8], 2)
        this.autoFitPending = true
        this.userHasMoved = false
        this.knownIds = new Set()
        this.map.on('dragstart', () => { this.userHasMoved = true })
        this.map.on('zoomstart', () => { if (!this.programmaticMove) this.userHasMoved = true })
        this.map.on('click', event => { if (this.props.picking) this.emit('pick', { lat: event.latlng.lat, lng: event.latlng.lng }) })
        L.control.zoom({ position: 'bottomright' }).addTo(this.map)
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(this.map)
        this.layer = L.layerGroup().addTo(this.map)
        this.renderPoints()
        this.propDisposers = collectEffects(() => {
            watchProp(this, 'nodes', () => this.renderPoints())
            watchProp(this, 'images', () => this.renderPoints())
            watchProp(this, 'collapsedStopIds', () => this.renderPoints({ visibilityChanged: true }))
            watchProp(this, 'selectedId', () => this.renderPoints())
            watchProp(this, 'selectionTick', () => this.renderPoints())
            watchProp(this, 'draftPin', () => this.renderDraft())
            watchProp(this, 'picking', picking => { if (picking) this.closeTooltip() })
        })
        this.resizeObserver = new ResizeObserver(() => { this.map?.invalidateSize({ pan: false }); this.openPopupMarker?.getPopup()?.update(); if (this.autoFitPending) this.fitPoints(this.points()) })
        this.resizeObserver.observe(this.refs.map)
        // Timers, not rAF: a hidden tab pauses animation frames and the map would keep a stale size.
        setTimeout(() => { if (!this.map) return; this.map.invalidateSize({ pan: false }); if (this.autoFitPending) this.fitPoints(this.points()) }, 0)
    },
    beforeDestroy() {
        this.propDisposers?.forEach(dispose => dispose())
        this.resizeObserver?.disconnect()
        if (this.map) this.map.remove()
    },
    points() {
        const nodes = this.props.nodes || [], byId = new Map(nodes.map(node => [node.id, node]))
        const collapsed = new Set(this.props.collapsedStopIds || [])
        return nodes.filter(node => {
            if (node.type === 'trip' || node.lat == null || node.lng == null || node.lat === '' || node.lng === '') return false
            const lat = Number(node.lat), lng = Number(node.lng)
            if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return false
            const visited = new Set()
            for (let parent = node.parentId; parent && !visited.has(parent); parent = byId.get(parent)?.parentId) {
                if (collapsed.has(parent)) return false
                visited.add(parent)
            }
            return true
        })
    },
    mappedCount() { return this.points().length },
    /** Places that exist but would not appear on the map, or that carry nothing but a name. */
    pendingCount() {
        return (this.props.nodes || []).filter(node => (node.type === 'place' || node.type === 'stop') && (node.lat == null || node.lng == null || !(node.description || node.notes) || !this.hasPrimaryImage(node))).length
    },
    hasPrimaryImage(node) { return (this.props.images || []).some(image => image.nodeId === node.id && image.isPrimary) },
    pendingLabel() { const count = this.pendingCount(); return `${count} ${count === 1 ? 'place still needs' : 'places still need'} a pin, description or primary photo` },
    complete() { if (!this.props.completing) this.emit('complete') },
    markerIcon(node, selected) {
        const glyph = node.type === 'stop' ? '◉' : node.type === 'place' ? '•' : '◒'
        return L.divIcon({ className: 'travel-pin-wrap', html: `<span class="travel-pin ${node.type} ${selected ? 'active' : ''}" aria-label="${this.escape(node.title || 'Untitled place')}">${this.markerPhoto(node)}<b class="travel-pin-glyph">${glyph}</b></span>`, iconSize: [30, 30], iconAnchor: [15, 15] })
    },
    /** Escape all user text before rendering the map pin or bubble. */
    escape(value) { return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character])) },
    blurb(node) { return String(node.description || node.notes || '').trim() },
    thumbnail(node) { return (this.props.images || []).find(image => image.nodeId === node.id && image.isPrimary)?.url || '' },
    markerPhoto(node) { const url = this.thumbnail(node); return url ? `<img class="travel-pin-photo" src="${this.escape(url)}" alt="" />` : '' },
    bindPhotoFallback(marker) { const image = marker.getElement?.()?.querySelector('.travel-pin-photo'); if (image) image.addEventListener('error', () => image.remove(), { once: true }) },
    popupHtml(node) {
        const title = this.escape(node.title || 'Untitled')
        const image = this.thumbnail(node)
        const controls = `<div class="map-tip-controls"><button class="map-tip-center" type="button" aria-label="Center the map on ${title}" title="Center and zoom here">⌖</button><button class="map-tip-expand" type="button" aria-label="Expand details for ${title}" title="All details">⤢</button><button class="map-tip-close" type="button" aria-label="Close map bubble" title="Close">×</button></div>`
        const media = image ? `<div class="map-tip-media"><img class="map-tip-photo" src="${this.escape(image)}" alt="" loading="lazy" />${controls}</div>` : ''
        const parts = [`<div class="map-tip-top"><strong>${title}</strong>${image ? '' : controls}</div>`]
        if (node.address) parts.push(`<span class="map-tip-address">${this.escape(node.address)}</span>`)
        const blurb = this.blurb(node)
        if (blurb) parts.push(`<span class="map-tip-text">${this.escape(blurb)}</span>`)
        return `<div class="map-tip">${media}<div class="map-tip-body">${parts.join('')}</div></div>`
    },
    /**
     * Wikimedia only serves pre-generated thumbnail widths, so a dead image URL must not leave an
     * empty white box. The listener sits on the popup shell in capture phase: Leaflet replaces the
     * bubble's innerHTML on update(), which would drop any listener bound to the <img> itself.
     */
    bindPopupPhoto(element) {
        if (!element) return
        const drop = photo => {
            const media = photo.closest('.map-tip-media')
            const top = element.querySelector('.map-tip-top')
            const controls = media?.querySelector('.map-tip-controls')
            photo.remove()
            if (controls && top) top.appendChild(controls)
            media?.remove()
        }
        if (element.dataset.photoBound !== '1') {
            element.dataset.photoBound = '1'
            element.addEventListener('error', event => {
                const target = event.target
                if (target instanceof HTMLImageElement && target.classList.contains('map-tip-photo')) drop(target)
            }, true)
        }
        for (const photo of element.querySelectorAll('.map-tip-photo')) if (photo.complete && !photo.naturalWidth) drop(photo)
    },
    bindPopupControls(element, marker, id) {
        if (!element) return
        // Leaflet's popup.update() replaces its inner HTML. Delegate from the stable shell.
        element.onclick = event => {
            const control = event.target.closest?.('.map-tip-controls button')
            if (!control || !element.contains(control)) return
            event.preventDefault(); event.stopPropagation()
            if (control.classList.contains('map-tip-close')) marker.closePopup()
            else if (control.classList.contains('map-tip-expand')) this.emit('expand', id)
            // Moving the map is a decision the user takes, never a side effect of opening a bubble.
            else if (control.classList.contains('map-tip-center')) { this.centerOn(this.points().find(node => node.id === id)); marker.openPopup() }
        }
    },
    draftIcon() {
        return L.divIcon({ className: 'travel-pin-wrap', html: '<span class="travel-pin draft" aria-hidden="true"></span>', iconSize: [28, 28], iconAnchor: [14, 14] })
    },
    renderPoints({ visibilityChanged = false } = {}) {
        if (!this.layer) return
        const points = this.points()
        const previous = this.knownIds || new Set()
        this.knownIds = new Set(points.map(node => node.id))
        const added = points.filter(node => !previous.has(node.id))
        // A selection coming from the rail (not from a marker click) must open that pin's bubble too;
        // the tick makes a repeated click on the same row reopen it after the bubble was closed.
        const selection = this.props.selectedId || null
        const tick = Number(this.props.selectionTick || 0)
        const selectionChanged = !!selection && (selection !== this.lastSelection || tick !== this.lastTick)
        // The flag only describes the selection change that a marker click just started: a later
        // rail click on the same place must centre again, so it is dropped as soon as it is used.
        const clickedOnMap = selectionChanged && !!selection && selection === this.mapSelectedId
        if (!clickedOnMap && selection && selection !== this.mapSelectedId) this.mapSelectedId = ''
        const chosenOutsideMap = selectionChanged && !clickedOnMap
        this.lastSelection = selection
        this.lastTick = tick
        if (chosenOutsideMap) this.popupNodeId = selection
        else if (this.popupNodeId && this.popupNodeId !== selection) this.popupNodeId = null
        if (this.popupNodeId && !this.knownIds.has(this.popupNodeId)) this.popupNodeId = null
        this.rebuildingMarkers = true
        if (this.openPopupMarker) { this.map.closePopup(); this.openPopupMarker = null }
        this.layer.clearLayers()
        this.rebuildingMarkers = false
        let selectedPopup = null
        for (const node of points) {
            const selected = node.id === this.props.selectedId
            const marker = L.marker([Number(node.lat), Number(node.lng)], { icon: this.markerIcon(node, selected), title: node.title || 'Untitled place', draggable: selected, keyboard: true })
            marker.bindPopup(this.popupHtml(node), { className: 'map-tip-popup', maxWidth: 360, minWidth: 280, closeButton: false, autoPan: true, autoPanPadding: [16, 16] })
            marker.on('popupopen', event => {
                this.openPopupMarker = marker
                const element = event.popup.getElement()
                if (element) { L.DomEvent.disableScrollPropagation(element); this.bindPopupControls(element, marker, node.id); this.bindPopupPhoto(element) }
                // The map row grows while the bubble is open; measure again after that layout change.
                requestAnimationFrame(() => { if (marker.isPopupOpen()) { this.map.invalidateSize({ pan: false }); event.popup.update() } })
            })
            marker.on('popupclose', () => {
                if (this.openPopupMarker === marker) this.openPopupMarker = null
                if (this.rebuildingMarkers) return
                if (this.popupNodeId === node.id) this.popupNodeId = null
                // The map row contracts again; bring the selected pin back into view.
                if (!this.userHasMoved) requestAnimationFrame(() => {
                    if (this.layer?.hasLayer(marker) && !marker.isPopupOpen()) { this.map.invalidateSize({ pan: false }); this.fitPoints([node]) }
                })
            })
            marker.on('click', () => {
                this.popupNodeId = node.id
                // Remembered so the re-render that follows knows this selection came from the map:
                // the pin is already under the finger, centring it would only move the viewport.
                this.mapSelectedId = node.id
                this.emit('select', node.id)
                marker.openPopup()
            })
            marker.on('dragend', () => {
                const position = marker.getLatLng()
                this.emit('movePin', { id: node.id, lat: position.lat, lng: position.lng })
            })
            marker.addTo(this.layer)
            this.bindPhotoFallback(marker)
            if (selected && this.popupNodeId === node.id) selectedPopup = marker
        }
        this.renderDraft()
        const selected = points.find(node => node.id === this.props.selectedId)
        // A brand new pin is the direct result of the user's action: show it, then keep the viewport still.
        if (!visibilityChanged && added.length === 1 && previous.size) {
            this.centerOn(added[0])
            this.lastAutoSelected = selected?.id || ''
            selectedPopup?.openPopup()
            return
        }
        // Chosen in the rail: bring the pin to the middle and let its bubble open on top.
        // Chosen in the rail: the bubble opens where the pin already is. The map only moves when the
        // pin would otherwise be off-screen, and even then it pans without touching the zoom.
        if (chosenOutsideMap && selected) {
            this.autoFitPending = false
            this.lastAutoSelected = selected.id
            this.reveal(selected, !!selectedPopup)
            selectedPopup?.openPopup()
            return
        }
        // A pin clicked on the map: the bubble is enough, the viewport stays where the user left it.
        if (clickedOnMap) {
            this.autoFitPending = false
            this.lastAutoSelected = selected?.id || ''
            selectedPopup?.openPopup()
            return
        }
        // Center once when coordinates first arrive, or for a newly selected mapped item.
        if (!this.userHasMoved && points.length && (this.autoFitPending || selected && this.lastAutoSelected !== selected.id)) {
            // A clicked marker is already visible. Let Leaflet pan its popup into view;
            // fitting the map at the same time would move the bubble back off-screen.
            if (!selectedPopup) this.fitPoints(selected ? [selected] : points)
            this.autoFitPending = false
            this.lastAutoSelected = selected?.id || ''
        }
        selectedPopup?.openPopup()
    },
    renderDraft() {
        if (!this.map) return
        if (this.draftMarker) { this.draftMarker.remove(); this.draftMarker = null }
        const draft = this.props.draftPin
        const lat = Number(draft?.lat), lng = Number(draft?.lng)
        if (!draft || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return
        this.draftMarker = L.marker([lat, lng], { icon: this.draftIcon(), interactive: false, keyboard: false, zIndexOffset: 800 })
        if (draft.title) this.draftMarker.bindTooltip(String(draft.title), { direction: 'top', offset: [0, -12], permanent: false })
        this.draftMarker.addTo(this.map)
    },
    closeTooltip() { if (this.draftMarker) this.draftMarker.closeTooltip() },
    programmatic(action) {
        this.programmaticMove = true
        action()
        const settle = () => { this.programmaticMove = false }
        this.map.once('moveend', settle)
        setTimeout(settle, 1_200)
    },
    /**
     * Bring a pin into view only if it is outside the current viewport, keeping the zoom the user
     * chose. Centring and zooming is a decision, not a side effect: the ⌖ button in the bubble does
     * it on request.
     */
    reveal(node, hasPopup) {
        const lat = Number(node?.lat), lng = Number(node?.lng)
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || !this.map) return
        const point = this.map.latLngToContainerPoint([lat, lng])
        const size = this.map.getSize()
        const margin = 40
        const visible = point.x >= margin && point.y >= margin && point.x <= size.x - margin && point.y <= size.y - margin
        if (visible) return
        // panInside moves the map just enough to put the point inside the padded box, at the same zoom.
        this.programmatic(() => this.map.panInside([lat, lng], { padding: [80, 80], animate: true }))
        if (!hasPopup) requestAnimationFrame(() => this.map.invalidateSize({ pan: false }))
    },
    centerOn(node) {
        const lat = Number(node.lat), lng = Number(node.lng)
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return
        this.programmatic(() => this.map.setView([lat, lng], Math.max(this.map.getZoom(), 13), { animate: true }))
    },
    fitPoints(points) {
        if (!points.length || !this.map) return
        // A layout change (rails, split, sheet) invalidates the size Leaflet measured at init.
        this.map.invalidateSize({ pan: false })
        const bounds = points.map(node => [Number(node.lat), Number(node.lng)])
        const selected = this.props.selectedId ? bounds.length : 0
        this.programmatic(() => this.map.fitBounds(bounds, { padding: [48, 48], maxZoom: selected ? 12 : 11 }))
    },
    fit() { this.fitPoints(this.points()) },
    cancelPick() { this.emit('cancelPick') },
    addPin() { this.emit('addPin') },
}
