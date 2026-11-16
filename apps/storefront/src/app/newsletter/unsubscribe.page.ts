import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  inject,
  input,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { PageMeta } from '../core/page-meta';
import { NewsletterApi } from './newsletter.api';
import { NEWSLETTER_COPY as COPY } from './newsletter.copy';

/**
 * `/newsletter/unsubscribe?t=` (CLB-02, decision 95): the unsubscribe link in every marketing e-mail. It waits for a
 * click, because mail scanners open links on their own; the answer is always the same done state. Without a token it
 * says the link is invalid and sends nothing. noindex.
 */
@Component({
  selector: 'hg-newsletter-unsubscribe-page',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="container page">
      @if (!t()) {
        <h1 tabindex="-1">{{ copy.unsubscribeTitle }}</h1>
        <p role="alert">{{ copy.linkInvalid }}</p>
        <p>
          <a class="btn btn-secondary" routerLink="/">{{ copy.toHome }}</a>
        </p>
      } @else if (done()) {
        <h1 tabindex="-1">{{ copy.unsubscribed }}</h1>
        <p role="status">{{ copy.unsubscribedText }}</p>
        <p>
          <a class="btn btn-secondary" routerLink="/">{{ copy.toHome }}</a>
        </p>
      } @else {
        <h1>{{ copy.unsubscribeTitle }}</h1>
        <p>{{ copy.unsubscribeText }}</p>
        <p class="form-error" role="alert">{{ error() }}</p>
        <p>
          <button type="button" class="btn btn-primary" [disabled]="busy()" (click)="unsubscribe()">
            {{ copy.unsubscribeButton }}
          </button>
        </p>
      }
    </section>
  `,
  styles: `
    .page {
      display: grid;
      gap: var(--space-4);
      padding-block: var(--space-7);
      max-inline-size: 520px;
      align-content: start;
    }

    h1,
    p {
      margin: 0;
    }

    .form-error {
      color: var(--color-danger);
      font-size: var(--font-small);

      &:empty {
        display: none;
      }
    }
  `,
})
export class NewsletterUnsubscribePage {
  /** The token from the query string (`?t=`). */
  readonly t = input<string | undefined>(undefined);

  private readonly api = inject(NewsletterApi);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  protected readonly copy = COPY;
  protected readonly busy = signal(false);
  protected readonly done = signal(false);
  protected readonly error = signal('');

  constructor() {
    inject(PageMeta).set({
      title: COPY.unsubscribeTitle,
      description: COPY.unsubscribeTitle,
      path: '/newsletter/unsubscribe',
      noindex: true,
    });
  }

  protected async unsubscribe(): Promise<void> {
    if (this.busy() || !this.t()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.api.unsubscribe(this.t() ?? '');
      this.done.set(true);
      // The new heading takes the focus, so screen readers announce the done state.
      afterNextRender(() => this.host.nativeElement.querySelector('h1')?.focus(), { injector: this.injector });
    } catch {
      this.error.set(COPY.failed);
    } finally {
      this.busy.set(false);
    }
  }
}
