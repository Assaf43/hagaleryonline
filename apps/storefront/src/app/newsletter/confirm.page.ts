import { ChangeDetectionStrategy, Component, afterNextRender, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PageMeta } from '../core/page-meta';
import { NewsletterApi } from './newsletter.api';
import { NEWSLETTER_COPY as COPY } from './newsletter.copy';

type State = 'loading' | 'ok' | 'invalid';

/**
 * `/newsletter/confirm?t=` (MKT-01, CLB-02): the link in the confirmation e-mail. The token is sent from the browser
 * after hydration, so the server-rendered HTML holds no address; on success the API's already masked address is shown.
 * An unknown, used or expired token reads the same "invalid or expired link". noindex.
 */
@Component({
  selector: 'hg-newsletter-confirm-page',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="container page">
      <h1 tabindex="-1">{{ title() }}</h1>
      @switch (state()) {
        @case ('loading') {
          <p role="status">{{ copy.confirming }}</p>
        }
        @case ('ok') {
          <p role="status">
            {{ copy.confirmedFor }} <bdi dir="ltr">{{ masked() }}</bdi>
          </p>
        }
        @default {
          <p role="alert">{{ copy.linkInvalid }}</p>
        }
      }
      @if (state() !== 'loading') {
        <p>
          <a class="btn btn-secondary" routerLink="/">{{ copy.toHome }}</a>
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
  `,
})
export class NewsletterConfirmPage {
  /** The token from the query string (`?t=`). */
  readonly t = input<string | undefined>(undefined);

  private readonly api = inject(NewsletterApi);
  protected readonly copy = COPY;
  protected readonly state = signal<State>('loading');
  protected readonly masked = signal('');
  protected readonly title = signal<string>(COPY.confirmTitle);

  constructor() {
    inject(PageMeta).set({
      title: COPY.confirmTitle,
      description: COPY.confirmTitle,
      path: '/newsletter/confirm',
      noindex: true,
    });
    // Browser only: afterNextRender never runs on the server.
    afterNextRender(() => void this.confirm());
  }

  private async confirm(): Promise<void> {
    const token = this.t();
    if (!token) {
      this.state.set('invalid');
      return;
    }
    try {
      const result = await this.api.confirm(token);
      this.masked.set(result.email);
      this.title.set(COPY.confirmed);
      this.state.set('ok');
    } catch {
      this.state.set('invalid');
    }
  }
}
