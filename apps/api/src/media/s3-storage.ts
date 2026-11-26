import {
  DeleteObjectsCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { StorageProvider } from './storage.js';

export interface S3StorageOptions {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBucket: string;
  privateBucket: string;
  forcePathStyle: boolean;
  /** Same prefix as the local adapter (MEDIA_URL), so stored URLs do not change. */
  urlPrefix: string;
}

const CONTENT_TYPES: Record<string, string> = {
  webp: 'image/webp',
  avif: 'image/avif',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export function contentTypeFor(key: string): string {
  const dot = key.lastIndexOf('.');
  const extension = dot < 0 ? '' : key.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}

/** Request timeout for every call (real adapters must not hang). */
const REQUEST_TIMEOUT_MS = 10_000;
const DELETE_BATCH = 1000;

/** Public files in one bucket (served by Caddy / a CDN at `urlPrefix`), private files in another. */
export class S3Storage extends StorageProvider {
  private readonly client: S3Client;

  constructor(private readonly opts: S3StorageOptions) {
    super();
    this.client = new S3Client({
      endpoint: opts.endpoint,
      region: opts.region,
      forcePathStyle: opts.forcePathStyle,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
      maxAttempts: 2,
      requestHandler: { connectionTimeout: REQUEST_TIMEOUT_MS, requestTimeout: REQUEST_TIMEOUT_MS },
    });
  }

  /** Every call, retries included, is cut off after REQUEST_TIMEOUT_MS in total. */
  private readonly send = ((command: never) =>
    this.client.send(command, { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })) as S3Client['send'];

  async put(key: string, data: Buffer, visibility: 'public' | 'private'): Promise<void> {
    checkKey(key);
    await this.send(
      new PutObjectCommand({
        Bucket: this.bucket(visibility),
        Key: key,
        Body: data,
        ContentType: contentTypeFor(key),
        CacheControl: visibility === 'public' ? 'public, max-age=31536000, immutable' : 'private, no-store',
      }),
    );
  }

  async read(key: string, visibility: 'public' | 'private'): Promise<Buffer | null> {
    checkKey(key);
    try {
      const out = await this.send(new GetObjectCommand({ Bucket: this.bucket(visibility), Key: key }));
      return Buffer.from(await out.Body!.transformToByteArray());
    } catch (error) {
      if (error instanceof NoSuchKey || (error instanceof S3ServiceException && error.name === 'NoSuchKey'))
        return null;
      throw error;
    }
  }

  async remove(keys: { key: string; visibility: 'public' | 'private' }[]): Promise<void> {
    for (const { key } of keys) checkKey(key);
    for (const visibility of ['public', 'private'] as const) {
      const own = keys.filter((k) => k.visibility === visibility).map((k) => ({ Key: k.key }));
      for (let i = 0; i < own.length; i += DELETE_BATCH) {
        const out = await this.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket(visibility),
            Delete: { Objects: own.slice(i, i + DELETE_BATCH), Quiet: true },
          }),
        );
        if (out.Errors?.length) throw new Error(`Could not delete ${out.Errors.length} storage objects`);
      }
    }
  }

  publicUrl(key: string): string {
    return `${this.opts.urlPrefix}/${key}`;
  }

  private bucket(visibility: 'public' | 'private'): string {
    return visibility === 'public' ? this.opts.publicBucket : this.opts.privateBucket;
  }
}

/** Keys are built by our code, but refuse anything odd before it reaches the object store. */
function checkKey(key: string): void {
  const bad =
    key === '' ||
    key.startsWith('/') ||
    key.includes('\\') ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(key) ||
    key.split('/').some((part) => part === '' || part === '.' || part === '..');
  if (bad) throw new Error(`Bad storage key: ${JSON.stringify(key)}`);
}
