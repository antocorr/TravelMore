import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TravelStoreData } from './types.js';

const initial = (): TravelStoreData => ({ version: 1, revision: 0, nodes: [], todos: [], images: [], flightSearches: [], flightCandidates: [], providers: [], tripProviders: {}, chats: [], flightWatches: [], flightRuns: [], flightOffers: [], flightPrices: [] });
/** Serial JSON store: all persisted user data is private to ~/.travelmore (0700). */
export class TravelStore {
  readonly root: string;
  readonly path: string;
  private data: TravelStoreData | null = null;
  private queue = Promise.resolve();
  constructor(root = process.env.TRAVELMORE_DATA_DIR || join(homedir(), '.travelmore')) { this.root = root; this.path = join(root, 'travelmore.json'); }
  async open() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as TravelStoreData;
      if (parsed.version !== 1 || !Array.isArray(parsed.nodes)) throw new Error('Unsupported TravelMore data format.');
      // Legacy nodes predate the place-address field; normalize so every node has the same shape.
      const images = (parsed.images || []).map((image: any) => ({ ...image, isPrimary: image.isPrimary === true })); const primaryNodes = new Set(images.filter((image: any) => image.isPrimary).map((image: any) => image.nodeId)); for (const image of images) if (!primaryNodes.has(image.nodeId)) { image.isPrimary = true; primaryNodes.add(image.nodeId); }
      this.data = { ...initial(), ...parsed, nodes: parsed.nodes.map(node => ({ ...node, address: typeof node.address === 'string' && node.address ? node.address : null })), images, chats: (parsed.chats || []).map((entry: any) => { const { tripId, ...rest } = entry; return { ...rest, scope: typeof entry.scope === 'string' ? entry.scope : tripId }; }) };
    } catch (error: any) { if (error.code === 'ENOENT') this.data = initial(); else throw error; }
  }
  snapshot(): TravelStoreData { if (!this.data) throw new Error('Travel store is not open.'); return structuredClone(this.data); }
  async transaction<T>(mutate: (data: TravelStoreData) => T | Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      if (!this.data) throw new Error('Travel store is not open.');
      const copy = structuredClone(this.data), result = await mutate(copy);
      copy.revision++;
      await this.persist(copy); this.data = copy;
      return result;
    });
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }
  private async persist(data: TravelStoreData) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.path);
  }
}
