import {
  ChangeDetectionStrategy,
  Component,
  Injector,
  PLATFORM_ID,
  afterNextRender,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { CODE_SENT_MESSAGE_HE, type PasswordChangeBody } from '@hg/models';
import { PageMeta } from '../core/page-meta';
import { AccountNav } from './account-nav';
import { AccountApi, accountErrorMessage, accountFailure } from './account.api';
import {
  EMAIL_MESSAGE_HE,
  NAME_MESSAGE_HE,
  PASSWORD_MESSAGE_HE,
  PASSWORD_REQUIRED_MESSAGE_HE,
  PHONE_MESSAGE_HE,
  isEmail,
  isPhone,
  isValidName,
  isValidPassword,
  normalizeEmail,
  normalizePhone,
} from './account-forms';
import { CustomerStore } from './customer.store';
import { OtpField } from './otp-field';

type Kind = 'phone' | 'email';

const CONTACTS: { kind: Kind; title: string; label: string; done: string }[] = [
  { kind: 'phone', title: 'טלפון נייד', label: 'מספר טלפון חדש', done: 'הטלפון עודכן' },
  { kind: 'email', title: 'דוא״ל', label: 'כתובת דוא״ל חדשה', done: 'הדוא״ל עודכן' },
];

/**
 * `/account/details` (ACC-04): the name, the phone and the e-mail (a change needs a code sent to the new value, and
 * the new value is saved as verified), and the password (the first one, or a change that asks for the current one).
 * The API has no name change yet, so the name is shown only.
 */
@Component({
  selector: 'hg-account-details-page',
  imports: [AccountNav, OtpField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './details.page.html',
  styleUrl: './account.scss',
})
export class DetailsPage {
  protected readonly store = inject(CustomerStore);
  private readonly api = inject(AccountApi);
  private readonly injector = inject(Injector);
  private readonly otp = viewChild(OtpField);

  protected readonly contacts = CONTACTS;
  protected readonly codeSent = CODE_SENT_MESSAGE_HE;
  protected readonly busy = signal(false);
  /** The one live status text ("הטלפון עודכן"). */
  protected readonly status = signal('');
  protected readonly errors = signal<Record<string, string>>({});
  protected readonly formError = signal('');

  /** What the customer typed in the name box (null: the saved name). */
  protected readonly nameDraft = signal<string | null>(null);
  protected readonly values = { phone: signal(''), email: signal(''), current: signal(''), next: signal('') };
  /** The kind whose code step is open (one at a time), with its code error. */
  protected readonly confirming = signal<Kind | null>(null);
  protected readonly codeError = signal('');
  private pending = '';

  constructor() {
    inject(PageMeta).set({
      title: 'פרטים אישיים',
      description: 'הפרטים האישיים שלי',
      path: '/account/details',
      noindex: true,
    });
    if (isPlatformBrowser(inject(PLATFORM_ID))) void this.store.load();
  }

  protected input(target: { set(v: string): void }, event: Event): void {
    target.set((event.target as HTMLInputElement).value);
  }

  // ---------- Name ----------

  protected async saveName(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    const name = (this.nameDraft() ?? this.store.me()?.fullName ?? '').trim().replace(/\s+/g, ' ');
    this.status.set('');
    this.formError.set('');
    if (!isValidName(name)) {
      this.errors.set({ name: NAME_MESSAGE_HE });
      return;
    }
    this.errors.set({});
    this.busy.set(true);
    try {
      this.store.restore(await this.api.changeName(name));
      this.nameDraft.set(null);
      this.status.set('השם עודכן');
    } catch (error) {
      if (this.store.unauthorized(error)) return;
      const failure = accountFailure(error);
      if (failure.field === 'name') this.errors.set({ name: NAME_MESSAGE_HE });
      else this.formError.set(accountErrorMessage(failure));
    } finally {
      this.busy.set(false);
    }
  }

  // ---------- Phone or e-mail ----------

  protected async requestChange(kind: Kind, event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    const value = kind === 'phone' ? normalizePhone(this.values.phone()) : normalizeEmail(this.values.email());
    const valid = kind === 'phone' ? isPhone(value) : isEmail(value);
    this.status.set('');
    this.formError.set('');
    if (!valid) {
      this.errors.set({ [kind]: kind === 'phone' ? PHONE_MESSAGE_HE : EMAIL_MESSAGE_HE });
      return;
    }
    this.errors.set({});
    this.busy.set(true);
    try {
      await this.api.changeContact({ kind, value });
      this.pending = value;
      this.codeError.set('');
      this.confirming.set(kind);
      afterNextRender(() => this.otp()?.focus(), { injector: this.injector });
    } catch (error) {
      if (this.store.unauthorized(error)) return;
      const failure = accountFailure(error);
      if (failure.field === kind || failure.code === 'phone_taken' || failure.code === 'email_taken') {
        this.errors.set({ [kind]: accountErrorMessage(failure) });
      } else {
        this.formError.set(accountErrorMessage(failure));
      }
    } finally {
      this.busy.set(false);
    }
  }

  protected async resend(kind: Kind): Promise<void> {
    this.formError.set('');
    try {
      await this.api.changeContact({ kind, value: this.pending });
    } catch (error) {
      if (this.store.unauthorized(error)) return;
      this.formError.set(accountErrorMessage(accountFailure(error)));
    }
  }

  protected async confirm(kind: Kind, code: string): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.codeError.set('');
    try {
      const { customer } = await this.api.confirmContact({ kind, code });
      this.store.restore(customer);
      this.values[kind].set('');
      this.confirming.set(null);
      this.status.set(CONTACTS.find((c) => c.kind === kind)!.done);
    } catch (error) {
      if (this.store.unauthorized(error)) return;
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

  protected cancelChange(): void {
    this.confirming.set(null);
    this.codeError.set('');
    this.formError.set('');
  }

  // ---------- Password ----------

  protected async savePassword(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    const hasPassword = this.store.me()?.hasPassword ?? false;
    const errors: Record<string, string> = {};
    if (hasPassword && !this.values.current()) errors['current'] = PASSWORD_REQUIRED_MESSAGE_HE;
    if (!isValidPassword(this.values.next())) errors['next'] = PASSWORD_MESSAGE_HE;
    this.errors.set(errors);
    this.status.set('');
    this.formError.set('');
    if (Object.keys(errors).length) return;
    const body: PasswordChangeBody = hasPassword
      ? { current: this.values.current(), next: this.values.next() }
      : { next: this.values.next() };
    this.busy.set(true);
    try {
      const { customer } = await this.api.changePassword(body);
      this.store.restore(customer);
      this.values.current.set('');
      this.values.next.set('');
      this.status.set('הסיסמה נשמרה');
    } catch (error) {
      if (this.store.unauthorized(error)) return;
      const failure = accountFailure(error);
      if (failure.code === 'wrong_password') this.errors.set({ current: accountErrorMessage(failure) });
      else if (failure.code === 'weak_password') this.errors.set({ next: accountErrorMessage(failure) });
      else this.formError.set(accountErrorMessage(failure));
    } finally {
      this.busy.set(false);
    }
  }
}
