import {
  ChangeDetectionStrategy,
  Component,
  Injector,
  PLATFORM_ID,
  afterNextRender,
  inject,
  signal,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import type { CustomerAddressView, LocalityOption } from '@hg/models';
import { LocalityField } from '../checkout/locality-field';
import { PageMeta } from '../core/page-meta';
import { AccountNav } from './account-nav';
import { AccountApi, accountErrorMessage, accountFailure } from './account.api';
import {
  ADDRESS_FIELD_IDS,
  emptyAddressForm,
  formFromAddress,
  isAddressField,
  toAddressInput,
  validateAddress,
  type AddressErrors,
  type AddressField,
  type AddressForm,
} from './address-form';
import { CustomerStore } from './customer.store';

/**
 * `/account/addresses` (ACC-05): the saved delivery addresses, with add, edit, delete (after a confirmation) and
 * "make default". The form has the checkout's address fields and rules; a server error lands on its field. The
 * server decides which address is the default, so the list is read again after every change.
 */
@Component({
  selector: 'hg-account-addresses-page',
  imports: [AccountNav, LocalityField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './addresses.page.html',
  styleUrl: './account.scss',
})
export class AddressesPage {
  private readonly api = inject(AccountApi);
  private readonly store = inject(CustomerStore);
  private readonly injector = inject(Injector);

  protected readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  protected readonly addresses = signal<CustomerAddressView[]>([]);
  /** `'new'`, an address id, or null while no form is open. */
  protected readonly editing = signal<string | null>(null);
  protected readonly editingDefault = signal(false);
  protected readonly form = signal<AddressForm>(emptyAddressForm());
  protected readonly errors = signal<AddressErrors>({});
  protected readonly formError = signal('');
  protected readonly listError = signal('');
  protected readonly confirmingDelete = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly ids = ADDRESS_FIELD_IDS;

  constructor() {
    inject(PageMeta).set({
      title: 'הכתובות שלי',
      description: 'כתובות המשלוח השמורות שלי',
      path: '/account/addresses',
      noindex: true,
    });
    if (isPlatformBrowser(inject(PLATFORM_ID))) void this.load();
  }

  protected async load(): Promise<void> {
    await this.store.load();
    try {
      this.addresses.set(await this.api.addresses());
      this.state.set('ready');
    } catch (error) {
      if (this.store.unauthorized(error)) return;
      this.state.set('error');
    }
  }

  protected retry(): void {
    this.state.set('loading');
    void this.load();
  }

  protected openNew(): void {
    this.open('new', emptyAddressForm(), false);
  }

  protected openEdit(a: CustomerAddressView): void {
    this.open(a.id, formFromAddress(a), a.isDefault);
  }

  private open(id: string, form: AddressForm, isDefault: boolean): void {
    this.confirmingDelete.set(null);
    this.errors.set({});
    this.formError.set('');
    this.form.set(form);
    this.editingDefault.set(isDefault);
    this.editing.set(id);
    afterNextRender(() => document.getElementById(this.ids['address.localityId'])?.focus(), {
      injector: this.injector,
    });
  }

  protected closeForm(): void {
    this.editing.set(null);
    this.errors.set({});
    this.formError.set('');
  }

  protected set(field: 'street' | 'houseNumber' | 'apartment' | 'floor' | 'notes', event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
    this.form.update((f) => ({ ...f, [field]: value }));
  }

  protected setFlag(field: 'hasElevator' | 'isDefault', event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.form.update((f) => ({ ...f, [field]: checked }));
  }

  protected setLocality(locality: LocalityOption | null): void {
    this.form.update((f) => ({ ...f, locality }));
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    const errors = validateAddress(this.form());
    this.errors.set(errors);
    this.formError.set('');
    const first = (Object.keys(errors) as AddressField[])[0];
    if (first) {
      document.getElementById(this.ids[first])?.focus();
      return;
    }
    const id = this.editing();
    const input = toAddressInput(this.form());
    this.busy.set(true);
    try {
      if (id === 'new') await this.api.createAddress(input);
      else await this.api.updateAddress(id!, input);
      this.closeForm();
      await this.load();
    } catch (error) {
      if (this.store.unauthorized(error)) return;
      const failure = accountFailure(error);
      if (failure.code === 'invalid_field' && isAddressField(failure.field)) {
        this.errors.set({ [failure.field]: accountErrorMessage(failure) });
        document.getElementById(this.ids[failure.field])?.focus();
      } else {
        this.formError.set(accountErrorMessage(failure));
      }
    } finally {
      this.busy.set(false);
    }
  }

  protected async makeDefault(a: CustomerAddressView): Promise<void> {
    if (this.busy()) return;
    this.listError.set('');
    this.busy.set(true);
    try {
      await this.api.updateAddress(a.id, toAddressInput({ ...formFromAddress(a), isDefault: true }));
      await this.load();
    } catch (error) {
      if (this.store.unauthorized(error)) return;
      this.listError.set(accountErrorMessage(accountFailure(error)));
    } finally {
      this.busy.set(false);
    }
  }

  protected askDelete(a: CustomerAddressView): void {
    this.closeForm();
    this.confirmingDelete.set(a.id);
    // The safe choice gets the focus first.
    afterNextRender(() => document.getElementById(`ad-keep-${a.id}`)?.focus(), { injector: this.injector });
  }

  protected async confirmDelete(a: CustomerAddressView): Promise<void> {
    if (this.busy()) return;
    this.listError.set('');
    this.busy.set(true);
    try {
      await this.api.deleteAddress(a.id);
      this.confirmingDelete.set(null);
      await this.load();
    } catch (error) {
      if (this.store.unauthorized(error)) return;
      this.listError.set(accountErrorMessage(accountFailure(error)));
    } finally {
      this.busy.set(false);
    }
  }

  protected addressLine(a: CustomerAddressView): string {
    const apartment = a.apartment ? `, דירה ${a.apartment}` : '';
    return `${a.street} ${a.houseNumber}${apartment}, ${a.localityNameHe}`;
  }
}
