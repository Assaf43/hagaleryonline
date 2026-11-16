import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { StoreInfo } from '@hg/models';

/** The physical store's details (Phase 6, Super Admin only; shown only in the admin, decision 43). */
@Injectable({ providedIn: 'root' })
export class StoreApi {
  private readonly http = inject(HttpClient);

  get() {
    return firstValueFrom(this.http.get<StoreInfo>('/api/admin/store'));
  }

  save(input: Omit<StoreInfo, 'id'>) {
    return firstValueFrom(this.http.put<StoreInfo>('/api/admin/store', input));
  }
}
