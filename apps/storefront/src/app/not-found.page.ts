import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PageMeta } from './core/page-meta';

/** Any unknown address: a friendly page, and a real 404 status from the server render. */
@Component({
  selector: 'hg-not-found-page',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="container empty">
      <h1>הדף לא נמצא</h1>
      <p class="muted">ייתכן שהקישור שגוי או שהדף הוסר.</p>
      <a routerLink="/" class="btn btn-primary">לדף הבית</a>
    </section>
  `,
  styles: `
    .empty {
      display: grid;
      justify-items: center;
      gap: var(--space-3);
      text-align: center;
      padding-block: var(--space-9);
    }
  `,
})
export class NotFoundPage {
  constructor() {
    inject(PageMeta).notFound();
  }
}
