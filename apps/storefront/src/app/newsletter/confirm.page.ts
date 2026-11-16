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
import { CONSENT_TEXT_HE } from '@hg/models';
import { PageMeta } from '../core/page-meta';
import { NewsletterApi, newsletterFailure } from './newsletter.api';
import { NEWSLETTER_COPY as COPY } from './newsletter.copy';

type State = 'loading' | 'ask' | 'confirming' | 'ok' | 'invalid' | 'error';

/**
 * `/newsletter/confirm?t=` (MKT-01, CLB-02, spec §4.4): the link in the confirmation e-mail or the store's SMS. On load
 * the browser only previews the token (`confirm/preview`, after hydration, so the server-rendered HTML holds no
 * address): the page names the already masked address the updates go to, shows the consent text and asks for a click;
 * only the click confirms. A mail scanner that opens the link therefore confirms nothing. An unknown, used or expired
 * token (404) reads "invalid or expired link"; any other failure offers a retry of the step that failed. The focus
 * moves to the heading when the state changes, so screen readers announce it. noindex.
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
          <p role="status">{{ copy.checking }}</p>
        }
        @case ('ask') {
          <p>
            {{ copy.confirmFor }} <bdi dir="ltr">{{ masked() }}</bdi>
          </p>
          <p>{{ consentText }}</p>
          <p>
            <button type="button" class="btn btn-primary confirm" (click)="confirm()">{{ copy.confirmButton }}</button>
          </p>
        }
        @case ('confirming') {
          <p role="status">{{ copy.confirming }}</p>
        }
        @case ('ok') {
          <p role="status">
            {{ copy.confirmedFor }} <bdi dir="ltr">{{ masked() }}</bdi>
          </p>
        }
        @case ('error') {
          <p role="alert">{{ copy.failed }}</p>
          <p>
            <button type="button" class="btn btn-primary retry" (click)="retry()">{{ copy.retry }}</button>
          </p>
        }
        @default {
          <p role="alert">{{ copy.linkInvalid }}</p>
        }
      }
      @if (state() === 'ok' || state() === 'invalid') {
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
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  protected readonly copy = COPY;
  protected readonly consentText = CONSENT_TEXT_HE;
  protected readonly state = signal<State>('loading');
  protected readonly masked = signal('');
  protected readonly title = signal<string>(COPY.confirmTitle);
  /** The step a retry repeats: the preview until it answered, then the confirm. */
  private step: 'preview' | 'confirm' = 'preview';

  constructor() {
    inject(PageMeta).set({
      title: COPY.confirmTitle,
      description: COPY.confirmTitle,
      path: '/newsletter/confirm',
      noindex: true,
    });
    // Browser only: afterNextRender never runs on the server. It only reads; nothing is confirmed without the click.
    afterNextRender(() => void this.preview());
  }

  protected retry(): void {
    if (this.step === 'confirm') {
      void this.confirm();
    } else {
      this.state.set('loading');
      void this.preview();
    }
  }

  /** The "confirm" button. */
  protected async confirm(): Promise<void> {
    const token = this.t();
    if (!token || this.state() === 'confirming') return;
    this.step = 'confirm';
    this.state.set('confirming');
    try {
      const result = await this.api.confirm(token);
      this.masked.set(result.email);
      this.title.set(COPY.confirmed);
      this.state.set('ok');
    } catch (error) {
      this.fail(error);
    }
    this.focusHeading();
  }

  private focusHeading(): void {
    afterNextRender(() => this.host.nativeElement.querySelector('h1')?.focus(), { injector: this.injector });
  }

  /** Only an unknown, used or expired link is "invalid"; a server, throttle or network problem can be retried. */
  private fail(error: unknown): void {
    this.state.set(newsletterFailure(error).status === 404 ? 'invalid' : 'error');
  }

  private async preview(): Promise<void> {
    const token = this.t();
    if (!token) {
      this.state.set('invalid');
      this.focusHeading();
      return;
    }
    try {
      const result = await this.api.preview(token);
      this.masked.set(result.email);
      this.step = 'confirm';
      this.state.set('ask');
    } catch (error) {
      this.fail(error);
    }
    this.focusHeading();
  }
}
