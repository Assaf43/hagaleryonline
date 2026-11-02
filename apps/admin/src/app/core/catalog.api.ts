import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type {
  AdminAttributeInput,
  AdminAttributeValueInput,
  AdminCategoryInput,
  AdminProduct,
  AdminProductInput,
  AdminProductPage,
  AdminRoomInput,
  AdminSynonym,
  CatalogStructure,
  ProductStatusFilter,
} from '@hg/models';

const BASE = '/api/admin/catalog';

/** Products, prices, stock and the catalog structure (Phase 2b). */
@Injectable({ providedIn: 'root' })
export class CatalogApi {
  private readonly http = inject(HttpClient);

  structure() {
    return firstValueFrom(this.http.get<CatalogStructure>(`${BASE}/structure`));
  }

  products(filter: { q?: string; categoryId?: number; status?: ProductStatusFilter; page?: number }) {
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(filter))
      if (value !== undefined && value !== '') params[key] = `${value}`;
    return firstValueFrom(this.http.get<AdminProductPage>(`${BASE}/products`, { params }));
  }

  product(id: number) {
    return firstValueFrom(this.http.get<AdminProduct>(`${BASE}/products/${id}`));
  }

  createProduct(input: AdminProductInput) {
    return firstValueFrom(this.http.post<AdminProduct>(`${BASE}/products`, input));
  }

  updateProduct(id: number, input: AdminProductInput) {
    return firstValueFrom(this.http.put<AdminProduct>(`${BASE}/products/${id}`, input));
  }

  deleteProduct(id: number) {
    return firstValueFrom(this.http.delete<void>(`${BASE}/products/${id}`));
  }

  saveCategory(id: number | null, input: AdminCategoryInput) {
    return this.save(id ? `categories/${id}` : 'categories', id, input);
  }

  saveRoom(id: number | null, input: AdminRoomInput) {
    return this.save(id ? `rooms/${id}` : 'rooms', id, input);
  }

  saveAttribute(id: number | null, input: AdminAttributeInput) {
    return this.save(id ? `attributes/${id}` : 'attributes', id, input);
  }

  saveValue(attributeId: number, id: number | null, input: AdminAttributeValueInput) {
    return this.save(`attributes/${attributeId}/values${id ? `/${id}` : ''}`, id, input);
  }

  deleteValue(attributeId: number, id: number) {
    return firstValueFrom(this.http.delete<void>(`${BASE}/attributes/${attributeId}/values/${id}`));
  }

  saveSynonym(id: number | null, terms: string[]) {
    return this.save<AdminSynonym>(id ? `synonyms/${id}` : 'synonyms', id, { terms });
  }

  deleteSynonym(id: number) {
    return firstValueFrom(this.http.delete<void>(`${BASE}/synonyms/${id}`));
  }

  private save<T = void>(path: string, id: number | null, body: object) {
    const url = `${BASE}/${path}`;
    return firstValueFrom(id ? this.http.patch<T>(url, body) : this.http.post<T>(url, body));
  }
}
