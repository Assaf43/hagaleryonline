import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { CONSENT_TEXT_HE } from '@hg/models';
import { isEmail } from '../account/account-forms';
import { NewsletterApi, newsletterFailure } from './newsletter.api';
import { NEWSLETTER_COPY as COPY } from './newsletter.copy';

let nextId = 0;

/**
 * Footer sign-up (MKT-01, CLB-02, decision 95): an e-mail and an unchecked consent box. Every accepted request gets
 * the same answer ("a link was sent"), so the form never reveals whether an address is already on the list. The API
 * sends the confirmation link; nothing is subscribed until it is opened. A hidden honeypot catches bots.
 */
@Component({
  selector: 'hg-newsletter-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="newsletter" [attr.aria-labelledby]="uid + '-title'">
      <h2 [id]="uid + '-title'">{{ copy.formTitle }}</h2>
      <p class="done" role="status">{{ done() }}</p>
      @if (!done()) {
        <form novalidate (submit)="submit($event)">
          <div class="field">
            <label class="field-label" [for]="uid + '-email'">{{ copy.emailLabel }}</label>
            <div class="row">
              <input
                class="input"
                type="email"
                dir="ltr"
                inputmode="email"
                autocomplete="email"
                maxlength="254"
                [id]="uid + '-email'"
                [value]="email()"
                [attr.aria-invalid]="emailError() ? true : null"
                [attr.aria-describedby]="emailError() ? uid + '-email-error' : null"
                (input)="email.set(value($event))"
              />
              <button type="submit" class="btn btn-primary" [disabled]="busy()">{{ copy.submit }}</button>
            </div>
            @if (emailError(); as e) {
              <p class="field-error" [id]="uid + '-email-error'">{{ e }}</p>
            }
          </div>
          <div class="field">
            <label class="check">
              <input
                type="checkbox"
                [checked]="consent()"
                [attr.aria-invalid]="consentError() ? true : null"
                [attr.aria-describedby]="consentError() ? uid + '-consent-error' : null"
                (change)="consent.set(checked($event))"
              />
              <span>{{ consentText }}</span>
            </label>
            @if (consentError(); as e) {
              <p class="field-error" [id]="uid + '-consent-error'">{{ e }}</p>
            }
          </div>
          <!-- Honeypot: people never see or reach it; a bot that fills it gets the same quiet 202. -->
          <div class="hp" aria-hidden="true">
            <label [for]="uid + '-website'">{{ copy.honeypotLabel }}</label>
            <input
              [id]="uid + '-website'"
              name="website"
              type="text"
              tabindex="-1"
              autocomplete="off"
              [value]="website()"
              (input)="website.set(value($event))"
            />
          </div>
          <p class="form-error" role="alert">{{ formError() }}</p>
        </form>
      }
    </section>
  `,
  styles: `
    :host {
      display: block;
    }

    .newsletter {
      display: grid;
      gap: var(--space-3);
      align-content: start;
      max-inline-size: 420px;
    }

    h2 {
      margin: 0;
      font-family: var(--font-sans);
      font-size: var(--font-body);
      font-weight: 600;
    }

    form,
    .field {
      display: grid;
      gap: var(--space-2);
    }

    .row {
      display: flex;
      gap: var(--space-2);
    }

    .row .input {
      flex: 1;
      min-inline-size: 0;
    }

    .check {
      display: flex;
      align-items: flex-start;
      gap: var(--space-2);
      font-size: var(--font-small);
    }

    .done {
      margin: 0;
      font-size: var(--font-small);

      &:empty {
        display: none;
      }
    }

    .form-error {
      margin: 0;
      color: var(--color-danger);
      font-size: var(--font-small);

      &:empty {
        display: none;
      }
    }

    .hp {
      position: absolute;
      inset-inline-start: -10000px;
      inline-size: 1px;
      block-size: 1px;
      overflow: hidden;
    }
  `,
})
export class NewsletterForm {
  private readonly api = inject(NewsletterApi);

  protected readonly copy = COPY;
  protected readonly consentText = CONSENT_TEXT_HE;
  protected readonly uid = `nl-${nextId++}`;
  protected readonly email = signal('');
  protected readonly consent = signal(false);
  protected readonly website = signal('');
  protected readonly emailError = signal('');
  protected readonly consentError = signal('');
  protected readonly formError = signal('');
  protected readonly busy = signal(false);
  protected readonly done = signal('');

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    const email = this.email().trim();
    this.emailError.set(isEmail(email) ? '' : COPY.emailInvalid);
    this.consentError.set(this.consent() ? '' : COPY.consentMissing);
    this.formError.set('');
    if (this.emailError() || this.consentError()) return;
    this.busy.set(true);
    try {
      await this.api.subscribe({ email, consent: true, website: this.website() });
      this.done.set(COPY.sent);
    } catch (error) {
      const failure = newsletterFailure(error);
      if (failure.status === 429) this.formError.set(COPY.tooMany);
      else if (failure.code === 'invalid_input' && failure.field === 'email') this.emailError.set(COPY.emailInvalid);
      else if (failure.code === 'invalid_input' && failure.field === 'consent')
        this.consentError.set(COPY.consentMissing);
      else this.formError.set(COPY.failed);
    } finally {
      this.busy.set(false);
    }
  }
}
