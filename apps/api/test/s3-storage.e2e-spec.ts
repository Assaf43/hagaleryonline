import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketPolicyCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyMediaToS3 } from '../src/media/copy-media.js';
import { S3Storage } from '../src/media/s3-storage.js';

/** S3Storage against a real S3-compatible server (MinIO). Skipped unless S3_TEST_ENDPOINT is set. */
const endpoint = process.env.S3_TEST_ENDPOINT;
if (!endpoint) console.warn('s3-storage e2e SKIPPED: S3_TEST_ENDPOINT is not set (start MinIO, see ci.yml)');

describe.skipIf(!endpoint)('S3Storage (e2e, MinIO)', () => {
  const accessKeyId = process.env.S3_TEST_ACCESS_KEY_ID || 'minioadmin';
  const secretAccessKey = process.env.S3_TEST_SECRET_ACCESS_KEY || 'minioadmin';
  const suffix = randomBytes(4).toString('hex');
  const publicBucket = `nesto-test-pub-${suffix}`;
  const privateBucket = `nesto-test-priv-${suffix}`;
  const client = new S3Client({
    endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  let storage: S3Storage;

  const emptyAndDelete = async (Bucket: string) => {
    const list = await client.send(new ListObjectsV2Command({ Bucket }));
    if (list.Contents?.length)
      await client.send(
        new DeleteObjectsCommand({ Bucket, Delete: { Objects: list.Contents.map(({ Key }) => ({ Key })) } }),
      );
    await client.send(new DeleteBucketCommand({ Bucket }));
  };

  beforeAll(async () => {
    await client.send(new CreateBucketCommand({ Bucket: publicBucket }));
    await client.send(new CreateBucketCommand({ Bucket: privateBucket }));
    await client.send(
      new PutBucketPolicyCommand({
        Bucket: publicBucket,
        Policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { AWS: ['*'] },
              Action: ['s3:GetObject'],
              Resource: [`arn:aws:s3:::${publicBucket}/*`],
            },
          ],
        }),
      }),
    );
    storage = new S3Storage({
      endpoint: endpoint!,
      region: 'us-east-1',
      accessKeyId,
      secretAccessKey,
      publicBucket,
      privateBucket,
      forcePathStyle: true,
      urlPrefix: '/media',
    });
  });

  afterAll(async () => {
    await emptyAndDelete(publicBucket).catch(() => undefined);
    await emptyAndDelete(privateBucket).catch(() => undefined);
    client.destroy();
  });

  const exists = async (Bucket: string, Key: string) => {
    try {
      await client.send(new HeadObjectCommand({ Bucket, Key }));
      return true;
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return false;
      throw error;
    }
  };

  it('put / read / remove round trip', async () => {
    const data = Buffer.from('hello photo');
    await storage.put('products/1/a-960.webp', data, 'public');
    await storage.put('products/1/original.jpg', data, 'private');
    expect((await storage.read('products/1/a-960.webp', 'public'))?.equals(data)).toBe(true);
    expect((await storage.read('products/1/original.jpg', 'private'))?.equals(data)).toBe(true);
    await storage.remove([
      { key: 'products/1/a-960.webp', visibility: 'public' },
      { key: 'products/1/original.jpg', visibility: 'private' },
      { key: 'never/existed.webp', visibility: 'public' },
    ]);
    expect(await storage.read('products/1/a-960.webp', 'public')).toBeNull();
    expect(await storage.read('products/1/original.jpg', 'private')).toBeNull();
  });

  it('removes more than 1000 keys in batches', async () => {
    const keys = Array.from({ length: 1005 }, (_, i) => ({ key: `bulk/${i}.pdf`, visibility: 'private' as const }));
    const real = [keys[0], keys[999], keys[1000], keys[1004]];
    await Promise.all(real.map((k) => storage.put(k.key, Buffer.from('x'), 'private')));
    await storage.remove(keys);
    for (const k of real) expect(await storage.read(k.key, 'private')).toBeNull();
  });

  it('exists is true for a stored key and false for a missing one', async () => {
    await storage.put('ex/a.webp', Buffer.from('x'), 'public');
    expect(await storage.exists('ex/a.webp', 'public')).toBe(true);
    expect(await storage.exists('ex/a.webp', 'private')).toBe(false);
    expect(await storage.exists('ex/none.webp', 'public')).toBe(false);
  });

  it('missing key reads null', async () => {
    expect(await storage.read('nope/missing.webp', 'public')).toBeNull();
    expect(await storage.read('nope/missing.webp', 'private')).toBeNull();
  });

  it('private put never touches the public bucket', async () => {
    await storage.put('invoices/1.pdf', Buffer.from('%PDF'), 'private');
    expect(await exists(publicBucket, 'invoices/1.pdf')).toBe(false);
    expect(await exists(privateBucket, 'invoices/1.pdf')).toBe(true);
  });

  it('sets content type and cache headers', async () => {
    await storage.put('h/a.webp', Buffer.from('x'), 'public');
    await storage.put('h/b.pdf', Buffer.from('x'), 'private');
    const pub = await client.send(new HeadObjectCommand({ Bucket: publicBucket, Key: 'h/a.webp' }));
    expect(pub.ContentType).toBe('image/webp');
    expect(pub.CacheControl).toBe('public, max-age=31536000, immutable');
    const priv = await client.send(new HeadObjectCommand({ Bucket: privateBucket, Key: 'h/b.pdf' }));
    expect(priv.ContentType).toBe('application/pdf');
    expect(priv.CacheControl).toBe('private, no-store');
  });

  it('public object is readable anonymously, private is not', async () => {
    await storage.put('anon/a.webp', Buffer.from('pic'), 'public');
    await storage.put('anon/b.webp', Buffer.from('secret'), 'private');
    const open = await fetch(`${endpoint}/${publicBucket}/anon/a.webp`);
    expect(open.status).toBe(200);
    expect(open.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await open.text()).toBe('pic');
    expect((await fetch(`${endpoint}/${privateBucket}/anon/b.webp`)).status).toBe(403);
  });
  describe('copyMediaToS3', () => {
    let root: string;
    const files: [string, string, string][] = [
      ['public', 'products/1/a-960.webp', 'pub-a'],
      ['public', 'content/b.avif', 'pub-b'],
      ['private', 'products/1/original.jpg', 'priv-a'],
      ['private', 'support/9/p.webp', 'priv-b'],
    ];

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), 'nesto-copy-'));
      for (const [vis, key, body] of files) {
        const path = join(root, vis, ...key.split('/'));
        await mkdir(join(path, '..'), { recursive: true });
        await writeFile(path, body);
      }
    });
    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it('dry run writes nothing', async () => {
      const result = await copyMediaToS3(root, storage, { dryRun: true });
      expect(result).toEqual({ copied: 4, skipped: 0, failed: [] });
      expect(await exists(publicBucket, 'content/b.avif')).toBe(false);
      expect(await exists(privateBucket, 'support/9/p.webp')).toBe(false);
    });

    it('copies public and private to the right buckets', async () => {
      const result = await copyMediaToS3(root, storage, { dryRun: false });
      expect(result).toEqual({ copied: 4, skipped: 0, failed: [] });
      expect(await exists(publicBucket, 'products/1/a-960.webp')).toBe(true);
      expect(await exists(publicBucket, 'products/1/original.jpg')).toBe(false);
      expect(await exists(privateBucket, 'products/1/original.jpg')).toBe(true);
      expect((await storage.read('support/9/p.webp', 'private'))?.toString()).toBe('priv-b');
      expect((await storage.read('content/b.avif', 'public'))?.toString()).toBe('pub-b');
    });

    it('second run copies nothing', async () => {
      const result = await copyMediaToS3(root, storage, { dryRun: false });
      expect(result).toEqual({ copied: 0, skipped: 4, failed: [] });
    });
  });
});
