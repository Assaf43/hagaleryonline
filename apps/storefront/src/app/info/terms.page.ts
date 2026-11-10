import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { PageMeta } from '../core/page-meta';
import { TERMS, TERMS_SECTIONS } from './terms.text';

/** "תנאי שימוש" `/terms` (spec §5.1): INTERIM text from terms.text.ts; noindex until the real wording arrives. */
@Component({
  selector: 'hg-terms-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <article class="container page">
      <h1>{{ terms.titleHe }}</h1>
      <p class="intro">{{ terms.introHe }}</p>
      @for (s of sections; track s.titleHe) {
        <section>
          <h2>{{ s.titleHe }}</h2>
          @for (p of s.paragraphs; track $index) {
            <p>{{ p }}</p>
          }
        </section>
      }
    </article>
  `,
  styles: `
    .page {
      display: grid;
      gap: var(--space-5);
      padding-block: var(--space-5) var(--space-7);
      max-inline-size: 760px;
    }

    h1,
    h2,
    p {
      margin: 0;
    }

    h2 {
      font-size: var(--font-h3);
      margin-block-end: var(--space-2);
    }

    section {
      display: grid;
      gap: var(--space-2);
    }

    .intro {
      color: var(--color-text-secondary);
    }
  `,
})
export class TermsPage {
  protected readonly terms = TERMS;
  protected readonly sections = TERMS_SECTIONS;

  constructor() {
    inject(PageMeta).set({ title: TERMS.titleHe, description: TERMS.descriptionHe, path: '/terms', noindex: true });
  }
}
