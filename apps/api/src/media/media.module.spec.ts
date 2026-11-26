import { createStorage, parseBoolean } from './media.module.js';
import { LocalDiskStorage } from './local-disk-storage.js';
import { S3Storage } from './s3-storage.js';

const cfg = (env: Record<string, string>) => ({ get: <T>(name: string) => env[name] as T | undefined });
const s3 = {
  STORAGE_PROVIDER: 's3',
  S3_ENDPOINT: 'http://127.0.0.1:9000',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY_ID: 'a',
  S3_SECRET_ACCESS_KEY: 'b',
  S3_PUBLIC_BUCKET: 'pub',
  S3_PRIVATE_BUCKET: 'priv',
};

describe('createStorage', () => {
  it('defaults to local disk', () => {
    expect(createStorage(cfg({}))).toBeInstanceOf(LocalDiskStorage);
  });
  it('builds S3Storage with the same URL prefix', () => {
    const storage = createStorage(cfg({ ...s3, MEDIA_URL: '/pics/' }));
    expect(storage).toBeInstanceOf(S3Storage);
    expect(storage.publicUrl('a.webp')).toBe('/pics/a.webp');
  });
  it('refuses an unknown provider', () => {
    expect(() => createStorage(cfg({ STORAGE_PROVIDER: 'gcs' }))).toThrow('Unknown STORAGE_PROVIDER');
  });
  it('names a missing S3 variable', () => {
    expect(() => createStorage(cfg({ ...s3, S3_PRIVATE_BUCKET: '' }))).toThrow('S3_PRIVATE_BUCKET');
  });
  it('parses S3_FORCE_PATH_STYLE strictly without printing the value', () => {
    expect(parseBoolean(undefined, 'X', true)).toBe(true);
    expect(parseBoolean('false', 'X', true)).toBe(false);
    expect(parseBoolean('true', 'X', false)).toBe(true);
    expect(() => parseBoolean('yes-secret', 'S3_FORCE_PATH_STYLE', true)).toThrow(
      /^S3_FORCE_PATH_STYLE must be true or false$/,
    );
    expect(() => createStorage(cfg({ ...s3, S3_FORCE_PATH_STYLE: '1' }))).toThrow('S3_FORCE_PATH_STYLE');
  });
});
