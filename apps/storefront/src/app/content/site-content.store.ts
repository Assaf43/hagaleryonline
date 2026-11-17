import { DOCUMENT, Injectable, REQUEST, computed, inject, signal } from '@angular/core';
import type { AnnouncementView, SiteContentView } from '@hg/models';
import { ContentApi } from './content.api';

/** Cookie holding the closed announcement as `id:version` (not httpOnly: the browser writes it; SSR reads it). */
export const ANNOUNCEMENT_COOKIE = 'hg-ann';
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** The `id:version` of the closed announcement in a Cookie header, or null. */
export function readClosedAnnouncement(cookieHeader: string | null | undefined): string | null {
  const match = /(?:^|;\s*)hg-ann=(\d+:\d+)(?:;|$)/.exec(cookieHeader ?? '');
  return match ? match[1] : null;
}

/**
 * Site details, the current announcement and the footer pages (NAV-04, SRV-04), loaded once for the whole app. The
 * closed announcement is read from the request cookie on the server (so a closed bar is never rendered) and from
 * `document.cookie` in the browser; a new version has a different `id:version`, so the bar shows again.
 */
@Injectable({ providedIn: 'root' })
export class SiteContentStore {
  private readonly api = inject(ContentApi);
  private readonly document = inject(DOCUMENT);
  private readonly request = inject(REQUEST, { optional: true });
  private loading: Promise<void> | null = null;

  readonly site = signal<SiteContentView | null>(null);
  private readonly closed = signal<string | null>(
    readClosedAnnouncement(this.request ? this.request.headers.get('cookie') : this.document.cookie),
  );

  /** The announcement to show now: none when the visitor closed this version. */
  readonly announcement = computed<AnnouncementView | null>(() => {
    const a = this.site()?.announcement ?? null;
    return a && this.closed() !== `${a.id}:${a.version}` ? a : null;
  });
  readonly footerPages = computed(() => this.site()?.footerPages ?? []);
  readonly contact = computed(() => {
    const s = this.site();
    return { phone: s?.supportPhone ?? '', email: s?.supportEmail ?? '', whatsapp: s?.whatsapp ?? '' };
  });
  readonly shippingHtml = computed(() => this.site()?.shippingHtml ?? '');

  /** Loads once per app (the server render passes the result to the browser). */
  load(): Promise<void> {
    this.loading ??= this.api
      .site()
      .then((site) => this.site.set(site))
      .catch(() => {
        // The site works without the bar and the footer pages; try again on the next navigation.
        this.loading = null;
      });
    return this.loading;
  }

  /** Remembers the closed announcement on this device for 30 days and hides the bar. */
  close(a: AnnouncementView): void {
    const value = `${a.id}:${a.version}`;
    const secure = this.document.location?.protocol === 'https:' ? '; Secure' : '';
    try {
      this.document.cookie = `${ANNOUNCEMENT_COOKIE}=${value}; Max-Age=${MAX_AGE_SECONDS}; Path=/; SameSite=Lax${secure}`;
    } catch {
      // Without cookies the bar is hidden for this visit only.
    }
    this.closed.set(value);
  }
}
