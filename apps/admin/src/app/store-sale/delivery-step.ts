import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { SHIPPING_METHOD_LABELS_HE, MAX_FLOOR } from '@hg/models';
import type { CheckoutAddress, CustomerAddressView, LocalityOption, ShippingMethod, ShippingQuote } from '@hg/models';
import { formatPrice } from '../catalog/catalog-format';
import { storeErrorMessage } from './store-errors';
import { StoreOrdersApi } from '../core/store-orders.api';
import { FORM_STYLES } from './form.styles';
import type { DeliveryChoice } from './steps';

const valueOf = (event: Event) => (event.target as HTMLInputElement).value;

/** Step 3 (spec §4.1): the address (prefilled from the account's default), the quote and the method. */
@Component({
  selector: 'hga-delivery-step',
  imports: [MatButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [FORM_STYLES],
  template: `
    <h2 tabindex="-1" data-step-heading>משלוח</h2>
    @if (saved().length > 0) {
      <div role="group" aria-label="כתובות שמורות" class="actions">
        @for (a of saved(); track a.id) {
          <button type="button" class="pick" [attr.aria-pressed]="savedId() === a.id" (click)="useSaved(a)">
            {{ a.street }} {{ a.houseNumber }}, {{ a.localityNameHe }}
          </button>
        }
      </div>
    }
    <div class="row">
      <label>
        <span>יישוב</span>
        <input
          name="locality"
          autocomplete="off"
          role="combobox"
          aria-autocomplete="list"
          [attr.aria-expanded]="options().length > 0"
          [value]="localityText()"
          (input)="searchLocality($event)"
        />
      </label>
    </div>
    @if (options().length > 0) {
      <ul class="list" aria-label="יישובים">
        @for (o of options(); track o.id) {
          <li>
            <button type="button" class="pick" (click)="pickLocality(o)">{{ o.nameHe }}</button>
          </li>
        }
      </ul>
    }
    <div class="row">
      <label>
        <span>רחוב</span>
        <input name="street" maxlength="80" [value]="street()" (input)="street.set(valueOf($event))" />
      </label>
      <label>
        <span>מספר בית</span>
        <input
          name="houseNumber"
          maxlength="10"
          dir="ltr"
          [value]="houseNumber()"
          (input)="houseNumber.set(valueOf($event))"
        />
      </label>
      <label>
        <span>דירה</span>
        <input
          name="apartment"
          maxlength="10"
          dir="ltr"
          [value]="apartment()"
          (input)="apartment.set(valueOf($event))"
        />
      </label>
      <label>
        <span>קומה (0 = קרקע)</span>
        <input
          name="floor"
          type="number"
          min="0"
          [max]="maxFloor"
          inputmode="numeric"
          dir="ltr"
          [value]="floor()"
          (input)="setFloor($event)"
        />
      </label>
    </div>
    <label class="check">
      <input name="elevator" type="checkbox" [checked]="hasElevator()" (change)="setElevator($event)" />
      <span>יש מעלית</span>
    </label>
    <label>
      <span>הערות לשליח</span>
      <input name="notes" maxlength="300" [value]="notes()" (input)="notes.set(valueOf($event))" />
    </label>
    <div class="actions">
      <button matButton="outlined" type="button" [disabled]="busy() || !canQuote()" (click)="quote()">
        חישוב משלוח
      </button>
    </div>
    <div aria-live="polite">
      @if (quoted(); as q) {
        <div role="radiogroup" aria-label="שיטת משלוח" class="list">
          @for (m of q.methods; track m.method) {
            <button
              type="button"
              class="pick"
              role="radio"
              [attr.aria-checked]="method() === m.method"
              [class.chosen]="method() === m.method"
              (click)="method.set(m.method)"
            >
              {{ labels[m.method] }} · <bdi>{{ price(m.total) }}</bdi>
            </button>
          }
        </div>
      }
    </div>
    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }
    <div class="actions">
      <label class="check">
        <input
          name="saveAddress"
          type="checkbox"
          [checked]="saveAddress()"
          (change)="saveAddress.set(checked($event))"
        />
        <span>שמירת הכתובת בחשבון הלקוח</span>
      </label>
      <button matButton="filled" type="button" [disabled]="!ready()" (click)="done()">המשך לסיכום</button>
    </div>
  `,
})
export class DeliveryStep {
  private readonly api = inject(StoreOrdersApi);
  /** The choice made before (coming back from the summary keeps it). */
  readonly initial = input<DeliveryChoice | null>(null);
  readonly chosen = output<DeliveryChoice>();
  readonly failed = output<unknown>();

  protected readonly labels = SHIPPING_METHOD_LABELS_HE;
  protected readonly maxFloor = MAX_FLOOR;
  protected readonly price = formatPrice;
  protected readonly valueOf = valueOf;
  protected readonly saved = signal<CustomerAddressView[]>([]);
  protected readonly savedId = signal<string | null>(null);
  protected readonly options = signal<LocalityOption[]>([]);
  protected readonly localityId = signal<number | null>(null);
  protected readonly localityText = signal('');
  protected readonly street = signal('');
  protected readonly houseNumber = signal('');
  protected readonly apartment = signal('');
  protected readonly floor = signal(0);
  protected readonly hasElevator = signal(false);
  protected readonly notes = signal('');
  protected readonly quoted = signal<ShippingQuote | null>(null);
  protected readonly method = signal<ShippingMethod | null>(null);
  protected readonly saveAddress = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly canQuote = computed(() => this.localityId() !== null && this.floor() >= 0);
  protected readonly ready = computed(
    () => !!this.quoted() && !!this.method() && !!this.street().trim() && !!this.houseNumber().trim(),
  );
  private searchSeq = 0;

  async ngOnInit() {
    const before = this.initial();
    if (before) {
      this.fill(before.address, before.localityName);
      this.saveAddress.set(before.saveAddress);
      await this.quote(before.method);
    }
    try {
      const list = await this.api.addresses();
      this.saved.set(list);
      const first = list[0];
      if (!before && first) this.useSaved(first);
    } catch (e) {
      this.fail(e);
    }
  }

  protected checked(event: Event) {
    return (event.target as HTMLInputElement).checked;
  }

  protected setFloor(event: Event) {
    const n = Number(valueOf(event));
    this.floor.set(Number.isInteger(n) && n >= 0 ? Math.min(n, MAX_FLOOR) : 0);
    this.quoted.set(null);
    this.method.set(null);
  }

  protected setElevator(event: Event) {
    this.hasElevator.set(this.checked(event));
    this.quoted.set(null);
    this.method.set(null);
  }

  protected async searchLocality(event: Event) {
    const text = valueOf(event);
    this.localityText.set(text);
    this.localityId.set(null);
    this.quoted.set(null);
    this.method.set(null);
    const seq = ++this.searchSeq;
    if (text.trim().length < 2) {
      this.options.set([]);
      return;
    }
    try {
      const found = await this.api.localities(text.trim());
      if (seq === this.searchSeq) this.options.set(found);
    } catch (e) {
      this.fail(e);
    }
  }

  protected pickLocality(o: LocalityOption) {
    this.localityId.set(o.id);
    this.localityText.set(o.nameHe);
    this.options.set([]);
  }

  protected useSaved(a: CustomerAddressView) {
    this.savedId.set(a.id);
    this.fill(a, a.localityNameHe);
    this.saveAddress.set(false);
    void this.quote();
  }

  private fill(a: CheckoutAddress, localityName: string) {
    this.localityId.set(a.localityId);
    this.localityText.set(localityName);
    this.street.set(a.street);
    this.houseNumber.set(a.houseNumber);
    this.apartment.set(a.apartment ?? '');
    this.floor.set(a.floor);
    this.hasElevator.set(a.hasElevator);
    this.notes.set(a.notes ?? '');
    this.options.set([]);
  }

  protected async quote(keep?: ShippingMethod) {
    const localityId = this.localityId();
    if (localityId === null) return;
    this.error.set('');
    this.busy.set(true);
    try {
      const q = await this.api.quote({ localityId, floor: this.floor(), hasElevator: this.hasElevator() });
      this.quoted.set(q);
      const stillThere = (m: ShippingMethod | null) => !!m && q.methods.some((o) => o.method === m);
      const current = keep ?? this.method();
      this.method.set(stillThere(current) ? current : (q.methods[0]?.method ?? null));
    } catch (e) {
      this.fail(e);
    } finally {
      this.busy.set(false);
    }
  }

  protected done() {
    const localityId = this.localityId();
    const method = this.method();
    const option = this.quoted()?.methods.find((m) => m.method === method);
    if (localityId === null || !method || !option) return;
    this.chosen.emit({
      address: {
        localityId,
        street: this.street().trim(),
        houseNumber: this.houseNumber().trim(),
        apartment: this.apartment().trim() || null,
        floor: this.floor(),
        hasElevator: this.hasElevator(),
        notes: this.notes().trim() || null,
      },
      localityName: this.localityText(),
      method,
      shippingTotal: option.total,
      saveAddress: this.saveAddress(),
    });
  }

  private fail(e: unknown) {
    this.error.set(storeErrorMessage(e));
    this.failed.emit(e);
  }
}
