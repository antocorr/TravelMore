import { watchProp, collectEffects } from 'tinybubble'
import { travel } from '../services/travel.js'

const DEBOUNCE_MS = 320
const MIN_QUERY = 2

/** Place autocomplete backed by the server's OpenStreetMap geocoder.
 * The field stays usable when the provider is unavailable: the parent can still
 * type a name and place the pin manually. */
export default {
    name: 'PlaceAutocomplete',
    props: ['value', 'label', 'placeholder', 'inputId', 'disabled', 'autofocus', 'near', 'hint'],
    emits: ['input', 'pick'],
    data() {
        return { uid: `place-${Math.random().toString(36).slice(2, 9)}`, suggestions: [], status: 'idle', activeIndex: -1, open: false, message: '' }
    },
    template() { return /*html*/`
    <div class="place-field">
        <label class="place-label" :for="inputId || uid">{{ label || 'Search a place' }}</label>
        <div class="place-search">
            <span class="place-icon" aria-hidden="true">⌖</span>
            <input ref="input" :id="inputId || uid" type="text" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" :aria-expanded="open ? 'true' : 'false'" :aria-controls="listId()" :aria-activedescendant="activeOptionId()" :disabled="disabled" :placeholder="placeholder || 'Search a place or address'" @input="onInput" @keydown="onKeydown" @focus="onFocus" @blur="onBlur" />
            <span x-if="status === 'loading'" class="place-spinner" aria-hidden="true"></span>
            <button x-if="value && !disabled" type="button" class="place-clear" @click="clear" aria-label="Clear place search">×</button>
        </div>
        <ul x-if="open" :id="listId()" class="place-results" role="listbox" aria-label="Place suggestions">
            <li x-for="(item, index) in suggestions" :key="item.id" :id="optionId(index)" role="option" :aria-selected="index === activeIndex ? 'true' : 'false'">
                <button type="button" class="place-option" :class="{ active: index === activeIndex }" @mouseenter="activate(index)" @mousedown.prevent="choose(index)" @click="choose(index)">
                    <strong>{{ item.name }}</strong>
                    <small>{{ placeMeta(item) }}</small>
                </button>
            </li>
            <li x-if="message" class="place-message" role="status">{{ message }}</li>
            <li x-if="suggestions.length" class="place-source">Search by OpenStreetMap · {{ suggestions.length }} matches</li>
        </ul>
        <p x-if="hint && !open" class="place-hint">{{ hint }}</p>
    </div>` },
    init() {
        this.alive = true
        this.seq = 0
        const input = this.refs.input
        if (input) input.value = typeof this.props.value === 'string' ? this.props.value : ''
        this.propDisposers = collectEffects(() => watchProp(this, 'value', next => {
            const field = this.refs.input
            if (!field) return
            const text = typeof next === 'string' ? next : ''
            if (field.value !== text) field.value = text
        }))
    },
    mounted() {
        if (this.props.autofocus) requestAnimationFrame(() => { if (this.alive) this.refs.input?.focus() })
    },
    beforeDestroy() {
        this.alive = false
        this.seq++
        clearTimeout(this.timer)
        this.propDisposers?.forEach(dispose => dispose())
    },
    listId() { return `${this.data.uid.value}-results` },
    optionId(index) { return `${this.data.uid.value}-option-${index}` },
    activeOptionId() { const index = this.data.activeIndex.value; return index >= 0 ? this.optionId(index) : null },
    placeMeta(place) {
        const display = place.displayName || '', name = place.name || ''
        const rest = display.startsWith(name) ? display.slice(name.length).replace(/^[\s,]+/, '') : display
        return rest || place.type || place.category || 'Place'
    },
    onInput(value) {
        this.emit('input', value)
        this.schedule(value)
    },
    schedule(value) {
        clearTimeout(this.timer)
        const query = String(value || '').trim()
        if (this.props.disabled) return
        if (query.length < MIN_QUERY) { this.reset(); return }
        this.data.status.value = 'loading'
        this.data.message.value = ''
        this.data.open.value = true
        const seq = this.seq
        this.timer = setTimeout(() => { if (this.alive && seq === this.seq) void this.search(query) }, DEBOUNCE_MS)
    },
    async search(query) {
        const seq = ++this.seq
        try {
            const near = this.props.near
            const response = await travel.searchPlaces({ query, limit: 6, near: near && Number.isFinite(Number(near.lat)) ? { lat: Number(near.lat), lng: Number(near.lng) } : undefined })
            if (!this.alive || seq !== this.seq) return
            if (response?.status !== 'observed') {
                this.data.suggestions.value = []
                this.data.status.value = 'unavailable'
                this.data.message.value = response?.message || 'Place search is unavailable right now.'
                this.data.open.value = true
                return
            }
            const results = Array.isArray(response.results) ? response.results : []
            this.data.suggestions.value = results
            this.data.status.value = results.length ? 'ready' : 'empty'
            this.data.message.value = results.length ? '' : 'No matching place. Try a city, address or landmark.'
            this.data.activeIndex.value = -1
            this.data.open.value = true
        } catch (error) {
            if (!this.alive || seq !== this.seq) return
            this.data.suggestions.value = []
            this.data.status.value = 'error'
            this.data.message.value = error?.message || 'Place search failed.'
            this.data.open.value = true
        }
    },
    reset() {
        this.seq++
        this.data.suggestions.value = []
        this.data.status.value = 'idle'
        this.data.activeIndex.value = -1
        this.data.message.value = ''
        this.data.open.value = false
    },
    close() { this.data.open.value = false; this.data.activeIndex.value = -1 },
    activate(index) { if (this.data.suggestions.value[index]) this.data.activeIndex.value = index },
    choose(index) {
        const place = this.data.suggestions.value[index]
        if (!place) return
        const field = this.refs.input
        if (field) field.value = place.name
        this.reset()
        this.emit('input', place.name)
        this.emit('pick', place)
    },
    clear() {
        const field = this.refs.input
        if (field) { field.value = ''; field.focus() }
        this.reset()
        this.emit('input', '')
    },
    onFocus() { if (this.data.suggestions.value.length) this.data.open.value = true },
    onBlur() { this.close() },
    onKeydown(event) {
        const key = event.key
        if (key === 'ArrowDown' || key === 'ArrowUp') {
            const total = this.data.suggestions.value.length
            if (!total) {
                const typed = this.refs.input?.value || ''
                if (!this.data.open.value && typed.trim().length >= MIN_QUERY) this.schedule(typed)
                return
            }
            event.preventDefault()
            const current = this.data.activeIndex.value
            this.data.activeIndex.value = key === 'ArrowDown' ? (current + 1) % total : (current <= 0 ? total - 1 : current - 1)
            this.data.open.value = true
            return
        }
        if (key === 'Enter') { if (this.data.open.value && this.data.activeIndex.value >= 0) { event.preventDefault(); this.choose(this.data.activeIndex.value) } return }
        if (key === 'Escape' && this.data.open.value) { event.preventDefault(); this.close() }
        if (key === 'Tab') this.close()
    },
}
