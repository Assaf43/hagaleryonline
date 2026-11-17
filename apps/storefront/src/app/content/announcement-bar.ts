import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { LucideX } from '@lucide/angular';
import { SiteContentStore } from './site-content.store';

/** The announcement bar above the header (NAV-04): one message, an optional link, a close button. */
@Component({
  selector: 'hg-announcement-bar',
  imports: [LucideX],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.announcement(); as a) {
      <div class="bar" role="region" aria-label="הודעה">
        <div class="container row">
          <p>
            {{ a.textHe }}
            @if (a.linkUrl) {
              <a [href]="a.linkUrl">{{ a.linkLabelHe || 'לפרטים' }}</a>
            }
          </p>
          <button type="button" class="close" aria-label="סגירת ההודעה" (click)="store.close(a)">
            <svg lucideX aria-hidden="true"></svg>
          </button>
        </div>
      </div>
    }
  `,
  styles: `
    .bar {
      background: var(--color-accent);
      color: var(--color-on-accent);
      font-size: var(--font-small);
    }

    .row {
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      padding-block: var(--space-2);
      padding-inline: var(--space-7);
    }

    p {
      margin: 0;
      text-align: center;
    }

    a {
      color: inherit;
      text-decoration: underline;
      margin-inline-start: var(--space-2);
    }

    .close {
      position: absolute;
      inset-inline-end: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-inline-size: var(--control-height-sm);
      min-block-size: var(--control-height-sm);
      background: transparent;
      color: inherit;
      border: 0;
      cursor: pointer;
    }
  `,
})
export class AnnouncementBar {
  protected readonly store = inject(SiteContentStore);
}
