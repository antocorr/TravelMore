import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const types: Record<string, { mime: string; extension: string }> = { jpeg: { mime: 'image/jpeg', extension: 'jpg' }, png: { mime: 'image/png', extension: 'png' }, webp: { mime: 'image/webp', extension: 'webp' } };
const kind = (bytes: Buffer) => bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ? 'jpeg' : bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'png' : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'webp' : null;
/** Private media bytes, addressed only by UUID. The public router never exposes the storage directory. */
export class MediaStore {
  readonly root: string;
  constructor(dataRoot: string) { this.root = join(dataRoot, 'media'); }
  async put(bytes: Buffer) { if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 15 * 1024 * 1024) throw new Error('Image must be between 1 byte and 15MB.'); const imageType = kind(bytes); if (!imageType) throw new Error('Only JPEG, PNG and WebP images are accepted.'); await mkdir(this.root, { recursive: true, mode: 0o700 }); const id = randomUUID(), info = types[imageType]; await writeFile(join(this.root, `${id}.${info.extension}`), bytes, { mode: 0o600, flag: 'wx' }); return { id, ...info }; }
  async get(id: string) { if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid media ID.'); for (const info of Object.values(types)) try { return { bytes: await readFile(join(this.root, `${id}.${info.extension}`)), ...info }; } catch (error: any) { if (error.code !== 'ENOENT') throw error; } throw new Error('Media not found.'); }
  async remove(id: string) { if (!/^[a-f0-9-]{36}$/i.test(id)) return; const { unlink } = await import('node:fs/promises'); await Promise.all(Object.values(types).map(info => unlink(join(this.root, `${id}.${info.extension}`)).catch(error => { if (error.code !== 'ENOENT') throw error; }))); }
}
