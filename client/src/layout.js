export const LAYOUT_DEFAULTS = Object.freeze({ left: 270, right: 350, split: 40 })
export const LAYOUT_LIMITS = Object.freeze({
    left: Object.freeze({ min: 210, max: 420 }),
    right: Object.freeze({ min: 280, max: 520 }),
    split: Object.freeze({ min: 25, max: 70 }),
    centerMin: 480,
})

const STORAGE_KEY = 'travelmore.layout.v1'
const DEBOUNCE_MS = 150
let pending = null
let timer = null

const clamp = (value, limits) => Math.min(limits.max, Math.max(limits.min, value))
const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback
const normalise = value => ({
    left: Math.round(clamp(number(value?.left, LAYOUT_DEFAULTS.left), LAYOUT_LIMITS.left)),
    right: Math.round(clamp(number(value?.right, LAYOUT_DEFAULTS.right), LAYOUT_LIMITS.right)),
    split: Math.round(clamp(number(value?.split, LAYOUT_DEFAULTS.split), LAYOUT_LIMITS.split) * 100) / 100,
})

function readStored() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') } catch { return null }
}
function persist(value) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)) } catch { /* private mode or storage quota: layout remains usable for this page */ }
}

/** Read a safe, clamped layout even when prior storage is missing or malformed. */
export function readLayout() {
    if (pending) return { ...pending }
    return normalise(readStored())
}

/** Merge a patch and persist it after a short drag-friendly debounce. */
export function writeLayout(patch = {}) {
    pending = normalise({ ...readLayout(), ...patch })
    clearTimeout(timer)
    timer = setTimeout(() => { persist(pending); pending = null; timer = null }, DEBOUNCE_MS)
    return { ...pending }
}

/** Persist a pending drag synchronously at its end. */
export function flushLayout() {
    if (!pending) return
    clearTimeout(timer)
    persist(pending)
    pending = null
    timer = null
}

/** Restore defaults immediately. */
export function resetLayout() {
    const layout = normalise(LAYOUT_DEFAULTS)
    pending = layout
    flushLayout()
    return layout
}
