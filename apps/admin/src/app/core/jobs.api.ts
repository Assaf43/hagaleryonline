import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { AdminFailedJob } from '@hg/models';

/** Outbox jobs that failed after all their retries, and their retry (spec §5.1, permission orders.manage). */
@Injectable({ providedIn: 'root' })
export class JobsApi {
  private readonly http = inject(HttpClient);

  failed() {
    return firstValueFrom(this.http.get<AdminFailedJob[]>('/api/admin/jobs/failed'));
  }

  retry(id: string) {
    return firstValueFrom(this.http.post<void>(`/api/admin/jobs/${encodeURIComponent(id)}/retry`, {}));
  }
}
