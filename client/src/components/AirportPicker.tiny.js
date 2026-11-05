import { travel } from '../services/travel.js'

/** City names or codes, never a bare IATA code on screen: "Shenzhen (SZX)". */
export default {
    name: 'AirportPicker', props: ['value', 'labels', 'placeholder', 'single', 'apply', 'direction', 'field'],
    data() { return { query: '', suggestions: [], open: false, busy: false, error: '', active: -1 } },
    template() { return /*html*/`
    <div class="airport-picker">
        <div class="airport-chips"><span x-for="code in chosen()" :key="code" class="airport-chip"><b>{{ labelOf(code) }}</b><button type="button" @click="remove(code)" :aria-label="'Remove ' + labelOf(code)" title="Remove">×</button></span></div>
        <input ref="field" type="text" role="combobox" :aria-expanded="open ? 'true' : 'false'" aria-autocomplete="list" autocomplete="off" :value="query" :placeholder="placeholder || (single ? 'City or code, e.g. Shenzhen' : 'Add a city or code, e.g. Shenzhen')" @input="typed($event)" @keydown="key($event)" @focus="query && search()" @blur="blur" />
        <ul x-if="open && suggestions.length" class="airport-options" role="listbox"><li x-for="(item, index) in suggestions" :key="item.code"><button type="button" role="option" :class="{ active: index === active }" @mousedown.prevent="pick(item)"><b>{{ item.label }}</b><small>{{ item.name }}<span x-if="item.country"> · {{ item.country }}</span></small></button></li></ul>
        <p x-if="error" class="airport-error" role="alert">{{ error }}</p>
    </div>` },
    chosen() { return Array.isArray(this.props.value) ? this.props.value : [] },
    labelOf(code) { return this.props.labels?.[code] || code },
    typed(event) { this.data.query.value = event?.target?.value ?? ''; this.data.active.value = -1; clearTimeout(this.timer); if (this.data.query.value.trim().length < 2) { this.data.suggestions.value = []; this.data.open.value = false; return } this.timer = setTimeout(() => void this.search(), 180) },
    async search() {
        const query = this.data.query.value.trim()
        if (query.length < 2) return
        this.data.busy.value = true
        try {
            const result = await travel.searchAirports(query, 6)
            if (this.data.query.value.trim() !== query) return
            this.data.suggestions.value = (result.suggestions || []).filter(item => !this.chosen().includes(item.code))
            this.data.open.value = true
            this.data.active.value = this.data.suggestions.value.length ? 0 : -1
            this.data.error.value = ''
        } catch (error) { this.data.error.value = error.message }
        finally { this.data.busy.value = false }
    },
    key(event) {
        if (event.key === 'Escape') { this.data.open.value = false; return }
        if (event.key === 'Enter') {
            const item = this.data.suggestions.value[this.data.active.value]
            if (this.data.open.value && item) { event.preventDefault(); this.pick(item) }
            return
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            if (!this.data.suggestions.value.length) return
            event.preventDefault()
            const delta = event.key === 'ArrowDown' ? 1 : -1
            const size = this.data.suggestions.value.length
            this.data.active.value = (this.data.active.value + delta + size) % size
        }
    },
    /** The parent owns the list: the picker only asks for a change, so props can never go stale. */
    pick(item) {
        if (!item) return
        this.data.query.value = ''; this.data.suggestions.value = []; this.data.open.value = false; this.data.error.value = ''
        if (this.refs.field) this.refs.field.value = ''
        this.props.apply?.(this.props.direction, this.props.field, { add: item.code, label: item.label })
    },
    remove(code) { this.props.apply?.(this.props.direction, this.props.field, { remove: code }) },
    /** Blur must not eat a click on a suggestion: mousedown already prevented the default. */
    blur() { setTimeout(() => { this.data.open.value = false }, 140) },
}
