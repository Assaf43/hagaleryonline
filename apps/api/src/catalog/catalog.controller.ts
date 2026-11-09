import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import type {
  CategoryNode,
  ProductCard,
  ProductDetail,
  ProductListResponse,
  RelatedProducts,
  RoomMenuItem,
  SearchSuggestions,
} from '@hg/models';
import { CatalogService } from './catalog.service.js';
import { parseCardIds, parseProductListQuery } from './product-list-query.js';

@Controller()
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('categories')
  categories(): Promise<CategoryNode[]> {
    return this.catalog.categories();
  }

  @Get('rooms')
  rooms(): Promise<RoomMenuItem[]> {
    return this.catalog.rooms();
  }

  @Get('products')
  products(@Query() raw: Record<string, unknown>): Promise<ProductListResponse> {
    return this.catalog.products(parseProductListQuery(raw));
  }

  /** Declared before `products/:slug` so "cards" is not taken for a slug. */
  @Get('products/cards')
  cards(@Query('ids') ids: unknown): Promise<ProductCard[]> {
    return this.catalog.cards(parseCardIds(ids));
  }

  @Get('products/:slug/related')
  async related(@Param('slug') slug: string): Promise<RelatedProducts> {
    const related = await this.catalog.related(slug);
    if (!related) throw new NotFoundException('product not found');
    return related;
  }

  @Get('products/:slug')
  async product(@Param('slug') slug: string): Promise<ProductDetail> {
    const product = await this.catalog.product(slug);
    if (!product) throw new NotFoundException('product not found');
    return product;
  }

  @Get('search/suggest')
  suggest(@Query('q') q: unknown): Promise<SearchSuggestions> {
    return this.catalog.suggest(typeof q === 'string' ? q.slice(0, 100) : '');
  }
}
