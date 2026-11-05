import sharp from 'sharp';
import { processImage } from './image-processor.js';

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
