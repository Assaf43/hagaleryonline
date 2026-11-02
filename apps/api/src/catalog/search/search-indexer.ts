import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { descriptionText } from '../description-html.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { buildProductSearchText } from './search-text.js';

const label = { select: { attributeValue: { select: { labelHe: true } } } };

/**
 * Keeps products.search_text in step with the catalog (decision 47). Runs after every admin save,
 * and over all products when a name they borrow changes (a category, a closed-list value).
 * Writes with plain SQL so updated_at — the concurrent-edit check — is left alone.
 */
@Injectable()
export class SearchIndexer {
  constructor(private readonly prisma: PrismaService) {}

  /** Rebuilds the given products, or every product when `productIds` is omitted. Returns how many changed. */
  async reindex(productIds?: number[], tx: Prisma.TransactionClient = this.prisma): Promise<number> {
    const products = await tx.product.findMany({
      where: productIds ? { id: { in: productIds } } : {},
      select: {
        id: true,
        modelName: true,
        nameHe: true,
        descriptionHe: true,
        searchText: true,
        category: { select: { nameHe: true, parent: { select: { nameHe: true } } } },
        attributeValues: label,
        variants: { select: { sku: true, attributeValues: label } },
      },
    });

    let changed = 0;
    for (const p of products) {
      const searchText = buildProductSearchText({
        modelName: p.modelName,
        nameHe: p.nameHe,
        descriptionHe: descriptionText(p.descriptionHe),
        categoryNamesHe: [p.category.parent?.nameHe, p.category.nameHe].filter((n): n is string => !!n),
        attributeLabelsHe: [
          ...p.attributeValues.map((a) => a.attributeValue.labelHe),
          ...p.variants.flatMap((v) => v.attributeValues.map((a) => a.attributeValue.labelHe)),
        ],
        skus: p.variants.map((v) => v.sku),
      });
      if (searchText === p.searchText) continue;
      await tx.$executeRaw`UPDATE products SET search_text = ${searchText} WHERE id = ${p.id}`;
      changed++;
    }
    return changed;
  }
}
