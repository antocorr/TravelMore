import { watchProp, collectEffects } from 'tinybubble'

export default {
    name: 'TripTree', props: ['rows', 'selectedId', 'tripId', 'loading', 'collapsedStopIds'], emits: ['select', 'create', 'collapseChange'],
    init() { this.propDisposers = collectEffects(() => watchProp(this, 'selectedId', id => this.revealSelected(id))) },
    beforeDestroy() { this.propDisposers?.forEach(dispose => dispose()) },
    template() { return /*html*/`
    <nav class="trip-tree panel" aria-label="Trip itinerary">
        <div class="panel-kicker"><span>STOPS</span><span>{{ entryLabel() }}</span></div>
        <div x-if="collapsibleIds().length" class="tree-bulk-actions"><button type="button" @click="expandAll" :disabled="!collapsedStopIds.length">Expand all</button><button type="button" @click="collapseAll" :disabled="!canCollapseAll()">Collapse all</button></div>
        <div class="tree-scroll" role="tree" aria-busy="loading">
            <p x-if="loading" class="quiet-state">Opening this itinerary…</p>
            <div x-for="row in visibleRows()" :key="row.id" class="tree-entry" :class="{ selected: selectedId === row.id }" :style="{ paddingLeft: (16 + row.depth * 17) + 'px' }" role="treeitem" :aria-selected="selectedId === row.id" :aria-level="row.depth + 1" :aria-expanded="row.hasChildren ? !isCollapsed(row.id) : null">
                <button class="tree-label" type="button" :aria-expanded="row.hasChildren ? !isCollapsed(row.id) : null" @click="choose(row)">
                    <span class="tree-glyph" :class="row.type">{{ iconFor(row.type) }}</span>
                    <span class="tree-copy"><strong>{{ row.title || 'Untitled' }}</strong><small>{{ subtitleFor(row) }}</small></span>
                    <span x-if="row.childCount" class="tree-child-count" :aria-label="row.childCount + ' children'">{{ row.childCount }}</span>
                </button>
                <button x-if="row.hasChildren" class="tree-toggle" type="button" :aria-expanded="!isCollapsed(row.id)" :aria-label="(isCollapsed(row.id) ? 'Expand ' : 'Collapse ') + (row.title || 'stop')" @click="toggleStop(row.id)">{{ isCollapsed(row.id) ? '▾' : '▴' }}</button>
            </div>
            <div x-if="!loading && rows.length === 0" class="empty-tree"><span>◎</span><strong>No stops yet.</strong><p>Add the first place you want to remember, or ask the planner to shape the trip.</p></div>
        </div>
        <button type="button" class="tree-create" @click="createStop">＋ Add stop</button>
    </nav>` },
    choose(row) {
        if (row.hasChildren) this.toggleStop(row.id)
        this.emit('select', row.id)
    },
    isCollapsed(id) { return (this.props.collapsedStopIds || []).includes(id) },
    collapsibleIds() {
        const rows = this.props.rows || [], parents = new Set(rows.map(row => row.parentId))
        return rows.filter(row => row.type === 'stop' && parents.has(row.id)).map(row => row.id)
    },
    canCollapseAll() { return this.collapsibleIds().some(id => !this.isCollapsed(id)) },
    expandAll() { this.emit('collapseChange', []) },
    collapseAll() { this.emit('collapseChange', this.collapsibleIds()) },
    toggleStop(id) {
        const collapsed = this.props.collapsedStopIds || []
        this.emit('collapseChange', collapsed.includes(id) ? collapsed.filter(item => item !== id) : [...collapsed, id])
    },
    visibleRows() {
        const rows = this.props.rows || [], children = new Map()
        for (const row of rows) if (row.parentId) children.set(row.parentId, (children.get(row.parentId) || 0) + 1)
        const hidden = new Set(), collapsed = new Set(this.props.collapsedStopIds || [])
        return rows.flatMap(row => {
            if (hidden.has(row.parentId) || collapsed.has(row.parentId)) { hidden.add(row.id); return [] }
            const childCount = row.type === 'stop' ? children.get(row.id) || 0 : 0
            return [{ ...row, childCount, hasChildren: childCount > 0 }]
        })
    },
    revealSelected(id) {
        const collapsed = this.props.collapsedStopIds || []
        if (!id || !collapsed.length) return
        const parents = new Map((this.props.rows || []).map(row => [row.id, row.parentId]))
        const ancestors = new Set()
        for (let parent = parents.get(id); parent && !ancestors.has(parent); parent = parents.get(parent)) ancestors.add(parent)
        const remaining = collapsed.filter(item => !ancestors.has(item))
        if (remaining.length !== collapsed.length) this.emit('collapseChange', remaining)
    },
    createStop() { if (this.props.tripId) this.emit('create', { parentId: this.props.tripId, type: 'stop' }) },
    entryLabel() { const count = (this.props.rows || []).filter(row => row.type !== 'trip').length; return `${count} ${count === 1 ? 'entry' : 'entries'}` },
    iconFor(type) { return type === 'trip' ? '◒' : type === 'place' ? '◇' : '—' },
    subtitleFor(row) {
        if (row.type === 'trip') { const range = [row.startDate, row.endDate].filter(Boolean).map(value => this.shortDate(value)); return range.join(' – ') || 'Trip' }
        return [row.type === 'place' ? 'Place' : 'Stop', row.startDate ? this.shortDate(row.startDate) : ''].filter(Boolean).join(' · ')
    },
    shortDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value).slice(0, 10) : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) },
}
