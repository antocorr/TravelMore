import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
// Blueed's proven provider record/PlanManager adapter; persistence stays server-side.
// @ts-expect-error JavaScript compatibility module is intentionally vendored from Blueed.
import { ProviderStorage } from './providers.shared.js';

type Records = Record<string, unknown>;
export async function openProviderStorage(dataRoot: string) {
  const path = join(dataRoot, 'providers.json'); let records: Records = {};
  try { records = JSON.parse(await readFile(path, 'utf8')); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  let writes = Promise.resolve();
  const persist = (next: Records) => {
    const operation = writes.then(async () => { await mkdir(dataRoot, { recursive: true, mode: 0o700 }); const temporary = `${path}.tmp`; await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 }); await rename(temporary, path); });
    writes = operation.catch(() => {}); return operation;
  };
  return new ProviderStorage(records, persist);
}
