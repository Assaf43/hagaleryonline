import {
  ChangeDetectionStrategy,
  Component,
  Injector,
  PLATFORM_ID,
  afterNextRender,
  inject,
  input,
  signal,
  viewChildren,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import type { CustomerMe, OtpChannel, SignUpBody } from '@hg/models';
import { PageMeta } from '../core/page-meta';
import { AccountApi, accountErrorMessage, accountFailure } from './account.api';
import {
  EMAIL_MESSAGE_HE,
  NAME_MESSAGE_HE,
  PASSWORD_MESSAGE_HE,
  PHONE_MESSAGE_HE,
  isEmail,
  isPhone,
  isValidName,
  isValidPassword,
  normalizeEmail,
  normalizePhone,
} from './account-forms';
import { CustomerStore } from './customer.store';
import { safeNext } from './next-url';
import { OtpField } from './otp-field';
import { SignUpDraft } from './sign-up-draft';

type Kind = 'phone' | 'email';
type Field = 'name' | 'phone' | 'email' | 'password';

/**
 * `/account/sign-up` (spec §6.1, decision 80): name, phone, e-mail, an optional password and the marketing checkbox
 * (never pre-checked). The account is created only after BOTH the phone and the e-mail were verified by a code, so
 * after the details there are two code boxes. When the customer arrives from a sign-in code for a phone or e-mail
 * with no account, that contact is already verified (the server's ticket is in `SignUpDraft`), filled and locked,
 * and only the other contact needs a code. Nothing is stored until the last step.
 */
@Component({
  selector: 'hg-sign-up-page',
  imports: [OtpField, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './sign-up.page.html',
  styleUrl: './account.scss',
})
export class SignUpPage {
  readonly next = input<string>();

  private readonly api = inject(AccountApi);
  private readonly store = inject(CustomerStore);
  private readonly router = inject(Router);
  private readonly draftStore = inject(SignUpDraft);
  private readonly injector = inject(Injector);
  private readonly otps = viewChildren(OtpField);

  protected readonly ready = signal(false);
  protected readonly busy = signal(false);
  protected readonly step = signal<'details' | 'codes'>('details');
  protected readonly formError = signal('');
  protected readonly errors = signal<Partial<Record<Field, string>>>({});

  protected readonly name = signal('');
  protected readonly phone = signal('');
  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly consent = signal(false);

  /** A contact the sign-in code already verified is filled and locked. */
  protected readonly lockedPhone = signal(false);
  protected readonly lockedEmail = signal(false);

  /** Which contacts get a code box in the code step, and which of them were verified. */
  protected readonly needsCode = signal<Record<Kind, boolean>>({ phone: false, email: false });
  protected readonly verified = signal<Record<Kind, boolean>>({ phone: false, email: false });
  protected readonly codeErrors = signal<Record<Kind, string>>({ phone: '', email: '' });

  private token: string | undefined;
  private readonly draft = this.draftStore.current();

  constructor() {
    inject(PageMeta).set({
      title: 'הרשמה',
      description: 'יצירת חשבון אישי',
      path: '/account/sign-up',
      noindex: true,
    });
    const d = this.draft;
    if (d) {
      this.token = d.signUpToken;
      if (d.verified.phone) {
        this.phone.set(d.verified.phone);
        this.lockedPhone.set(true);
        this.verified.update((v) => ({ ...v, phone: true }));
      }
      if (d.verified.email) {
        this.email.set(d.verified.email);
        this.lockedEmail.set(true);
        this.verified.update((v) => ({ ...v, email: true }));
      }
      this.draftStore.clear();
    }
    if (isPlatformBrowser(inject(PLATFORM_ID))) void this.start();
  }

  private async start(): Promise<void> {
    await this.store.load();
    if (this.store.me()) {
      void this.router.navigateByUrl(safeNext(this.next()));
      return;
    }
    this.ready.set(true);
  }

  protected input(target: { set(v: string): void }, event: Event): void {
    target.set((event.target as HTMLInputElement).value);
  }

  protected setConsent(event: Event): void {
    this.consent.set((event.target as HTMLInputElement).checked);
  }

  private details(): Omit<SignUpBody, 'signUpToken'> {
    const body: Omit<SignUpBody, 'signUpToken'> = {
      fullName: this.name().trim(),
      phone: normalizePhone(this.phone()),
      email: normalizeEmail(this.email()),
      marketingConsent: this.consent(),
    };
    if (this.password()) body.password = this.password();
    return body;
  }

  private validate(): boolean {
    const d = this.details();
    const errors: Partial<Record<Field, string>> = {};
    if (!isValidName(d.fullName)) errors.name = NAME_MESSAGE_HE;
    if (!isPhone(d.phone)) errors.phone = PHONE_MESSAGE_HE;
    if (!isEmail(d.email)) errors.email = EMAIL_MESSAGE_HE;
    if (d.password !== undefined && !isValidPassword(d.password)) errors.password = PASSWORD_MESSAGE_HE;
    this.errors.set(errors);
    return Object.keys(errors).length === 0;
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    this.formError.set('');
    if (!this.validate()) return;
    const d = this.details();
    this.busy.set(true);
    try {
      const v = this.verified();
      if (this.token) {
        // Arrived with a verified contact: only the other one needs a code.
        const missing: Kind | null = !v.phone ? 'phone' : !v.email ? 'email' : null;
        if (!missing) {
          await this.finalize();
          return;
        }
        await this.api.requestOtp({
          target: missing === 'phone' ? d.phone : d.email,
          channel: this.channel(missing),
          purpose: 'sign_up',
        });
        this.needsCode.set({ phone: missing === 'phone', email: missing === 'email' });
      } else {
        await this.api.signUp(d);
        this.needsCode.set({ phone: true, email: true });
      }
      this.codeErrors.set({ phone: '', email: '' });
      this.step.set('codes');
      afterNextRender(() => this.otps()[0]?.focus(), { injector: this.injector });
    } catch (error) {
      this.fail(accountFailure(error));
    } finally {
      this.busy.set(false);
    }
  }

  private channel(kind: Kind): OtpChannel {
    return kind === 'phone' ? 'sms' : 'email';
  }

  protected async codeEntered(kind: Kind, code: string): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.formError.set('');
    this.codeErrors.update((e) => ({ ...e, [kind]: '' }));
    const d = this.details();
    try {
      const result = await this.api.verifyOtp({
        target: kind === 'phone' ? d.phone : d.email,
        code,
        purpose: 'sign_up',
        ...(this.token ? { signUpToken: this.token } : {}),
      });
      if ('customer' in result) {
        this.done(result.customer);
        return;
      }
      this.token = result.signUpToken;
      this.verified.set({ phone: result.verified.phone !== null, email: result.verified.email !== null });
      const need = this.needsCode();
      if ((!need.phone || this.verified().phone) && (!need.email || this.verified().email)) await this.finalize();
    } catch (error) {
      const failure = accountFailure(error);
      if (failure.code === 'invalid_code') {
        this.codeErrors.update((e) => ({ ...e, [kind]: accountErrorMessage(failure) }));
        this.otps()
          .find((o) => o.idPrefix() === `su-otp-${kind}`)
          ?.clear();
      } else {
        this.fail(failure);
      }
    } finally {
      this.busy.set(false);
    }
  }

  protected async resend(kind: Kind): Promise<void> {
    const d = this.details();
    this.formError.set('');
    try {
      await this.api.requestOtp({
        target: kind === 'phone' ? d.phone : d.email,
        channel: this.channel(kind),
        purpose: 'sign_up',
      });
    } catch (error) {
      this.formError.set(accountErrorMessage(accountFailure(error)));
    }
  }

  private async finalize(): Promise<void> {
    const result = await this.api.signUp({ ...this.details(), signUpToken: this.token });
    if ('customer' in result) this.done(result.customer);
  }

  protected backToDetails(): void {
    this.step.set('details');
    this.formError.set('');
    // Verification belongs to the contacts as they were: a ticket from a sign-in code stays, the rest starts over.
    if (!this.lockedPhone() && !this.lockedEmail()) this.token = undefined;
    this.verified.set({ phone: this.lockedPhone(), email: this.lockedEmail() });
  }

  /** An error on the details or the code step: on its field when the API names one, else above the buttons. */
  private fail(failure: ReturnType<typeof accountFailure>): void {
    const fields: Record<string, Field> = { fullName: 'name', phone: 'phone', email: 'email', password: 'password' };
    const field = failure.field ? fields[failure.field] : undefined;
    if (failure.code === 'invalid_token') {
      this.token = undefined;
      this.verified.set({ phone: false, email: false });
    }
    if (field && failure.status !== 429) {
      this.errors.set({ [field]: accountErrorMessage(failure) });
      this.step.set('details');
      if (failure.code === 'not_verified') this.token = undefined;
    } else {
      this.formError.set(accountErrorMessage(failure));
      if (failure.code === 'invalid_token' || failure.code === 'not_verified') this.step.set('details');
    }
  }

  private done(customer: CustomerMe): void {
    this.store.setCustomer(customer);
    void this.router.navigateByUrl(safeNext(this.next()));
  }
}
