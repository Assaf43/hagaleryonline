import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { ErrorGroupDetail, ErrorGroupPage, ErrorGroupState, SystemStatus } from '@hg/models';

/** The "תקלות ומצב המערכת" endpoints (permission system.view). */
@Injectable({ providedIn: 'root' })
export class SystemApi {
  private readonly http = inject(HttpClient);

  status() {
    return firstValueFrom(this.http.get<SystemStatus>('/api/admin/system/status'));
  }

  errors(state: ErrorGroupState, page: number) {
    return firstValueFrom(
      this.http.get<ErrorGroupPage>('/api/admin/system/errors', { params: { state, page: String(page) } }),
    );
  }

  error(id: number) {
    return firstValueFrom(this.http.get<ErrorGroupDetail>(`/api/admin/system/errors/${id}`));
  }

  markHandled(id: number) {
    return firstValueFrom(this.http.post<void>(`/api/admin/system/errors/${id}/handled`, {}));
  }
}
