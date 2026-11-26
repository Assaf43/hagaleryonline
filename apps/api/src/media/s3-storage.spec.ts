import { S3Storage, contentTypeFor } from './s3-storage.js';

const storage = () =>
  new S3Storage({
    endpoint: 'http://127.0.0.1:9',
    region: 'us-east-1',
    accessKeyId: 'a',
    secretAccessKey: 'b',
    publicBucket: 'pub',
    privateBucket: 'priv',
    forcePathStyle: true,
    urlPrefix: '/media',
  });

describe('S3Storage (no network)', () => {
  it.each(['', '/abs.webp', 'a\\b.webp', '../x.webp', 'a/../x.webp', 'a/./b', 'a//b', 'a\u0000b', 'a\nb'])(
    'refuses the key %j',
    async (key) => {
      const s = storage();
      await expect(s.put(key, Buffer.from('x'), 'public')).rejects.toThrow('Bad storage key');
      await expect(s.read(key, 'private')).rejects.toThrow('Bad storage key');
      await expect(s.remove([{ key, visibility: 'public' }])).rejects.toThrow('Bad storage key');
    },
  );

  it('builds the public URL like the local adapter', () => {
    expect(storage().publicUrl('products/1/a-960.webp')).toBe('/media/products/1/a-960.webp');
  });

  it('chooses the content type by extension', () => {
    expect(contentTypeFor('a/b.webp')).toBe('image/webp');
    expect(contentTypeFor('a/b.avif')).toBe('image/avif');
    expect(contentTypeFor('a/b.jpg')).toBe('image/jpeg');
    expect(contentTypeFor('a/b.PNG')).toBe('image/png');
    expect(contentTypeFor('a/b.pdf')).toBe('application/pdf');
    expect(contentTypeFor('a/b.xlsx')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(contentTypeFor('a/b.html')).toBe('application/octet-stream');
    expect(contentTypeFor('noext')).toBe('application/octet-stream');
  });
});

describe('S3Storage timeout', () => {
  it('gives up on a server that never answers, within the total limit', async () => {
    const { createServer } = await import('node:net');
    const server = createServer(() => undefined); // accepts, never replies
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const s = new S3Storage({
      endpoint: `http://127.0.0.1:${port}`,
      region: 'us-east-1',
      accessKeyId: 'a',
      secretAccessKey: 'b',
      publicBucket: 'pub',
      privateBucket: 'priv',
      forcePathStyle: true,
      urlPrefix: '/media',
    });
    const started = Date.now();
    await expect(s.read('a/b.webp', 'public')).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(13_000);
    server.close();
  }, 20_000);
});
