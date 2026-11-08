import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { StorageProvider } from './storage.js';

/**
 * Files under `<root>/public` (served at `urlPrefix` by the API, by Caddy/CDN in production) and
 * `<root>/private`.
 */
export class LocalDiskStorage extends StorageProvider {
  readonly publicDir: string;
  private readonly privateDir: string;

  constructor(
    root: string,
    readonly urlPrefix: string,
  ) {
    super();
    this.publicDir = resolve(root, 'public');
    this.privateDir = resolve(root, 'private');
  }

  async put(key: string, data: Buffer, visibility: 'public' | 'private'): Promise<void> {
    const path = this.path(key, visibility);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }

  async remove(keys: { key: string; visibility: 'public' | 'private' }[]): Promise<void> {
    await Promise.all(keys.map(({ key, visibility }) => rm(this.path(key, visibility), { force: true })));
  }

  publicUrl(key: string): string {
    return `${this.urlPrefix}/${key}`;
  }

  /** Keys are built by our code, but never let one escape the storage folder. */
  private path(key: string, visibility: 'public' | 'private'): string {
    const base = visibility === 'public' ? this.publicDir : this.privateDir;
    const path = resolve(join(base, key));
    if (!path.startsWith(base + sep)) throw new Error(`Bad storage key: ${key}`);
    return path;
  }
}
