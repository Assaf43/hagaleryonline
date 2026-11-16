import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

/** What the storefront reads from a newsletter API error. */
export interface NewsletterFailure {
  status: number;
  /** A plain string from the API (`invalid_input`, `link_invalid`); not a typed union. */
  code: string | null;
  field: string | null;
}

export function newsletterFailure(error: unknown): NewsletterFailure {
  if (!(error instanceof HttpErrorResponse)) return { status: 0, code: null, field: null };
  const body = (typeof error.error === 'object' && error.error !== null ? error.error : {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' ? v : null);
  return { status: error.status, code: text(body['code']), field: text(body['field']) };
}

/** The public newsletter endpoints (MKT-01, CLB-02, decision 95). Only called in the browser. */
@Injectable({ providedIn: 'root' })
export class NewsletterApi {
  private readonly http = inject(HttpClient);

  /** 202 `{}` for every valid request, whatever the address's state. */
  subscribe(body: { email: string; consent: true; website: string }) {
    return firstValueFrom(this.http.post<object>('/api/newsletter', body));
  }

  /** `{ email }` is already masked by the API. */
  confirm(token: string) {
    return firstValueFrom(this.http.post<{ email: string }>('/api/newsletter/confirm', { token }));
  }

  /** 204 always. */
  unsubscribe(token: string) {
    return firstValueFrom(this.http.post<void>('/api/newsletter/unsubscribe', { token }));
  }
}
