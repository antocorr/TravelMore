import type { TripNode } from '../types.js';
import { TravelService } from './travel.js';
import { PlaceGeocoder, placeGeocoder } from './geocode.js';
import { PlaceInfoService, placeInfoService } from './placeInfo.js';

/** Group prefixes and commentary tails make a title unsearchable: "G1 · Museum — skyline views". */
export function searchableTitle(title: string) {
  return String(title || '')
    .replace(/^\s*[A-Z]{1,2}\d{1,3}\s*[·:.\-–—]\s*/, '')
    .split(/\s+[—–]\s+/)[0]
    .replace(/\s*\([^)]*$/, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** A geocoder match on the other side of the country is a wrong match, not a long walk. */
const MAX_HINT_DISTANCE_KM = 120;
function distanceKm(from: { lat: number; lng: number }, to: { lat: number; lng: number }) {
  const rad = (value: number) => value * Math.PI / 180;
  const dLat = rad(to.lat - from.lat), dLng = rad(to.lng - from.lng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(from.lat)) * Math.cos(rad(to.lat)) * Math.sin(dLng / 2) ** 2;
  return 6_371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export type CompletionResult = { id: string; title: string; located: boolean; described: boolean; image: boolean; revision?: number; reason?: string };
/** Module scope: every PlaceLocator instance (one per RPC peer) shares the same completion guard. */
const runningTrips = new Set<string>();
const validCoordinates = (node: TripNode) => {
  const lat = Number(node.lat), lng = Number(node.lng);
  return node.lat !== null && node.lng !== null && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
};

/**
 * Fills places with what makes them useful: real coordinates, a real description and a real
 * photograph. Everything comes from the configured geocoder and Wikipedia, so nothing here is
 * invented; when a source says nothing, the node is left alone and the reason is reported.
 */
export class PlaceLocator {
  constructor(private travel: TravelService, private places: PlaceGeocoder = placeGeocoder, private info: PlaceInfoService = placeInfoService) {}

  private tree(tripId: string) { return this.travel.getTripTree({ tripId }).nodes }
  /** Resolve the trip that owns a node by walking its parents, so a nested place still gets context. */
  private tripNodes(nodeId: string) {
    const all = this.travel.store.snapshot().nodes;
    let cursor = all.find(node => node.id === nodeId);
    while (cursor?.parentId) { const parent = all.find(node => node.id === cursor!.parentId); if (!parent) break; cursor = parent; }
    return cursor ? this.tree(cursor.id) : all.filter(node => node.id === nodeId);
  }

  /** Nearest pinned ancestor, so "Main Square" resolves to the right city. */
  private hint(nodes: TripNode[], node: TripNode) {
    let cursor: TripNode | undefined = node;
    while (cursor?.parentId) {
      cursor = nodes.find(item => item.id === cursor!.parentId);
      // Legacy trips may still carry an old, incorrect geocode. Only actual stops/places anchor searches.
      if (cursor?.type === 'trip') break;
      if (cursor && validCoordinates(cursor)) return { city: searchableTitle(cursor.title), near: { lat: Number(cursor.lat), lng: Number(cursor.lng) } };
    }
    const pinned = nodes.filter(item => item.type === 'stop' && validCoordinates(item));
    return pinned.length === 1 ? { city: searchableTitle(pinned[0].title), near: { lat: Number(pinned[0].lat), lng: Number(pinned[0].lng) } } : { city: '', near: undefined };
  }

  /** Complete one node. Only empty fields are written, so a user's own text and pictures always win. */
  async complete(nodeId: string): Promise<CompletionResult> {
    const detail = this.travel.getNodeDetail({ id: nodeId }), node = detail.node;
    if (node.type === 'trip') throw new Error('Trip titles are thematic and are never geocoded.');
    const result: CompletionResult = { id: node.id, title: node.title, located: false, described: false, image: false };
    const nodes = this.tripNodes(node.id);
    const { city, near } = this.hint(nodes, node);
    const base = searchableTitle(node.title);
    if (!base) { result.reason = 'The title has no searchable words.'; return result; }
    const query = city && !base.toLowerCase().includes(city.toLowerCase()) ? `${base}, ${city}` : base;

    if (!validCoordinates(node)) {
      // One request per place in the normal case: alternatives only when nothing matched at all,
      // because every extra query is another request against the provider's one-per-second budget.
      const queries = [...new Set([query, base === query ? '' : base, base.includes('&') ? base.replace(/&/g, ' and ') : ''])].filter(Boolean);
      let failure = '';
      for (const candidate of queries) {
        if (!candidate) continue;
        const found = await this.places.search({ query: candidate, near, limit: 3 });
        if (found.status === 'unavailable') { failure = found.message || 'Place search is unavailable.'; break; }
        const hit = found.results.find(item => !near || distanceKm(near, item) <= MAX_HINT_DISTANCE_KM);
        if (!hit) continue;
        const fresh = this.travel.getNodeDetail({ id: node.id });
        if (fresh.node.title !== node.title || fresh.node.parentId !== node.parentId) { result.reason = 'The place changed during research.'; return result; }
        if (fresh.node.lat !== null || fresh.node.lng !== null) break;
        const patch: any = { lat: hit.lat, lng: hit.lng };
        if (!fresh.node.address) patch.address = hit.displayName;
        try { await this.travel.updateNode({ id: node.id, patch, revision: fresh.revision }); result.located = true; }
        catch (error: any) { if (!/Revision conflict/.test(String(error?.message))) throw error; }
        break;
      }
      if (!result.located) result.reason = failure || (near ? 'No confident match near this stop.' : 'No match was found.');
    }

    const needsText = !node.description, needsImage = !detail.assets.length;
    if (needsText || needsImage) {
      const found = await this.info.lookup({ query });
      // The article must also be in the right neighbourhood when both sides know their coordinates.
      const tooFar = !!near && found.lat !== null && found.lng !== null && distanceKm(near, { lat: found.lat, lng: found.lng }) > MAX_HINT_DISTANCE_KM;
      if (found.status === 'observed' && tooFar) result.reason = 'The encyclopedia entry is for a different place.';
      else if (found.status === 'observed') {
        const fresh = this.travel.getNodeDetail({ id: node.id }), current = fresh.node, patch: any = {};
        if (current.title !== node.title || current.parentId !== node.parentId) {
          result.reason = 'The place changed during research.';
          if (result.located) result.revision = this.travel.store.snapshot().revision;
          return result;
        }
        if (!current.description && found.description) patch.description = found.description;
        // Wikipedia coordinates are curated pins: useful only when the geocoder found nothing.
        if (!validCoordinates(current) && found.lat !== null && found.lng !== null) { patch.lat = found.lat; patch.lng = found.lng; }
        if (Object.keys(patch).length) { try { await this.travel.updateNode({ id: node.id, patch, revision: fresh.revision }); result.described = !!patch.description; result.located = result.located || patch.lat !== undefined; } catch (error: any) { if (!/Revision conflict/.test(String(error?.message))) throw error; } }
        const assets = this.travel.getNodeDetail({ id: node.id });
        if (!assets.assets.length && found.imageUrl && found.pageUrl) {
          try { await this.travel.saveImage({ nodeId: node.id, url: found.imageUrl, caption: found.title || base, sourceUrl: found.pageUrl, provenance: `${found.attribution} · ${found.pageUrl}`, revision: assets.revision }); result.image = true; }
          catch (error: any) { if (!/Revision conflict/.test(String(error?.message))) throw error; }
        }
      } else if (found.status === 'unavailable') result.reason = result.reason || found.message;
      else result.reason = result.reason || 'No encyclopedia entry was found.';
    }
    if (result.located || result.described || result.image) result.revision = this.travel.store.snapshot().revision;
    return result;
  }

  /** Complete every place/stop of a trip that is still missing coordinates, text or a picture. */
  async completeTrip(tripId: string, limit = 25) {
    // Two clicks must not double the request rate: the trip is either being completed or not.
    if (runningTrips.has(tripId)) return { completed: 0, attempted: 0, pending: 0, halted: 'This trip is already being completed.', results: [] as CompletionResult[] };
    runningTrips.add(tripId);
    try { return await this.runCompletion(tripId, limit); } finally { runningTrips.delete(tripId); }
  }
  private async runCompletion(tripId: string, limit: number) {
    const nodes = this.tree(tripId);
    const pending = nodes.filter(node => node.type !== 'trip' && (node.type === 'place' || node.type === 'stop') && (!validCoordinates(node) || !node.description || !this.travel.getNodeDetail({ id: node.id }).assets.length)).slice(0, limit);
    const done: CompletionResult[] = [];
    let halted = '';
    for (const node of pending) {
      try {
        const result = await this.complete(node.id);
        done.push(result);
        // No point in calling a provider that just told us to slow down for the remaining places.
        if (result.reason && /rate limit|unavailable|turned off/i.test(result.reason)) { halted = result.reason; break; }
      } catch (error: any) { done.push({ id: node.id, title: node.title, located: false, described: false, image: false, reason: String(error?.message || error).slice(0, 200) }); }
    }
    const completed = done.filter(item => item.located || item.described || item.image).length; return { completed, attempted: done.length, pending: Math.max(0, pending.length - done.length), halted, results: done, ...(completed ? { revision: this.travel.store.snapshot().revision } : {}) };
  }
}
