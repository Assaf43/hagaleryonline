import { ChangeDetectionStrategy, Component } from '@angular/core';
import { LucideRuler, LucideSlidersHorizontal, LucideTruck } from '@lucide/angular';

/** The three-point trust strip. */
@Component({
  selector: 'hg-home-trust',
  imports: [LucideRuler, LucideSlidersHorizontal, LucideTruck],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ul class="trust" aria-label="למה לקנות אצלנו">
      <li><svg lucideRuler aria-hidden="true"></svg>מידות מלאות לכל דגם</li>
      <li><svg lucideSlidersHorizontal aria-hidden="true"></svg>סינון לפי רוחב ועומק בס״מ</li>
      <li><svg lucideTruck aria-hidden="true"></svg>משלוח עד הבית</li>
    </ul>
  `,
  styles: `
    :host {
      display: contents;
    }

    .trust {
      list-style: none;
      margin: 0;
      padding: var(--space-5) 0;
      display: grid;
      gap: var(--space-4);
      border-block: var(--border-width) solid var(--color-border);

      li {
        display: flex;
        gap: var(--space-3);
        align-items: center;
        font-size: var(--font-small);
        font-weight: 600;
      }

      svg {
        inline-size: 28px;
        block-size: 28px;
        color: var(--color-accent);
      }
    }

    @media (width >= 768px) {
      .trust {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
    }
  `,
})
export class HomeTrust {}
