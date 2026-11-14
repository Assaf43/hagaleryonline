import { ChangeDetectionStrategy, Component, DestroyRef, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';
import { SupportApi } from '../core/support.api';

/** "4 פניות חדשות" / "פנייה חדשה אחת" for screen readers. */
export function newTicketsLabel(count: number): string {
  return count === 1 ? 'פנייה חדשה אחת' : `${count} פניות חדשות`;
}

/**
 * The "new" counter next to "פניות" in the menu (spec §7.2). Loaded when the menu appears and again after every
 * navigation; the ticket page also refreshes it after a status change. No polling. Shown only when above zero.
 */
@Component({
  selector: 'hga-new-count-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (api.newCount(); as count) {
      <span class="count" aria-hidden="true">{{ count }}</span>
      <span class="visually-hidden">({{ label(count) }})</span>
    }
  `,
  styles: `
    :host {
      display: contents;
    }

    .count {
      margin-inline-start: auto;
      min-inline-size: 1.5rem;
      padding: var(--badge-padding-block) var(--badge-padding-inline);
      font-size: var(--font-caption);
      font-weight: 700;
      text-align: center;
      color: var(--color-on-accent);
      background: var(--color-accent);
      border-radius: var(--radius-pill);
    }
  `,
})
export class NewCountBadge {
  protected readonly api = inject(SupportApi);
  protected readonly label = newTicketsLabel;

  constructor() {
    void this.api.refreshNewCount();
    inject(Router)
      .events.pipe(
        filter((e) => e instanceof NavigationEnd),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe(() => void this.api.refreshNewCount());
  }
}
