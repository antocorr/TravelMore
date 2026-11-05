import { travel } from '../services/travel.js'
import { watchProp, collectEffects } from 'tinybubble'
import AirportPicker from './AirportPicker.tiny.js'

const DIRECTIONS = ['outbound', 'return']
const emptyForm = () => ({ origins: [], destinations: [], labels: {}, from: '', to: '', adults: 1, children: 0, ages: '', provider: 'google', maxStops: '', gl: 'IT', hl: 'en', pauseMs: 10000 })

export default {
    name: 'FlightMonitor', props: ['tripId'], components: { 'airport-picker': AirportPicker },
    data() { return { forms: { outbound: emptyForm(), return: emptyForm() }, watches: [], offers: [], runs: [], cells: [], busy: '', saving: '', error: '', notice: '', selected: '', series: [], selectedLabel: '', confirmReset: false, busy: '' } },
    template() { return /*html*/`
    <section class="flight-monitor" aria-label="Flight price monitor">
        <header class="fm-head"><div><span class="eyebrow">PRICE MONITOR</span><strong>Google Flights · prices read from the live results</strong></div><p class="fm-head-note">A run scans <b>every origin × destination × date</b> of the window. Slow on purpose: about one search every 10 seconds.</p><div class="fm-reset"><button x-if="!confirmReset" type="button" class="text-danger" @click="askReset">Clear flight data…</button><span x-if="confirmReset" class="fm-reset-actions"><span>Delete runs, prices and history of this trip?</span><button type="button" class="text-danger" @click="reset(false)" :disabled="busy === 'reset'">Yes, clear</button><button type="button" class="button-secondary" @click="reset(true)" :disabled="busy === 'reset'">Clear and forget the watch</button><button type="button" @click="cancelReset">Cancel</button></span></div></header>
        <div class="fm-cards">
            <article x-for="direction in directions()" :key="direction" class="fm-card">
                <div class="fm-card-head"><span class="fm-direction">{{ direction === 'outbound' ? 'OUTBOUND' : 'RETURN' }}</span><strong>{{ watchOf(direction) ? summaryOf(watchOf(direction)) : 'Not configured' }}</strong></div>
                <div class="fm-grid">
                    <label class="fm-field">From<airport-picker :value="forms[direction].origins" :labels="forms[direction].labels" :apply="setAirports" :direction="direction" field="origins" placeholder="City, e.g. Catania"></airport-picker></label>
                    <label class="fm-field">To<airport-picker :value="forms[direction].destinations" :labels="forms[direction].labels" :apply="setAirports" :direction="direction" field="destinations" placeholder="City, e.g. Shenzhen"></airport-picker></label>
                    <label>First date<input type="date" x-model="forms[direction].from" aria-label="First date" /></label>
                    <label>Last date<input type="date" x-model="forms[direction].to" aria-label="Last date" /></label>
                    <label>Adults<input type="number" min="1" max="9" x-model="forms[direction].adults" aria-label="Adults" /></label>
                    <label>Children<input type="number" min="0" max="8" x-model="forms[direction].children" aria-label="Children" /></label>
                    <label>Max stops<input type="number" min="0" max="3" x-model="forms[direction].maxStops" placeholder="any" aria-label="Maximum stops" /></label>
                    <label>Provider<select x-model="forms[direction].provider" aria-label="Price provider"><option value="google">Google Flights</option><option value="skyscanner">Skyscanner</option></select></label>
                    <label x-if="Number(forms[direction].children) > 0">Ages of children<input x-model="forms[direction].ages" placeholder="8, 11" aria-label="Children ages, comma separated" /></label>
                    <label>Pause (s)<input type="number" min="1" max="120" :value="Math.round(forms[direction].pauseMs / 1000)" @change="setPause(direction, $event)" aria-label="Pause between searches in seconds" /></label>
                    <label>Point of sale<input x-model="forms[direction].gl" maxlength="2" placeholder="IT" aria-label="Google point of sale, e.g. IT" /></label>
                </div>
                <p class="fm-count">{{ previewOf(direction) }}</p>
                <div class="fm-actions">
                    <button type="button" class="button-secondary" @click="save(direction)" :disabled="saving === direction">{{ saving === direction ? 'Saving…' : 'Save watch' }}</button>
                    <button type="button" class="button-primary" @click="start(direction)" :disabled="running(direction) || !watchOf(direction)">{{ running(direction) ? 'Scanning…' : 'Run ' + direction }}</button>
                    <button x-if="running(direction)" type="button" class="text-danger" @click="stop(direction)">Stop</button>
                </div>
                <div x-if="runOf(direction)" class="fm-run">
                    <div class="fm-bar"><span :style="progressStyle(runOf(direction))"></span></div>
                    <p>{{ runLabel(runOf(direction)) }}</p>
                    <ul x-if="emptyReasons(direction).length" class="fm-reasons"><li x-for="reason in emptyReasons(direction)" :key="reason.label"><b>{{ reason.count }}</b> {{ reason.label }}</li></ul>
                </div>
            </article>
        </div>
        <p x-if="notice" class="provider-ok" role="status">{{ notice }}</p>
        <p x-if="error" class="panel-error" role="alert">{{ error }}</p>
        <section x-for="direction in directions()" :key="direction + '-results'" class="fm-results">
            <header><span class="eyebrow">{{ direction.toUpperCase() }}</span><strong>{{ matrixTitle(direction) }}</strong><small x-if="watchOf(direction)" class="fm-basis">{{ cheapestNote(direction) }}</small></header>
            <div x-if="matrix(direction).dates.length" class="fm-table-wrap"><table class="fm-table"><thead><tr><th>Date</th><th x-for="route in matrix(direction).routes" :key="route.key">{{ route.origin }} → {{ route.destination }}</th></tr></thead><tbody><tr x-for="date in matrix(direction).dates" :key="date"><th scope="row">{{ shortDate(date) }}</th><td x-for="route in matrix(direction).routes" :key="route.key" class="fm-td"><button type="button" class="fm-cell" :class="{ empty: !cellFor(direction, date, route), active: isActive(direction, date, route), scanning: isScanning(direction, date, route), cheapest: isCheapest(direction, date, route) }" :title="reasonOf(direction, date, route)" @click="pick(direction, date, route)"><span x-if="isCheapest(direction, date, route)" class="fm-cheap-badge">{{ cheapestBadge(direction, date, route) }}</span><b>{{ priceOf(direction, date, route) }}</b><small>{{ detailOf(direction, date, route) }}</small></button><button type="button" class="fm-rescan" :disabled="!!busy || isScanning(direction, date, route)" :class="{ scanning: isScanning(direction, date, route) }" :title="rescanTitle(direction, route, date)" :aria-label="rescanTitle(direction, route, date)" @click="rescan(direction, route, date)">↻</button></td></tr></tbody></table></div>
            <p x-if="!matrix(direction).dates.length" class="quiet-state">{{ watchOf(direction) ? 'No observation yet: run the scan.' : 'Configure this direction to start.' }}</p>
        </section>
        <section x-if="selected" class="fm-history">
            <header><span class="eyebrow">HISTORY</span><strong>{{ selectedLabel }}</strong><small>{{ series.length }} observation{{ series.length === 1 ? '' : 's' }}</small></header>
            <div x-if="series.length > 1" class="fm-spark"><svg viewBox="0 0 240 60" role="img" :aria-label="sparkLabel()"><polyline :points="sparkPoints()" fill="none" stroke="#315c51" stroke-width="2" /></svg></div>
            <ul class="fm-series"><li x-for="point in seriesDesc()" :key="point.observedAt"><span>{{ stamp(point.observedAt) }}</span><b>€{{ point.price }}</b><em :class="{ up: point.delta > 0, down: point.delta < 0 }">{{ point.delta === null ? 'first' : (point.delta > 0 ? '+' : '') + point.delta }}</em></li></ul>
            <p x-if="series.length === 1" class="quiet-state">Only one observation so far: history appears when the price changes on a later refresh.</p>
        </section>
    </section>` },
    init() {
        this.tripEpoch = 0; this.poller = null
        this.resetTrip()
        this.propDisposers = collectEffects(() => watchProp(this, 'tripId', () => this.resetTrip()))
    },
    beforeDestroy() { clearTimeout(this.poller); this.propDisposers?.forEach(dispose => dispose()) },
    directions() { return DIRECTIONS },
    resetTrip() {
        this.tripEpoch++
        clearTimeout(this.poller)
        this.data.watches.value = []; this.data.offers.value = []; this.data.runs.value = []; this.data.cells.value = []
        this.data.forms.value = { outbound: emptyForm(), return: emptyForm() }
        this.seeded = {}
        this.data.selected.value = ''; this.data.series.value = []; this.data.error.value = ''; this.data.notice.value = ''; this.data.busy.value = ''; this.data.saving.value = ''
        if (this.props.tripId) void this.load()
    },
    watchOf(direction) { return this.data.watches.value.find(watch => watch.direction === direction) || null },
    runOf(direction) { return this.data.runs.value.find(run => run.direction === direction) || null },
    running(direction) { return this.runOf(direction)?.status === 'running' },
    nameOf(watch, code) { return watch?.labels?.[code] || code },
    summaryOf(watch) {
        const pax = `${watch.adults} adult${watch.adults === 1 ? '' : 's'}${watch.children ? `, ${watch.children} child${watch.children === 1 ? '' : 'ren'}` : ''}`
        const places = list => list.map(code => this.nameOf(watch, code)).join(' / ')
        return `${places(watch.origins)} → ${places(watch.destinations)} · ${watch.from} til ${watch.to} · ${pax}`
    },
    previewOf(direction) {
        const watch = this.watchOf(direction)
        if (!watch) return 'No watch configured for this direction.'
        const cells = watch.origins.length * watch.destinations.length * (Math.round((Date.parse(watch.to) - Date.parse(watch.from)) / 86_400_000) + 1)
        const minutes = Math.max(1, Math.round(cells * (watch.pauseMs + 1500) / 60_000))
        return `${cells} searches · about ${minutes} min · pause ${Math.round(watch.pauseMs / 1000)}s`
    },
    setPause(direction, event) {
        const seconds = Number(event.target.value)
        this.data.forms.value = { ...this.data.forms.value, [direction]: { ...this.data.forms.value[direction], pauseMs: Math.max(1, Math.min(120, seconds || 10)) * 1000 } }
    },
    async load() {
        const tripId = this.props.tripId, epoch = this.tripEpoch
        if (!tripId) return
        try {
            const [list, overview] = await Promise.all([travel.listFlightWatches(tripId), travel.flightOverview(tripId)])
            if (epoch !== this.tripEpoch || this.props.tripId !== tripId) return
            this.data.watches.value = list.watches || []
            this.data.runs.value = list.runs || []
            this.data.offers.value = overview.offers || []
            this.data.cells.value = overview.cells || []
            // Seed a card from its saved watch only when that watch changes: a poll during a running
            // scan must never overwrite what the user is editing.
            this.seeded = this.seeded || {}
            const nextForms = { ...this.data.forms.value }
            for (const direction of DIRECTIONS) {
                const watch = (list.watches || []).find(item => item.direction === direction)
                if (!watch) { nextForms[direction] = nextForms[direction] || emptyForm(); continue }
                if (this.seeded[direction] === watch.updatedAt) continue
                this.seeded[direction] = watch.updatedAt
                nextForms[direction] = { origins: [...watch.origins], destinations: [...watch.destinations], labels: { ...(watch.labels || {}) }, from: watch.from, to: watch.to, adults: watch.adults, children: watch.children || 0, ages: (watch.childrenAges || []).join(', '), provider: watch.provider || 'google', maxStops: watch.maxStops === null ? '' : watch.maxStops, gl: watch.gl || 'IT', hl: watch.hl || 'en', pauseMs: watch.pauseMs }
            }
            this.data.forms.value = nextForms
            if (this.data.selected.value) await this.loadHistory(this.data.selected.value)
            if ((list.runs || []).some(run => run.status === 'running')) this.schedulePoll()
        } catch (error) { if (epoch === this.tripEpoch) this.data.error.value = error.message }
    },
    askReset() { this.data.confirmReset.value = true },
    cancelReset() { this.data.confirmReset.value = false },
    async reset(forgetWatch) {
        const tripId = this.props.tripId
        if (!tripId) return
        this.data.busy.value = 'reset'; this.data.error.value = ''; this.data.notice.value = ''
        try {
            const result = await travel.resetFlightData(tripId, forgetWatch)
            const cleared = result?.cleared || {}
            this.data.notice.value = `Cleared ${cleared.runs || 0} runs, ${cleared.offers || 0} prices and ${cleared.prices || 0} history points${forgetWatch ? ', watch removed' : ''}.`
            this.data.confirmReset.value = false
            this.data.selected.value = ''; this.data.series.value = []
            if (forgetWatch) { this.data.forms.value = { ...this.data.forms.value, [this.data.runs.value[0]?.direction || 'outbound']: emptyForm() }; this.seeded = {} }
            await this.load()
        } catch (error) { this.data.error.value = error.message }
        finally { if (this.tripEpoch) this.data.busy.value = '' }
    },
    setAirports(direction, field, change) {
        const form = this.data.forms.value[direction]
        const current = Array.isArray(form[field]) ? form[field] : []
        let codes = current, labels = { ...form.labels }
        if (change?.add) {
            codes = this.data.forms.value[direction] && form.singleLimit ? [change.add] : [...current.filter(code => code !== change.add), change.add]
            if (change.label) labels[change.code || change.add] = change.label
        } else if (change?.remove) codes = current.filter(code => code !== change.remove)
        else if (Array.isArray(change)) codes = change
        this.data.forms.value = { ...this.data.forms.value, [direction]: { ...form, [field]: codes, labels } }
    },
    async save(direction) {
        const tripId = this.props.tripId, form = this.data.forms.value[direction]
        if (!tripId) return
        const origins = Array.isArray(form.origins) ? form.origins : [], destinations = Array.isArray(form.destinations) ? form.destinations : []
        if (!origins.length || !destinations.length || !form.from || !form.to) { this.data.error.value = 'Pick at least one origin, one destination and both dates.'; return }
        this.data.saving.value = direction; this.data.error.value = ''; this.data.notice.value = ''
        try {
            const ages = String(form.ages || '').split(',').map(value => Number(value.trim())).filter(value => Number.isInteger(value) && value >= 0 && value <= 17)
            await travel.saveFlightWatch({ tripId, direction, origins, destinations, labels: form.labels, provider: form.provider || 'google', childrenAges: ages, from: form.from, to: form.to, adults: Number(form.adults) || 1, children: Number(form.children) || 0, maxStops: form.maxStops === '' ? null : Number(form.maxStops), gl: String(form.gl || '').toUpperCase(), hl: form.hl || 'en', pauseMs: form.pauseMs })
            this.data.notice.value = `${direction} watch saved.`
            await this.load()
        } catch (error) { this.data.error.value = error.message }
        finally { if (this.tripEpoch) this.data.saving.value = '' }
    },
    async start(direction) {
        const tripId = this.props.tripId
        if (!tripId || this.running(direction)) return
        this.data.error.value = ''; this.data.notice.value = ''
        try { await travel.startFlightScan(tripId, direction); await this.load(); this.schedulePoll() }
        catch (error) { this.data.error.value = error.message }
    },
    async stop(direction) { try { await travel.cancelFlightScan(this.props.tripId); await this.load() } catch (error) { this.data.error.value = error.message } },
    schedulePoll() {
        clearTimeout(this.poller)
        const epoch = this.tripEpoch
        this.poller = setTimeout(async () => {
            if (!this.props.tripId || epoch !== this.tripEpoch) return
            await this.load()
            if (epoch === this.tripEpoch && this.data.runs.value.some(run => run.status === 'running')) this.schedulePoll()
        }, 1500)
    },
    progressStyle(run) { const ratio = run.cellsTotal ? Math.min(1, run.cellsDone / run.cellsTotal) : 0; return `width:${Math.round(ratio * 100)}%` },
    runLabel(run) {
        const status = run.status === 'running' ? `${run.cellsDone}/${run.cellsTotal} searches` : run.status
        return `${status} · ${run.observed} priced · ${run.empty} empty · ${run.failed} failed${run.message ? ` · ${run.message}` : ''}`
    },
    /**
     * Built from the watch, not from the offers: an empty cell must be visible with its reason.
     * Columns are the routes (origins × destinations): with two origins and one destination there are
     * two columns, otherwise the two prices would collapse into one and one of them would look missing.
     */
    matrix(direction) {
        const watch = this.watchOf(direction)
        const offers = this.data.offers.value.filter(offer => offer.direction === direction)
        if (!watch) {
            const dates = [...new Set(offers.map(offer => offer.date))].sort()
            const routes = [...new Set(offers.map(offer => `${offer.origin}|${offer.destination}`))].sort().map(key => { const [origin, destination] = key.split('|'); return { origin, destination, key } })
            return { dates, routes }
        }
        const dates = []
        for (let at = Date.parse(`${watch.from}T00:00:00Z`); at <= Date.parse(`${watch.to}T00:00:00Z`); at += 86_400_000) dates.push(new Date(at).toISOString().slice(0, 10))
        const routes = []
        for (const origin of watch.origins) for (const destination of watch.destinations) routes.push({ origin, destination, key: `${origin}|${destination}` })
        return { dates, routes }
    },
    /** A cell key is `direction|origin|destination|date`: compare the parts, never a shortened string. */
    failureOf(direction, date, route) {
        const run = this.runOf(direction)
        const wantedOrigin = String(route.origin).toUpperCase(), wantedDestination = String(route.destination).toUpperCase()
        return (run?.failures || []).find(item => {
            const [dir, origin, destination, day] = String(item.cellKey).split('|')
            return dir === direction && origin === wantedOrigin && destination === wantedDestination && day === date
        }) || null
    },
    reasonOf(direction, date, route) {
        const failure = this.failureOf(direction, date, route)
        return failure?.message || ''
    },
    /** The distinct reasons behind "N empty", so the run explains itself. */
    emptyReasons(direction) {
        const run = this.runOf(direction)
        const groups = new Map()
        for (const item of run?.failures || []) {
            if (item.status === 'blocked') continue
            const label = item.message.replace(/for \d{4}-\d{2}-\d{2}/, 'for this date')
            groups.set(label, (groups.get(label) || 0) + 1)
        }
        return [...groups.entries()].map(([label, count]) => ({ label, count }))
    },
    matrixTitle(direction) {
        const { dates } = this.matrix(direction)
        return dates.length ? `${dates.length} date${dates.length === 1 ? '' : 's'} observed` : 'No observations yet'
    },
    /** true while the running scan is on this cell: the border elsewhere in the grid animates. */
    isScanning(direction, date, route) {
        const run = this.runOf(direction)
        if (!run || run.status !== 'running' || !run.currentCellKey) return false
        return run.currentCellKey === `${direction}|${route.origin}|${route.destination}|${date}`
    },
    isActive(direction, date, route) { return !!this.data.selected.value && this.data.selected.value === (this.offerFor(direction, date, route)?.cellKey || '') },
    offerFor(direction, date, route) { return this.data.offers.value.find(offer => offer.direction === direction && offer.date === date && offer.origin === route.origin && offer.destination === route.destination) || null },
    priceOf(direction, date, route) { const offer = this.offerFor(direction, date, route); return offer ? `€${offer.price}` : '—' },
    /** Which fare the price is, and for how many people: both matter when comparing with Google. */
    /** "3 min" / "2 h" / "1 d": a price is only meaningful together with its age. */
    ageOf(value) {
        if (!value) return ''
        const seconds = Math.max(0, (Date.now() - Date.parse(value)) / 1000)
        if (!Number.isFinite(seconds)) return ''
        if (seconds < 90) return 'just now'
        const minutes = Math.round(seconds / 60)
        if (minutes < 60) return `${minutes} min old`
        const hours = Math.round(minutes / 60)
        return hours < 48 ? `${hours} h old` : `${Math.round(hours / 24)} d old`
    },
    cheapestNote(direction) {
        const watch = this.watchOf(direction)
        if (!watch) return ''
        const stops = watch.maxStops === null || watch.maxStops === undefined ? 'cheapest fare' : `cheapest with ≤${watch.maxStops} stop${watch.maxStops === 1 ? '' : 's'}`
        return `${stops} · total for ${this.partyOf(watch)}`
    },
    partyOf(watch) {
        const adults = `${watch.adults} adult${watch.adults === 1 ? '' : 's'}`
        return watch.children ? `${adults} + ${watch.children} child${watch.children === 1 ? '' : 'ren'}` : adults
    },
    /**
     * The cheapest cell of each search group: a route is the group whose dates you compare, so each
     * column gets its own winner. Ties are all flagged, because choosing is the reader's job.
     */
    cheapestOf(direction, route) {
        const group = this.data.offers.value.filter(offer => offer.direction === direction && offer.origin === route.origin && offer.destination === route.destination && offer.price > 0)
        if (!group.length) return 0
        return Math.min(...group.map(offer => offer.price))
    },
    isCheapest(direction, date, route) {
        const offer = this.offerFor(direction, date, route)
        if (!offer) return false
        // Nothing to be cheapest of when a route has a single price: a badge on every cell says nothing.
        const group = this.data.offers.value.filter(item => item.direction === direction && item.origin === route.origin && item.destination === route.destination && item.price > 0)
        if (new Set(group.map(item => item.price)).size < 2) return false
        return offer.price > 0 && offer.price === this.cheapestOf(direction, route)
    },
    /** The badge says "best" on its own, and "least of all" when the column also wins the direction. */
    cheapestBadge(direction, date, route) {
        const price = this.cheapestOf(direction, route)
        const directionPrices = this.data.offers.value.filter(offer => offer.direction === direction && offer.price > 0).map(offer => offer.price)
        const overall = directionPrices.length ? Math.min(...directionPrices) : 0
        return price && price === overall ? 'cheapest overall' : 'cheapest'
    },
    detailOf(direction, date, route) {
        if (this.isScanning(direction, date, route)) return 'scanning…'
        const offer = this.offerFor(direction, date, route)
        if (offer) {
            // A price declared by Google without a listed itinerary must not borrow another fare's details.
            const base = offer.priceSource === 'header'
                ? `cheapest fare declared by ${offer.provider === 'skyscanner' ? 'Skyscanner' : 'Google'}`
                : `${offer.airline || 'airline?'} · ${offer.stops} stop${offer.stops === 1 ? '' : 's'}`
            // A total for three travellers is not comparable with a single fare: say the per-person price.
            const perTraveller = offer.travellers > 1 && offer.perTraveller ? ` · €${Math.round(offer.perTraveller)} pp` : ''
            const age = this.ageOf(offer.observedAt)
            const cheapest = offer.options > 1 ? ` · cheapest of ${offer.options}` : ''
            return `${base}${perTraveller}${cheapest}${age ? ` · ${age}` : ''}`
        }
        const failure = this.failureOf(direction, date, route)
        if (failure) return failure.status === 'blocked' ? 'provider blocked' : failure.status === 'failed' ? 'scan failed' : 'no flights'
        return this.watchOf(direction) ? 'not scanned' : 'no data'
    },
    cellFor(direction, date, route) { return this.offerFor(direction, date, route) },
    shortDate(date) { return date ? date.slice(5) : '' },
    stamp(value) { return value ? value.replace('T', ' ').slice(0, 16) : '' },
    rescanTitle(direction, route, date) {
        if (this.isScanning(direction, date, route)) return 'Scanning this cell…'
        return 'Search this cell again: ' + route.origin + ' → ' + route.destination + ' on ' + date
    },
    /** Refresh this single cell: one search, no other cell touched. */
    async rescan(direction, route, date) {
        const tripId = this.props.tripId
        if (!tripId || this.data.busy.value || this.running(direction)) return
        const cellKey = `${direction}|${route.origin}|${route.destination}|${date}`
        this.data.busy.value = `cell:${cellKey}`
        this.data.error.value = ''; this.data.notice.value = ''
        try {
            const run = await travel.rescanFlightCell(tripId, cellKey)
            this.data.runs.value = [...this.data.runs.value.filter(item => item.direction !== direction), run]
            this.data.notice.value = `Rechecking ${route.origin} → ${route.destination} on ${date}…`
            await this.load(); this.schedulePoll()
        } catch (error) {
            this.data.error.value = String(error?.message || error)
        } finally {
            this.data.busy.value = ''
        }
    },

    async pick(direction, date, route) {
        const offer = this.offerFor(direction, date, route)
        const key = offer?.cellKey || ''
        this.data.selectedLabel.value = `${route.origin} → ${route.destination} · ${date}`
        this.data.selected.value = key || ' '
        if (key) await this.loadHistory(key)
        else this.data.series.value = []
    },
    async loadHistory(cellKey) {
        try {
            const result = await travel.flightHistory(this.props.tripId, cellKey)
            this.data.series.value = (result.series || []).map((point, index, list) => ({ ...point, delta: index ? Math.round((point.price - list[index - 1].price) * 100) / 100 : null }))
        } catch (error) { this.data.error.value = error.message }
    },
    seriesDesc() { return [...this.data.series.value].reverse() },
    sparkPoints() {
        const series = this.data.series.value
        if (series.length < 2) return ''
        const prices = series.map(point => point.price), min = Math.min(...prices), max = Math.max(...prices), span = max - min || 1
        return series.map((point, index) => `${Math.round((index / (series.length - 1)) * 236) + 2},${Math.round(56 - ((point.price - min) / span) * 50)}`).join(' ')
    },
    sparkLabel() { const series = this.data.series.value; return series.length ? `Price from €${series[0].price} to €${series[series.length - 1].price}` : 'No history' },
}
