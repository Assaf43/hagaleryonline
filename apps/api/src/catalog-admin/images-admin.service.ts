import { randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  IMAGE_UPLOAD,
  type AdminImage,
  type AdminImageInput,
  type ImageKindCode,
  type ImageUploadProblem,
} from '@hg/models';
import { ImageKind, Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { CacheStore } from '../cache/cache-store.js';
import { copyKey, defaultWidth, ImageRejected, processImage } from '../media/image-processor.js';
import { imageFiles, originalKey, toAdminImage } from '../media/image-urls.js';
import { StorageProvider } from '../media/storage.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { incomplete, invalid, notFound } from './catalog-errors.js';
import type { Meta } from './products-admin.service.js';

const KIND: Record<ImageKindCode, ImageKind> = { cutout: ImageKind.CUTOUT, lifestyle: ImageKind.LIFESTYLE };
const imageInclude = { colorValue: { select: { code: true } } } satisfies Prisma.ImageInclude;
const auditBase = (meta: Meta) => ({ actorType: 'admin' as const, actorId: meta.actorId, ip: meta.ip });

/**
 * Product photos (Phase 2d, ADM-04). Each upload is checked by its content, stored as resized
 * WebP/AVIF copies without metadata, and its original is kept privately. Photos are linked to a
 * color of the product, or to every color (decision 62). A product shown on the site keeps at
 * least one photo.
 */
@Injectable()
export class ImagesAdminService {
  private readonly logger = new Logger(ImagesAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cache: CacheStore,
    private readonly storage: StorageProvider,
  ) {}

  async upload(productId: number, file: Buffer, fields: Partial<AdminImageInput>, meta: Meta): Promise<AdminImage> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      include: { _count: { select: { images: true } } },
    });
    if (!product) throw notFound();
    if (product._count.images >= IMAGE_UPLOAD.maxPerProduct) throw uploadProblem('too_many');
    const color = await this.colorValue(fields.colorCode ?? null);

    let processed;
    try {
      processed = await processImage(file);
    } catch (e) {
      if (e instanceof ImageRejected) throw uploadProblem(e.problem);
      throw e;
    }

    const storageKey = `products/${productId}/${randomBytes(9).toString('base64url')}`;
    const widths = processed.copies.map((c) => c.width);
    const written = imageFiles({ storageKey, widths });
    try {
      await this.storage.put(originalKey(storageKey, processed.originalExt), file, 'private');
      for (const copy of processed.copies) {
        await this.storage.put(copyKey(storageKey, copy.width, 'webp'), copy.webp, 'public');
        await this.storage.put(copyKey(storageKey, copy.width, 'avif'), copy.avif, 'public');
      }
      const altHe = fields.altHe?.trim() || (color ? `${product.nameHe} – ${color.labelHe}` : product.nameHe);
      const image = await this.prisma.$transaction(async (tx) => {
        const last = await tx.image.aggregate({ where: { productId }, _max: { sortOrder: true } });
        const created = await tx.image.create({
          data: {
            productId,
            colorValueId: color?.id ?? null,
            url: this.storage.publicUrl(copyKey(storageKey, defaultWidth(widths), 'webp')),
            storageKey,
            widths,
            width: processed.width,
            height: processed.height,
            altHe,
            kind: KIND[fields.kind ?? 'cutout'],
            sortOrder: (last._max.sortOrder ?? -1) + 1,
          },
          include: imageInclude,
        });
        await this.audit.record(
          {
            ...auditBase(meta),
            action: 'image.create',
            entityType: 'product',
            entityId: productId,
            after: summary(created),
          },
          tx,
        );
        return created;
      });
      await this.cache.invalidate('catalog:');
      return toAdminImage(this.storage, image);
    } catch (e) {
      await this.storage.remove(written).catch(() => undefined);
      throw e;
    }
  }

  async update(productId: number, imageId: number, input: AdminImageInput, meta: Meta): Promise<AdminImage> {
    const color = await this.colorValue(input.colorCode);
    const image = await this.prisma.$transaction(async (tx) => {
      const before = await this.find(tx, productId, imageId);
      const updated = await tx.image.update({
        where: { id: imageId },
        data: { altHe: input.altHe, kind: KIND[input.kind], colorValueId: color?.id ?? null },
        include: imageInclude,
      });
      const [b, a] = [summary(before), summary(updated)];
      if (JSON.stringify(b) !== JSON.stringify(a))
        await this.audit.record(
          {
            ...auditBase(meta),
            action: 'image.update',
            entityType: 'product',
            entityId: productId,
            before: b,
            after: a,
          },
          tx,
        );
      return updated;
    });
    await this.cache.invalidate('catalog:');
    return toAdminImage(this.storage, image);
  }

  /** `ids` must list every photo of the product, in the new order. */
  async reorder(productId: number, ids: number[], meta: Meta): Promise<AdminImage[]> {
    const images = await this.prisma.$transaction(async (tx) => {
      const current = await tx.image.findMany({ where: { productId }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
      const known = new Set(current.map((i) => i.id));
      if (ids.length !== current.length || new Set(ids).size !== ids.length || ids.some((i) => !known.has(i)))
        throw invalid('ids');
      if (current.some((image, i) => image.id !== ids[i])) {
        for (const [sortOrder, id] of ids.entries()) await tx.image.update({ where: { id }, data: { sortOrder } });
        await this.audit.record(
          {
            ...auditBase(meta),
            action: 'image.reorder',
            entityType: 'product',
            entityId: productId,
            before: { order: current.map((i) => i.id) },
            after: { order: ids },
          },
          tx,
        );
      }
      return tx.image.findMany({
        where: { productId },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        include: imageInclude,
      });
    });
    await this.cache.invalidate('catalog:');
    return images.map((i) => toAdminImage(this.storage, i));
  }

  async remove(productId: number, imageId: number, meta: Meta): Promise<void> {
    const image = await this.prisma.$transaction(async (tx) => {
      // Lock the product, so a save that activates it and this delete run one after the other.
      const [product] = await tx.$queryRaw<{ active: boolean }[]>`
        SELECT active FROM products WHERE id = ${productId} FOR UPDATE`;
      if (!product) throw notFound();
      const found = await this.find(tx, productId, imageId);
      if (product.active && (await tx.image.count({ where: { productId } })) === 1) throw incomplete(['no_images']);
      await tx.image.delete({ where: { id: imageId } });
      await this.audit.record(
        {
          ...auditBase(meta),
          action: 'image.delete',
          entityType: 'product',
          entityId: productId,
          before: summary(found),
        },
        tx,
      );
      return found;
    });
    await this.cache.invalidate('catalog:');
    await this.removeFiles([image]);
  }

  /** Deletes stored files after their rows are gone. A failure leaves only an orphan file behind. */
  async removeFiles(images: { storageKey: string | null; widths: number[] }[]): Promise<void> {
    try {
      await this.storage.remove(images.flatMap(imageFiles));
    } catch (e) {
      this.logger.warn(`Could not delete image files: ${String(e)}`);
    }
  }

  private async find(tx: Prisma.TransactionClient, productId: number, imageId: number) {
    const image = await tx.image.findUnique({ where: { id: imageId }, include: imageInclude });
    if (!image || image.productId !== productId) throw notFound();
    return image;
  }

  private async colorValue(code: string | null) {
    if (code === null) return null;
    const value = await this.prisma.attributeValue.findFirst({ where: { code, attribute: { code: 'color' } } });
    if (!value) throw invalid('colorCode');
    return value;
  }
}

const uploadProblem = (problem: ImageUploadProblem) => invalid('file', problem);

function summary(image: { id: number; altHe: string; kind: ImageKind; colorValue: { code: string } | null }) {
  return {
    imageId: image.id,
    color: image.colorValue?.code ?? null,
    kind: image.kind.toLowerCase(),
    altHe: image.altHe,
  };
}
