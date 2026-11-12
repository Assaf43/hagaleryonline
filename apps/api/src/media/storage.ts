/**
 * File storage behind an interface (architecture.md §2: Object Storage + CDN). The MVP stores files
 * on local disk; an S3-compatible adapter can replace it without touching callers.
 *
 * Keys are relative paths such as `products/12/k3x9a-960.webp`. Public files are served to the
 * site; private files (photo originals) are never served.
 */
export abstract class StorageProvider {
  abstract put(key: string, data: Buffer, visibility: 'public' | 'private'): Promise<void>;
  /** The file's content, or null when there is no such file (e.g. a private invoice document). */
  abstract read(key: string, visibility: 'public' | 'private'): Promise<Buffer | null>;
  /** Deletes the files; missing files are ignored. */
  abstract remove(keys: { key: string; visibility: 'public' | 'private' }[]): Promise<void>;
  /** URL the site uses for a public file. */
  abstract publicUrl(key: string): string;
}
