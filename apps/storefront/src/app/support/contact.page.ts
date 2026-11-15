import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  PLATFORM_ID,
  afterNextRender,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import {
  CHECKOUT_LIMITS,
  ORDER_NUMBER_MAX_LENGTH,
  ORDER_NUMBER_PATTERN,
  PHONE_INPUT_MAX_LENGTH,
  SUPPORT_FIELD_MESSAGES_HE,
  SUPPORT_LIMITS,
  type ContactRequestBody,
} from '@hg/models';
import { CustomerStore } from '../account/customer.store';
import { isEmail, isPhone, normalizePhone } from '../account/account-forms';
import { PageMeta } from '../core/page-meta';
import { SUPPORT_CONTACT, whatsappLink } from '../core/support-contact';
import { SupportApi, supportErrorMessage, supportFailure, supportSuccessText } from './support.api';

type ContactField = 'fullName' | 'phone' | 'email' | 'subject' | 'message' | 'orderNumber';

const FIELDS: readonly ContactField[] = ['fullName', 'phone', 'email', 'subject', 'message', 'orderNumber'];
const id = (field: ContactField) => `ct-${field}`;

/**
 * Contact `/contact` (spec §7.1, SRV-05): name, phone, e-mail, subject, message and an optional order number, plus
 * the customer-service phone and a WhatsApp button (INTERIM numbers, `SUPPORT_CONTACT`). A signed-in customer's details
 * are prefilled in the browser. `noindex`, never in the sitemap.
 */
@Component({
  selector: 'hg-contact-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './contact.page.html',
  styleUrl: './support.scss',
})
export class ContactPage {
  private readonly api = inject(SupportApi);
  private readonly store = inject(CustomerStore);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  protected readonly support = SUPPORT_CONTACT;
  protected readonly whatsapp = whatsappLink(SUPPORT_CONTACT.whatsapp);
  protected readonly id = id;
  protected readonly limits = {
    ...SUPPORT_LIMITS,
    name: CHECKOUT_LIMITS.fullNameMax,
    email: CHECKOUT_LIMITS.emailMax,
    phone: PHONE_INPUT_MAX_LENGTH,
    orderNumber: ORDER_NUMBER_MAX_LENGTH,
  };
  protected readonly values = signal<Record<ContactField, string>>({
    fullName: '',
    phone: '',
    email: '',
    subject: '',
    message: '',
    orderNumber: '',
  });
  protected readonly website = signal('');
  protected readonly errors = signal<Partial<Record<ContactField, string>>>({});
  protected readonly formError = signal('');
  protected readonly busy = signal(false);
  protected readonly done = signal('');
  private prefilled = false;

  constructor() {
    inject(PageMeta).set({
      title: 'צור קשר',
      description: 'יצירת קשר עם שירות הלקוחות',
      path: '/contact',
      noindex: true,
    });
    // A signed-in customer's details, once the session is known (browser only).
    effect(() => {
      const me = this.store.me();
      const ready = this.store.ready();
      untracked(() => {
        if (!this.browser) return;
        if (!ready) {
          void this.store.load();
          return;
        }
        if (me && !this.prefilled) {
          this.prefilled = true;
          this.values.update((v) => ({
            ...v,
            fullName: v.fullName || me.fullName,
            phone: v.phone || me.phone,
            email: v.email || me.email,
          }));
        }
      });
    });
  }

  protected set(field: ContactField, event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
    this.values.update((v) => ({ ...v, [field]: value }));
    this.formError.set('');
    if (this.errors()[field]) this.errors.update((e) => ({ ...e, [field]: undefined }));
  }

  protected setWebsite(event: Event): void {
    this.website.set((event.target as HTMLInputElement).value);
  }

  private focus(field: ContactField): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(`#${id(field)}`)?.focus(), {
      injector: this.injector,
    });
  }

  private validate(): Partial<Record<ContactField, string>> {
    const v = this.values();
    const L = SUPPORT_LIMITS;
    const errors: Partial<Record<ContactField, string>> = {};
    const name = v.fullName.trim();
    if (name.length < CHECKOUT_LIMITS.fullNameMin || name.length > CHECKOUT_LIMITS.fullNameMax) {
      errors.fullName = SUPPORT_FIELD_MESSAGES_HE.fullName;
    }
    if (!isPhone(normalizePhone(v.phone))) errors.phone = SUPPORT_FIELD_MESSAGES_HE.phone;
    if (!isEmail(v.email.trim())) errors.email = SUPPORT_FIELD_MESSAGES_HE.email;
    const subject = v.subject.trim();
    if (subject.length < L.subjectMin || subject.length > L.subjectMax)
      errors.subject = SUPPORT_FIELD_MESSAGES_HE.subject;
    const message = v.message.trim();
    if (message.length < L.messageMin || message.length > L.messageMax)
      errors.message = SUPPORT_FIELD_MESSAGES_HE.message;
    if (v.orderNumber.trim() && !ORDER_NUMBER_PATTERN.test(v.orderNumber.trim().replace(/\s/g, ''))) {
      errors.orderNumber = SUPPORT_FIELD_MESSAGES_HE.orderNumber;
    }
    return errors;
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    this.formError.set('');
    const errors = this.validate();
    this.errors.set(errors);
    const first = FIELDS.find((f) => errors[f]);
    if (first) {
      this.focus(first);
      return;
    }
    const v = this.values();
    const body: ContactRequestBody = {
      fullName: v.fullName.trim(),
      phone: normalizePhone(v.phone),
      email: v.email.trim(),
      subject: v.subject.trim(),
      message: v.message.trim(),
      website: this.website(),
    };
    const orderNumber = v.orderNumber.trim().replace(/\s/g, '');
    if (orderNumber) body.orderNumber = orderNumber;
    this.busy.set(true);
    try {
      const created = await this.api.contact(body);
      this.done.set(supportSuccessText(created.ticketNumber));
      afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>('#ct-success')?.focus(), {
        injector: this.injector,
      });
    } catch (error) {
      const failure = supportFailure(error);
      const message = supportErrorMessage(failure, 'contact');
      const field = failure.field as ContactField | null;
      if (failure.code === 'invalid_field' && field && FIELDS.includes(field)) {
        this.errors.set({ [field]: message });
        this.focus(field);
      } else {
        this.formError.set(message);
      }
    } finally {
      this.busy.set(false);
    }
  }
}
