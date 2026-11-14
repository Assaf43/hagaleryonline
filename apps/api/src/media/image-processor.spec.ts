import sharp from 'sharp';
import { processImage, processPrivatePhoto } from './image-processor.js';

const photo = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 180, b: 150 } } });

describe('processImage', () => {
  it('turns a phone photo upright, makes WebP and AVIF copies and drops GPS and camera data', async () => {
    // Stored sideways with "rotate 90°" in EXIF, as phones do, plus a location.
    const input = await photo(2000, 1000)
      .withExif({ IFD0: { Make: 'Phone' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '32/1 4/1 0/1' } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    expect((await sharp(input).metadata()).exif).toBeDefined();

    const result = await processImage(input);
    expect(result).toMatchObject({ originalExt: 'jpg', width: 1000, height: 2000 });
    expect(result.copies.map((c) => c.width)).toEqual([480, 960, 1000]);
    for (const copy of result.copies) {
      const webp = await sharp(copy.webp).metadata();
      expect(webp).toMatchObject({ format: 'webp', width: copy.width });
      expect(webp.height).toBeGreaterThan(copy.width);
      expect(webp.exif).toBeUndefined();
      expect((await sharp(copy.avif).metadata()).format).toBe('heif');
    }
  });

  it('keeps transparency of a cut-out PNG', async () => {
    const png = await sharp({
      create: { width: 800, height: 600, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const result = await processImage(png);
    expect(result.originalExt).toBe('png');
    expect((await sharp(result.copies[0].webp).metadata()).hasAlpha).toBe(true);
  });

  it('refuses what is not a usable photo', async () => {
    await expect(processImage(await photo(500, 400).jpeg().toBuffer())).rejects.toMatchObject({ problem: 'too_small' });
    await expect(processImage(await photo(800, 600).gif().toBuffer())).rejects.toMatchObject({ problem: 'type' });
    await expect(
      processImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="700"/>')),
    ).rejects.toMatchObject({
      problem: 'type',
    });
    await expect(processImage(Buffer.from('not a picture'))).rejects.toMatchObject({ problem: 'unreadable' });
  });
});

describe('processPrivatePhoto (support photos, spec §7.1)', () => {
  it('one upright WebP of at most 1600 px wide, without GPS or camera data', async () => {
    const input = await photo(3000, 2000)
      .withExif({ IFD0: { Make: 'Phone' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '32/1 4/1 0/1' } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const meta = await sharp(await processPrivatePhoto(input)).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 1600 });
    expect(meta.height).toBeGreaterThan(1600);
    expect(meta.exif).toBeUndefined();
  });

  it('a smaller photo keeps its size; content that is not a photo is refused', async () => {
    expect((await sharp(await processPrivatePhoto(await photo(900, 700).png().toBuffer())).metadata()).width).toBe(900);
    await expect(processPrivatePhoto(Buffer.from('not a picture'))).rejects.toMatchObject({ problem: 'unreadable' });
    await expect(processPrivatePhoto(await photo(800, 600).gif().toBuffer())).rejects.toMatchObject({
      problem: 'type',
    });
  });
});
