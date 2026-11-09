import { DOCUMENT, Injectable, RESPONSE_INIT, inject } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { BRAND } from '@hg/models';
import { SITE_ORIGIN } from './server-tokens';

export const SITE_NAME: string = BRAND.name;

export interface PageInfo {
  title: string;
  description: string;
  /** Path of the canonical URL, e.g. "/category/sofas" (query strings are left out on purpose). */
  path: string;
  image?: string | null;
  /** Filtered or paged listings are not indexed separately (NFR-04). */
  noindex?: boolean;
}

/** Title, description, canonical link and Open Graph tags of the current page (NFR-04). */
@Injectable({ providedIn: 'root' })
export class PageMeta {
  private readonly title = inject(Title);
  private readonly meta = inject(Meta);
  private readonly document = inject(DOCUMENT);
  private readonly origin = inject(SITE_ORIGIN);
  private readonly response = inject(RESPONSE_INIT, { optional: true });

  set(page: PageInfo): void {
    const title = page.title === SITE_NAME ? SITE_NAME : `${page.title} | ${SITE_NAME}`;
    const url = `${this.origin}${page.path}`;
    this.title.setTitle(title);
    this.meta.updateTag({ name: 'description', content: page.description });
    this.meta.updateTag({ name: 'robots', content: page.noindex ? 'noindex, follow' : 'index, follow' });
    this.meta.updateTag({ property: 'og:title', content: title });
    this.meta.updateTag({ property: 'og:description', content: page.description });
    this.meta.updateTag({ property: 'og:url', content: url });
    this.meta.updateTag({ property: 'og:type', content: 'website' });
    this.meta.updateTag({ property: 'og:site_name', content: SITE_NAME });
    this.meta.updateTag({ property: 'og:locale', content: 'he_IL' });
    if (page.image) this.meta.updateTag({ property: 'og:image', content: new URL(page.image, this.origin).href });
    else this.meta.removeTag('property="og:image"');
    this.canonical(url);
  }

  /** Server render of a missing page answers 404, so search engines drop it. */
  notFound(): void {
    if (this.response) this.response.status = 404;
    this.set({ title: 'הדף לא נמצא', description: 'הדף שחיפשתם לא קיים.', path: '/', noindex: true });
  }

  /** Server render of a page whose data failed to load answers 503, so search engines retry later. */
  serverError(): void {
    if (this.response) this.response.status = 503;
    this.set({ title: 'שגיאה בטעינת הדף', description: 'לא הצלחנו לטעון את הדף.', path: '/', noindex: true });
  }

  private canonical(url: string): void {
    let link = this.document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!link) {
      link = this.document.createElement('link');
      link.rel = 'canonical';
      this.document.head.appendChild(link);
    }
    link.href = url;
  }
}
