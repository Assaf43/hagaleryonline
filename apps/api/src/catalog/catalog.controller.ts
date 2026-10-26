import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import type { CategoryNode, ProductDetail, ProductListResponse, RoomMenuItem, SearchSuggestions } from '@hg/models';
import { CatalogService } from './catalog.service.js';
import { parseProductListQuery } from './product-list-query.js';

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
