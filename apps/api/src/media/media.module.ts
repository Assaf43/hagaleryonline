import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { resolve } from 'node:path';
import { LocalDiskStorage } from './local-disk-storage.js';
import { S3Storage } from './s3-storage.js';
import { StorageProvider } from './storage.js';

/** Unset gives the default; only the exact words true / false are accepted. The bad value is never printed. */
export function parseBoolean(value: string | undefined, name: string, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

/**
 * Where uploaded files go. STORAGE_PROVIDER=local (default, dev and tests): MEDIA_DIR is relative to the API's
 * working directory (apps/api), so the default is `storage/` at the repo root. STORAGE_PROVIDER=s3: an
 * S3-compatible store with a public and a private bucket (Caddy serves MEDIA_URL from the public one).
 * MEDIA_URL is where the site reads public files in both cases.
 */
export function createStorage(config: Pick<ConfigService, 'get'>): StorageProvider {
  const urlPrefix = (config.get<string>('MEDIA_URL') || '/media').replace(/\/$/, '');
  const provider = config.get<string>('STORAGE_PROVIDER') || 'local';
  if (provider === 'local')
    return new LocalDiskStorage(resolve(config.get<string>('MEDIA_DIR') || '../../storage'), urlPrefix);
  if (provider !== 's3') throw new Error('Unknown STORAGE_PROVIDER (use local or s3)');
  const need = (name: string): string => {
    const value = config.get<string>(name);
    if (!value) throw new Error(`${name} is required when STORAGE_PROVIDER=s3`);
    return value;
  };
  return new S3Storage({
    endpoint: need('S3_ENDPOINT'),
    region: need('S3_REGION'),
    accessKeyId: need('S3_ACCESS_KEY_ID'),
    secretAccessKey: need('S3_SECRET_ACCESS_KEY'),
    publicBucket: need('S3_PUBLIC_BUCKET'),
    privateBucket: need('S3_PRIVATE_BUCKET'),
    forcePathStyle: parseBoolean(config.get<string>('S3_FORCE_PATH_STYLE'), 'S3_FORCE_PATH_STYLE', true),
    urlPrefix,
  });
}

@Global()
@Module({
  providers: [{ provide: StorageProvider, inject: [ConfigService], useFactory: createStorage }],
  exports: [StorageProvider],
})
export class MediaModule {}
