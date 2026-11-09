import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PageMeta } from '../core/page-meta';
import { SIZING_GUIDE, SIZING_STEPS } from './sizing-guide.text';

/** How to measure at home before ordering (PRD-11). Indexable. */
@Component({
  selector: 'hg-sizing-guide-page',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './sizing-guide.page.html',
  styleUrl: './sizing-guide.page.scss',
})
export class SizingGuidePage {
  protected readonly guide = SIZING_GUIDE;
  protected readonly steps = SIZING_STEPS;

  constructor() {
    inject(PageMeta).set({
      title: SIZING_GUIDE.titleHe,
      description: SIZING_GUIDE.descriptionHe,
      path: '/sizing-guide',
    });
  }
}
