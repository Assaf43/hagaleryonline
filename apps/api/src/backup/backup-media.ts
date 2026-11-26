import { GetObjectCommand, paginateListObjectsV2, type S3Client } from '@aws-sdk/client-s3';
import { finished } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import {
  BackupRuns,
  backupWriter,
  checkRecipient,
  encryptToBucket,
  failureDetail,
  forcePathStyle,
  need,
  s3Client,
  type Env,
} from './backup-common.js';
import type { BackupResult } from './backup-db.js';

/** Objects changed this long before the last successful run's start are copied again (clock skew, slow uploads). */
export const MEDIA_OVERLAP_MS = 60 * 60 * 1000;

/** The media buckets, read with the backup keys (never the API's). */
function mediaReader(env: Env): S3Client {
  return s3Client({
    endpoint: need(env, 'S3_ENDPOINT'),
    region: need(env, 'S3_REGION'),
    accessKeyId: need(env, 'BACKUP_S3_ACCESS_KEY_ID'),
    secretAccessKey: need(env, 'BACKUP_S3_SECRET_ACCESS_KEY'),
    forcePathStyle: forcePathStyle(env),
  });
}

export function mediaBackupConfig(env: Env): void {
  need(env, 'BACKUP_DATABASE_URL');
  checkRecipient(need(env, 'BACKUP_AGE_RECIPIENT'));
  need(env, 'S3_PUBLIC_BUCKET');
  need(env, 'S3_PRIVATE_BUCKET');
  backupWriter(env).client.destroy();
  mediaReader(env).destroy();
}

/**
 * The nightly photo copy (spec 9b.5). Photo files are immutable with unique keys, so only new ones are copied: those
 * whose `LastModified` is after the last successful media run's start minus {@link MEDIA_OVERLAP_MS} (every object on
 * the first run). The writer key cannot read or list the backup bucket, so "new" is decided from `backup_runs`, never
 * by looking there. Each object is encrypted on its own into `media/<public|private>/<key>.age` (private originals and
 * damaged-product photos are personal data). One failed object does not stop the others; the run is then `ok = false`
 * and the next run starts again from the last successful one.
 */
export async function runMediaBackup(
  env: Env,
  opts: { signal?: AbortSignal; overlapMs?: number } = {},
): Promise<BackupResult> {
  const url = need(env, 'BACKUP_DATABASE_URL');
  const recipient = checkRecipient(need(env, 'BACKUP_AGE_RECIPIENT'));
  const buckets = [
    ['public', need(env, 'S3_PUBLIC_BUCKET')],
    ['private', need(env, 'S3_PRIVATE_BUCKET')],
  ] as const;
  const { client: backup, bucket: backupBucket } = backupWriter(env);
  const media = mediaReader(env);
  let runs: BackupRuns | null = null;
  const startedAt = new Date();
  let runId = 0;
  let objects = 0;
  let bytes = 0;
  let failed = 0;
  let firstError: unknown;
  try {
    runs = await BackupRuns.connect(url);
    runId = await runs.start('media', startedAt);
    try {
      const last = await runs.lastOkStart('media');
      const since = last ? last.getTime() - (opts.overlapMs ?? MEDIA_OVERLAP_MS) : null;
      for (const [visibility, bucket] of buckets) {
        for await (const page of paginateListObjectsV2({ client: media }, { Bucket: bucket })) {
          for (const object of page.Contents ?? []) {
            if (!object.Key) continue;
            if (since !== null && object.LastModified && object.LastModified.getTime() <= since) continue;
            if (opts.signal?.aborted) throw new Error('stopped');
            try {
              const out = await media.send(new GetObjectCommand({ Bucket: bucket, Key: object.Key }), {
                abortSignal: opts.signal,
              });
              const source = out.Body as Readable;
              bytes += await encryptToBucket({
                source,
                sourceDone: finished(source),
                recipient,
                client: backup,
                bucket: backupBucket,
                key: `media/${visibility}/${object.Key}.age`,
                signal: opts.signal,
              });
              objects++;
            } catch (error) {
              if (opts.signal?.aborted) throw error;
              failed++;
              firstError ??= error;
            }
          }
        }
      }
    } catch (error) {
      const detail = failureDetail(error);
      await runs.finish(runId, { ok: false, bytes, objects, detail });
      return { ok: false, runId, bytes, objects, detail };
    }
    const detail = failed ? `${failed} of ${failed + objects} objects failed: ${failureDetail(firstError)}` : null;
    await runs.finish(runId, { ok: failed === 0, bytes, objects, detail });
    return { ok: failed === 0, runId, bytes, objects, detail };
  } finally {
    await runs?.close();
    backup.destroy();
    media.destroy();
  }
}
