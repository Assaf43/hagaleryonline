import { ChangeDetectionStrategy, Component, PendingTasks, inject, signal } from '@angular/core';
import { LucideChevronDown } from '@lucide/angular';
import type { FaqView } from '@hg/models';
import { PageMeta } from '../core/page-meta';
import { ContentApi } from './content.api';
import { RichText } from './rich-text';

/** `/faq` (SRV-04): groups of questions as native details / summary (works without script). */
@Component({
  selector: 'hg-faq-page',
  imports: [RichText, LucideChevronDown],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="container page">
      <h1>שאלות ותשובות</h1>
      @if (failed()) {
        <p class="error" role="alert">לא הצלחנו לטעון את השאלות. נסו שוב.</p>
        <button type="button" class="btn btn-secondary" (click)="load()">נסו שוב</button>
      } @else if (faq(); as f) {
        @for (g of f.groups; track g.titleHe) {
          <section class="group">
            <h2>{{ g.titleHe }}</h2>
            @for (item of g.items; track item.questionHe) {
              <details>
                <summary>
                  {{ item.questionHe }}
                  <svg lucideChevronDown aria-hidden="true"></svg>
                </summary>
                <div class="answer"><hg-rich-text [html]="item.answerHtml" /></div>
              </details>
            }
          </section>
        } @empty {
          <p>אין כרגע שאלות להצגה.</p>
        }
      }
    </section>
  `,
  styles: `
    .page {
      display: grid;
      gap: var(--space-5);
      padding-block: var(--space-5) var(--space-7);
      max-inline-size: 760px;
    }

    h1,
    h2 {
      margin: 0;
    }

    h2 {
      font-size: var(--font-h3);
    }

    .group {
      display: grid;
      gap: var(--space-2);
    }

    details {
      border-block-end: var(--border-width) solid var(--color-border);
    }

    summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      padding-block: var(--space-3);
      cursor: pointer;
      font-weight: 600;
      list-style: none;
    }

    summary::-webkit-details-marker {
      display: none;
    }

    details[open] summary svg {
      transform: rotate(180deg);
    }

    .answer {
      padding-block-end: var(--space-3);
      color: var(--color-text-secondary);
    }
  `,
})
export class FaqPage {
  private readonly api = inject(ContentApi);
  private readonly tasks = inject(PendingTasks);
  private readonly meta = inject(PageMeta);

  protected readonly faq = signal<FaqView | null>(null);
  protected readonly failed = signal(false);

  constructor() {
    this.setMeta();
    this.load();
  }

  protected load(): void {
    void this.tasks.run(async () => {
      this.failed.set(false);
      try {
        this.faq.set(await this.api.faq());
        this.setMeta();
      } catch {
        this.failed.set(true);
        this.meta.serverError();
      }
    });
  }

  private setMeta(): void {
    this.meta.set({
      title: 'שאלות ותשובות',
      description: 'תשובות לשאלות נפוצות על משלוחים, החזרות ועוד.',
      path: '/faq',
    });
  }
}
