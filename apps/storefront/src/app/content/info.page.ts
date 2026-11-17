import {
  ChangeDetectionStrategy,
  Component,
  PendingTasks,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import type { InfoPageView } from '@hg/models';
import { PageMeta } from '../core/page-meta';
import { ContentApi } from './content.api';
import { RichText } from './rich-text';

/** "28.05.2026" in Israel time. */
export function formatPageDate(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')}.${get('month')}.${get('year')}`;
}

/** `/info/:slug` (SRV-04): a published info page; an unknown or unpublished one is a real 404. */
@Component({
  selector: 'hg-info-page',
  imports: [RichText, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <article class="container page">
      @if (notFound()) {
        <h1>הדף לא נמצא</h1>
        <a routerLink="/" class="btn btn-secondary">לדף הבית</a>
      } @else if (failed()) {
        <p class="error" role="alert">לא הצלחנו לטעון את הדף. נסו שוב.</p>
        <button type="button" class="btn btn-secondary" (click)="load(slug())">נסו שוב</button>
      } @else if (page(); as p) {
        <h1>{{ p.titleHe }}</h1>
        <hg-rich-text [html]="p.bodyHtml" />
        <p class="updated">
          עודכן לאחרונה: <bdi>{{ date(p.updatedAt) }}</bdi>
        </p>
      }
    </article>
  `,
  styles: `
    .page {
      display: grid;
      gap: var(--space-4);
      padding-block: var(--space-5) var(--space-7);
      max-inline-size: 760px;
    }

    h1 {
      margin: 0;
    }

    .updated {
      margin: 0;
      color: var(--color-text-secondary);
      font-size: var(--font-small);
    }
  `,
})
export class InfoPage {
  readonly slug = input.required<string>();

  private readonly api = inject(ContentApi);
  private readonly meta = inject(PageMeta);
  private readonly tasks = inject(PendingTasks);

  protected readonly page = signal<InfoPageView | null>(null);
  protected readonly notFound = signal(false);
  protected readonly failed = signal(false);
  protected readonly date = formatPageDate;

  constructor() {
    effect(() => {
      const slug = this.slug();
      untracked(() => this.load(slug));
    });
  }

  protected load(slug: string): void {
    void this.tasks.run(async () => {
      this.page.set(null);
      this.notFound.set(false);
      this.failed.set(false);
      try {
        const page = await this.api.page(slug);
        this.page.set(page);
        this.meta.set({
          title: page.titleHe,
          description: page.metaDescriptionHe ?? page.titleHe,
          path: `/info/${page.slug}`,
          noindex: page.noindex,
        });
      } catch (error) {
        if (error instanceof HttpErrorResponse && error.status === 404) {
          this.notFound.set(true);
          this.meta.notFound();
        } else {
          this.failed.set(true);
          this.meta.serverError();
        }
      }
    });
  }
}
