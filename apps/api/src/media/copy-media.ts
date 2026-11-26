import { readdir, readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { S3Storage } from './s3-storage.js';

export interface CopyMediaResult {
  copied: number;
  skipped: number;
  failed: string[];
}

/** Relative file paths (with `/` separators) under a directory; a missing directory is empty. */
async function walk(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((e) => e.isFile())
    .map((e) =>
      join(e.parentPath, e.name)
        .slice(dir.length + 1)
        .split(sep)
        .join('/'),
    )
    .sort();
}

/**
 * One-time copy of `<localRoot>/public` and `<localRoot>/private` into the S3 buckets, keeping each relative key
 * and visibility. Objects that already exist are skipped; local files are never touched. With `dryRun` nothing is
 * written and `copied` counts what would be.
 */
export async function copyMediaToS3(
  localRoot: string,
  target: S3Storage,
  opts: { dryRun: boolean },
): Promise<CopyMediaResult> {
  const result: CopyMediaResult = { copied: 0, skipped: 0, failed: [] };
  for (const visibility of ['public', 'private'] as const) {
    const dir = join(localRoot, visibility);
    for (const key of await walk(dir)) {
      try {
        if (await target.exists(key, visibility)) {
          result.skipped++;
          continue;
        }
        if (!opts.dryRun) await target.put(key, await readFile(join(dir, ...key.split('/'))), visibility);
        result.copied++;
      } catch {
        result.failed.push(`${visibility}/${key}`);
      }
    }
  }
  return result;
}
