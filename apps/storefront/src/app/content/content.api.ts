import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { FaqView, LandingResponse, HomeView, InfoPageView, SiteContentView } from '@hg/models';

/** The public content API (Phase 8a). GET answers rendered on the server reach the browser through the transfer cache. */
@Injectable({ providedIn: 'root' })
export class ContentApi {
  private readonly http = inject(HttpClient);

  site() {
    return firstValueFrom(this.http.get<SiteContentView>('/api/content/site'));
  }

  page(slug: string) {
    return firstValueFrom(this.http.get<InfoPageView>(`/api/content/pages/${encodeURIComponent(slug)}`));
  }

  faq() {
    return firstValueFrom(this.http.get<FaqView>('/api/content/faq'));
  }

  /** The home page's visible sections, resolved by the API in one call (NAV-05). */
  home() {
    return firstValueFrom(this.http.get<HomeView>('/api/content/home'));
  }

  /**
   * A landing page (MKT-02). A preview answer carries a staff token: it stays out of the HTTP transfer cache so the
   * token never reaches the page's HTML (404 and 410 reach the caller as an `HttpErrorResponse`).
   */
  landing(slug: string, preview?: string | null) {
    const url = `/api/content/landing/${encodeURIComponent(slug)}`;
    return firstValueFrom(
      preview
        ? this.http.get<LandingResponse>(url, { params: { preview }, transferCache: false })
        : this.http.get<LandingResponse>(url),
    );
  }
}
