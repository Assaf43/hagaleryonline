import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { FaqView, HomeView, InfoPageView, SiteContentView } from '@hg/models';

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
}
