import {
  ChangeDetectionStrategy,
  Component,
  Injector,
  PLATFORM_ID,
  afterNextRender,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { CODE_SENT_MESSAGE_HE, type CustomerMe, type OtpChannel } from '@hg/models';
import { PageMeta } from '../core/page-meta';
import { AccountApi, accountErrorMessage, accountFailure } from './account.api';
import {
  CODE_REQUIRED_MESSAGE_HE,
  EMAIL_MESSAGE_HE,
  PASSWORD_MESSAGE_HE,
  PASSWORD_REQUIRED_MESSAGE_HE,
  PHONE_MESSAGE_HE,
  isEmail,
  isPhone,
  isValidPassword,
  normalizeEmail,
  normalizePhone,
} from './account-forms';
import { CustomerStore } from './customer.store';
import { safeNext } from './next-url';
import { OtpField } from './otp-field';
import { SignUpDraft } from './sign-up-draft';

type Tab = 'password' | 'sms' | 'email';

const TABS: { id: Tab; label: string }[] = [
  { id: 'password', label: 'סיסמה' },
  { id: 'sms', label: 'קוד ב־SMS' },
  { id: 'email', label: 'קוד במייל' },
];

/**
 * `/account` (spec §6.1, ACC-01): sign in by e-mail + password or by a one-time code sent by SMS or e-mail. Every
 * code request answers the same text whether an account exists or not. A code for a phone or e-mail with no account
 * continues to the sign-up page with that contact filled (the server's ticket travels in `SignUpDraft`). "שכחתי
 * סיסמה" is a code by e-mail and a new password. After a sign-in the customer goes to `?next=` when it is a same-site
 * path, otherwise to the orders list. The session is read in the browser only; the server renders the heading.
 */
@Component({
  selector: 'hg-sign-in-page',
  imports: [OtpField, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './sign-in.page.html',
  styleUrl: './account.scss',
})
export class SignInPage {
  /** `?next=`, validated only when used. */
  readonly next = input<string>();

  private readonly api = inject(AccountApi);
  private readonly store = inject(CustomerStore);
  private readonly router = inject(Router);
  private readonly draft = inject(SignUpDraft);
  private readonly injector = inject(Injector);
  private readonly otp = viewChild(OtpField);

  protected readonly tabs = TABS;
  protected readonly tab = signal<Tab>('password');
  protected readonly ready = signal(false);
  protected readonly busy = signal(false);
  protected readonly formError = signal('');
  protected readonly errors = signal<Partial<Record<'email' | 'password' | 'target' | 'code', string>>>({});
  protected readonly codeSent = CODE_SENT_MESSAGE_HE;

  /** The code tabs: the phone or e-mail field, and whether the code was sent. */
  protected readonly targetText = signal('');
  protected readonly codeStep = signal(false);
  private target = '';
  private channel: OtpChannel = 'sms';

  protected readonly emailText = signal('');
  protected readonly passwordText = signal('');

  /** Forgot-password flow. */
  protected readonly resetting = signal(false);
  protected readonly resetStep = signal<'email' | 'code'>('email');
  protected readonly resetEmail = signal('');
  protected readonly resetPassword = signal('');
  private resetCode = '';
  protected readonly codeError = signal('');

  constructor() {
    inject(PageMeta).set({
      title: 'התחברות',
      description: 'התחברות לחשבון האישי',
      path: '/account',
      noindex: true,
    });
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

  // ---------- Tabs ----------

  protected selectTab(tab: Tab, focus = false): void {
    if (this.tab() !== tab) {
      this.tab.set(tab);
      this.targetText.set('');
      this.codeStep.set(false);
      this.errors.set({});
      this.formError.set('');
      this.codeError.set('');
    }
    if (focus) document.getElementById(`tab-${tab}`)?.focus();
  }

  /** Arrow keys move between the tabs (in a right-to-left page ArrowLeft is "next"), Home and End jump. */
  protected tabKey(event: KeyboardEvent): void {
    const index = TABS.findIndex((t) => t.id === this.tab());
    let next = index;
    switch (event.key) {
      case 'ArrowLeft':
        next = (index + 1) % TABS.length;
        break;
      case 'ArrowRight':
        next = (index - 1 + TABS.length) % TABS.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = TABS.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    this.selectTab(TABS[next].id, true);
  }

  protected input(signalToSet: { set(v: string): void }, event: Event): void {
    signalToSet.set((event.target as HTMLInputElement).value);
  }

  // ---------- Password ----------

  protected async signInWithPassword(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    const email = normalizeEmail(this.emailText());
    const errors: ReturnType<typeof this.errors> = {};
    if (!isEmail(email)) errors.email = EMAIL_MESSAGE_HE;
    if (!this.passwordText()) errors.password = PASSWORD_REQUIRED_MESSAGE_HE;
    this.errors.set(errors);
    this.formError.set('');
    if (errors.email || errors.password) return;
    this.busy.set(true);
    try {
      const { customer } = await this.api.signIn({ email, password: this.passwordText() });
      this.done(customer);
    } catch (error) {
      this.formError.set(accountErrorMessage(accountFailure(error)));
    } finally {
      this.busy.set(false);
    }
  }

  // ---------- One-time code (SMS or e-mail) ----------

  protected async sendCode(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    const channel: OtpChannel = this.tab() === 'sms' ? 'sms' : 'email';
    const target = channel === 'sms' ? normalizePhone(this.targetText()) : normalizeEmail(this.targetText());
    const valid = channel === 'sms' ? isPhone(target) : isEmail(target);
    this.formError.set('');
    if (!valid) {
      this.errors.set({ target: channel === 'sms' ? PHONE_MESSAGE_HE : EMAIL_MESSAGE_HE });
      return;
    }
    this.errors.set({});
    this.busy.set(true);
    try {
      await this.api.requestOtp({ target, channel, purpose: 'sign_in' });
      this.target = target;
      this.channel = channel;
      this.codeError.set('');
      this.codeStep.set(true);
      this.focusCode();
    } catch (error) {
      this.formError.set(accountErrorMessage(accountFailure(error)));
    } finally {
      this.busy.set(false);
    }
  }

  protected async resend(): Promise<void> {
    this.formError.set('');
    try {
      await this.api.requestOtp({ target: this.target, channel: this.channel, purpose: 'sign_in' });
    } catch (error) {
      this.formError.set(accountErrorMessage(accountFailure(error)));
    }
  }

  protected async verifyCode(code: string): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.codeError.set('');
    this.formError.set('');
    try {
      const result = await this.api.verifyOtp({ target: this.target, code, purpose: 'sign_in' });
      if ('customer' in result) {
        this.done(result.customer);
      } else {
        this.draft.set({
          phone: result.verified.phone,
          email: result.verified.email,
          signUpToken: result.signUpToken,
          verified: result.verified,
        });
        const next = this.next();
        void this.router.navigate(['/account/sign-up'], {
          queryParams: next === undefined ? {} : { next: safeNext(next) },
        });
      }
    } catch (error) {
      const failure = accountFailure(error);
      if (failure.code === 'invalid_code') {
        this.codeError.set(accountErrorMessage(failure));
        this.otp()?.clear();
      } else {
        this.formError.set(accountErrorMessage(failure));
      }
    } finally {
      this.busy.set(false);
    }
  }

  protected changeTarget(): void {
    this.codeStep.set(false);
    this.codeError.set('');
    this.formError.set('');
  }

  // ---------- Forgot password ----------

  protected startReset(): void {
    this.resetting.set(true);
    this.resetStep.set('email');
    this.resetEmail.set(this.emailText());
    this.errors.set({});
    this.formError.set('');
  }

  protected cancelReset(): void {
    this.resetting.set(false);
    this.errors.set({});
    this.formError.set('');
    this.codeError.set('');
  }

  protected async requestReset(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    const email = normalizeEmail(this.resetEmail());
    this.formError.set('');
    if (!isEmail(email)) {
      this.errors.set({ email: EMAIL_MESSAGE_HE });
      return;
    }
    this.errors.set({});
    this.busy.set(true);
    try {
      await this.api.requestReset({ email });
      this.resetEmail.set(email);
      this.resetCode = '';
      this.resetStep.set('code');
      this.focusCode();
    } catch (error) {
      this.formError.set(accountErrorMessage(accountFailure(error)));
    } finally {
      this.busy.set(false);
    }
  }

  protected async resendReset(): Promise<void> {
    try {
      await this.api.requestReset({ email: this.resetEmail() });
    } catch (error) {
      this.formError.set(accountErrorMessage(accountFailure(error)));
    }
  }

  protected resetCodeEntered(code: string): void {
    this.resetCode = code;
    this.codeError.set('');
  }

  protected async submitReset(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    const errors: ReturnType<typeof this.errors> = {};
    if (this.resetCode.length !== 6) errors.code = CODE_REQUIRED_MESSAGE_HE;
    if (!isValidPassword(this.resetPassword())) errors.password = PASSWORD_MESSAGE_HE;
    this.errors.set(errors);
    this.formError.set('');
    this.codeError.set(errors.code ?? '');
    if (errors.code || errors.password) return;
    this.busy.set(true);
    try {
      const { customer } = await this.api.reset({
        email: this.resetEmail(),
        code: this.resetCode,
        next: this.resetPassword(),
      });
      this.done(customer);
    } catch (error) {
      const failure = accountFailure(error);
      if (failure.code === 'invalid_code') {
        this.codeError.set(accountErrorMessage(failure));
        this.resetCode = '';
        this.otp()?.clear();
      } else {
        this.formError.set(accountErrorMessage(failure));
      }
    } finally {
      this.busy.set(false);
    }
  }

  // ---------- Shared ----------

  private done(customer: CustomerMe): void {
    this.draft.clear();
    this.store.setCustomer(customer);
    void this.router.navigateByUrl(safeNext(this.next()));
  }

  /** Moves the focus to the code boxes once they are rendered. */
  private focusCode(): void {
    afterNextRender(() => this.otp()?.focus(), { injector: this.injector });
  }
}
