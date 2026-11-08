import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { CategoryNode, ProductDetail, ProductListResponse, RoomMenuItem } from '@hg/models';

/**
 * The public catalog API (Phase 1). GET responses rendered on the server are handed to the browser
 * with the page (Angular's HTTP transfer cache), so hydration does not fetch them again.
 */
@Injectable({ providedIn: 'root' })
export class CatalogApi {
  private readonly http = inject(HttpClient);

  rooms() {
    return firstValueFrom(this.http.get<RoomMenuItem[]>('/api/rooms'));
  }

  categories() {
    return firstValueFrom(this.http.get<CategoryNode[]>('/api/categories'));
  }

  /** `params` are the API's query parameters (see `toApiParams`). */
  products(params: Record<string, string>) {
    return firstValueFrom(
      this.http.get<ProductListResponse>('/api/products', { params: new HttpParams({ fromObject: params }) }),
    );
  }

  product(slug: string) {
    return firstValueFrom(this.http.get<ProductDetail>(`/api/products/${encodeURIComponent(slug)}`));
  }
}
