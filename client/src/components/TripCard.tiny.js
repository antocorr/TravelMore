export default {
    name: 'TripCard', props: ['trip', 'disabled'], emits: ['open', 'addStop', 'delete'], 
    data() { return { menuOpen: false } },
    template() { return /*html*/`
    <article class="trip-card" :class="{ disabled: disabled }">
        <button type="button" class="trip-card-main" @click="open" :disabled="disabled" :aria-label="'Open ' + title()">
            <div class="trip-cover" :style="coverStyle()"><div x-if="!coverUrl()" class="trip-cover-fallback"><span>◒</span><strong>{{ initial() }}</strong></div><span x-if="dateBadge()" class="trip-date-badge">{{ dateBadge() }}</span></div>
            <div class="trip-card-copy"><h2>{{ title() }}</h2><p class="trip-card-date" :class="{ muted: !dateLine() }">{{ dateLine() || 'No dates yet' }}</p><p x-if="summary()" class="trip-card-meta">{{ summary() }}</p></div>
        </button>
        <div class="trip-card-menu"><button type="button" class="trip-menu-trigger" @click="toggleMenu" :disabled="disabled" :aria-expanded="menuOpen" :aria-label="'Actions for ' + title()">⋯</button><div x-if="menuOpen" class="trip-menu" role="menu"><button type="button" @click="open" role="menuitem">Open</button><button type="button" @click="addStop" role="menuitem">Add a stop</button><button type="button" class="danger" @click="remove" role="menuitem">Delete</button></div></div>
    </article>` },
    title() { return this.props.trip?.title || 'Untitled trip' },
    initial() { return this.title().trim().slice(0, 1).toUpperCase() || '◒' },
    coverUrl() { const url = this.props.trip?.cover || '';  return /^(https?:\/\/|\/media\/)/.test(url) ? url : '' },
    coverStyle() { const url = this.coverUrl(); return url ? { backgroundImage: `linear-gradient(180deg, transparent 40%, #18342a70), url("${url}")` } : {} },
    dateLine() { const start = this.props.trip?.startDate, end = this.props.trip?.endDate; if (!start && !end) return ''; const format = value => new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short' }).format(new Date(`${value.slice(0, 10)}T12:00:00`)); return start && end ? `${format(start)} – ${format(end)}` : format(start || end) },
    dateBadge() { const start = this.props.trip?.startDate; if (!start) return ''; const diff = Math.ceil((new Date(`${start.slice(0, 10)}T12:00:00`) - Date.now()) / 86_400_000); return diff < 0 ? 'Past' : diff <= 30 ? `in ${diff} days` : '' },
    summary() { const stats = this.props.trip?.stats || {}, count = (value, singular, plural) => `${value} ${value === 1 ? singular : plural}`; const bits = []; if (Number.isFinite(stats.stops)) bits.push(count(stats.stops, 'stop', 'stops')); if (Number.isFinite(stats.places)) bits.push(count(stats.places, 'place', 'places')); if (Number.isFinite(stats.openTodos)) bits.push(count(stats.openTodos, 'open todo', 'open todos')); return bits.join(' · ') },
    toggleMenu(event) { event.stopPropagation(); this.data.menuOpen.value = !this.data.menuOpen.value },
    open() { this.data.menuOpen.value = false; this.emit('open', this.props.trip) },
    addStop() { this.data.menuOpen.value = false; this.emit('addStop', this.props.trip) },
    remove() { this.data.menuOpen.value = false; if (confirm(`Delete “${this.title()}”? This cannot be undone.`)) this.emit('delete', this.props.trip) },
}
