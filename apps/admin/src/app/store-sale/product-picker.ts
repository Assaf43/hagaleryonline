import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import type { ProductDetail, SearchSuggestions, StoreCartView, VariantDetail } from '@hg/models';
import { formatPrice } from '../catalog/catalog-format';
import { storeErrorMessage } from '../core/errors';
import { StoreOrdersApi } from '../core/store-orders.api';
import { FORM_STYLES } from './form.styles';

/** The variant whose options match every chosen axis value (null while an axis is still open). */
export function matchVariant(product: ProductDetail, choice: Record<string, string>): VariantDetail | null {
  if (product.optionAxes.some((a) => !choice[a.code])) return null;
  return product.variants.find((v) => product.optionAxes.every((a) => v.options[a.code] === choice[a.code])) ?? null;
}

const valueOf = (event: Event) => (event.target as HTMLInputElement).value;

/** Step 1 (spec §4.1): find a product, pick its variant and quantity, edit the cart lines, add a coupon. */
@Component({
  selector: 'hga-product-picker',
  imports: [MatButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [FORM_STYLES],
  template: `
    <h2 tabindex="-1" data-step-heading>מוצרים</h2>
    <form class="row" role="search" (submit)="search($event)">
      <label>
        <span>חיפוש מוצר (שם דגם, מק"ט או שם)</span>
        <input name="q" type="search" autocomplete="off" [value]="query()" (input)="query.set(valueOf($event))" />
      </label>
      <button matButton="filled" type="submit">חיפוש</button>
    </form>
    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }
    @if (suggestions(); as s) {
      @if (s.products.length === 0) {
        <p class="muted" role="status">לא נמצאו מוצרים.</p>
      } @else {
        <ul class="list" aria-label="תוצאות חיפוש">
          @for (p of s.products; track p.slug) {
            <li>
              <button type="button" class="pick" (click)="open(p.slug)">
                <bdi dir="ltr">{{ p.modelName }}</bdi> {{ p.nameHe }} · החל מ־<bdi>{{ price(p.priceFrom) }}</bdi>
              </button>
            </li>
          }
        </ul>
      }
    }
    @if (product(); as pr) {
      <section class="card" aria-label="בחירת וריאנט">
        <strong
          ><bdi dir="ltr">{{ pr.modelName }}</bdi> {{ pr.nameHe }}</strong
        >
        @for (axis of pr.optionAxes; track axis.code) {
          <label>
            <span>{{ axis.nameHe }}</span>
            <select [attr.name]="'axis-' + axis.code" (change)="pickAxis(axis.code, $event)">
              <option value="" [selected]="!choice()[axis.code]">בחרו</option>
              @for (v of axis.values; track v.code) {
                <option [value]="v.code" [selected]="choice()[axis.code] === v.code">{{ v.labelHe }}</option>
              }
            </select>
          </label>
        }
        @if (variant(); as v) {
          <p class="muted">
            מק"ט <bdi dir="ltr">{{ v.sku }}</bdi> · <bdi>{{ price(v.price) }}</bdi>
            @if (!v.inStock) {
              · לא במלאי
            }
          </p>
        } @else if (pr.optionAxes.length > 0) {
          <p class="muted">בחרו ערך בכל אפשרות.</p>
        }
        <label>
          <span>כמות</span>
          <input
            name="qty"
            type="number"
            min="1"
            max="99"
            inputmode="numeric"
            dir="ltr"
            [value]="quantity()"
            (input)="setQuantity($event)"
          />
        </label>
        <button matButton="filled" type="button" [disabled]="!variant() || busy()" (click)="add()">הוספה לעגלה</button>
      </section>
    }
    @if (cart(); as c) {
      @if (c.lines.length > 0) {
        <section aria-label="העגלה">
          <ul class="list">
            @for (line of c.lines; track line.variantId) {
              <li class="card line">
                <span>
                  <bdi dir="ltr">{{ line.modelName }}</bdi> {{ line.nameHe }}
                  <span class="muted">{{ line.optionLabels.join(' · ') }}</span>
                  @if (!line.available) {
                    <span class="error">{{
                      line.unavailableReason === 'sold_out' ? 'אזל מהמלאי' : 'לא מוצג יותר'
                    }}</span>
                  }
                </span>
                <span class="actions">
                  <input
                    type="number"
                    min="1"
                    [max]="line.maxQuantity"
                    inputmode="numeric"
                    dir="ltr"
                    [attr.aria-label]="'כמות: ' + line.nameHe"
                    [value]="line.quantity"
                    (change)="changeLine(line.variantId, $event)"
                  />
                  <bdi>{{ price(line.lineTotal) }}</bdi>
                  <button matButton="outlined" type="button" (click)="remove(line.variantId)">הסרה</button>
                </span>
              </li>
            }
          </ul>
          <div aria-live="polite">
            @for (n of c.notices; track $index) {
              <p class="notice">{{ n.messageHe }}</p>
            }
          </div>
          <p>
            <strong
              >סכום ביניים: <bdi>{{ price(c.subtotal) }}</bdi></strong
            >
          </p>
          @if (c.discount; as d) {
            <p>
              {{ d.labelHe }}: <bdi>−{{ price(d.amount) }}</bdi>
            </p>
          }
        </section>
      }
      <form class="row" (submit)="coupon($event)">
        <label>
          <span>קוד קופון</span>
          <input
            name="coupon"
            autocomplete="off"
            dir="ltr"
            [value]="couponText()"
            (input)="couponText.set(valueOf($event))"
          />
        </label>
        <button matButton="outlined" type="submit">החלה</button>
        @if (c.couponCode) {
          <button matButton="outlined" type="button" (click)="dropCoupon()">הסרת הקופון {{ c.couponCode }}</button>
        }
      </form>
    }
  `,
})
export class ProductPicker {
  private readonly api = inject(StoreOrdersApi);
  readonly cart = input<StoreCartView | null>(null);
  readonly cartChange = output<StoreCartView>();
  /** Every API error, for the page (e.g. `customer_not_confirmed` sends the seller back to the customer step). */
  readonly failed = output<unknown>();

  protected readonly query = signal('');
  protected readonly suggestions = signal<SearchSuggestions | null>(null);
  protected readonly product = signal<ProductDetail | null>(null);
  protected readonly choice = signal<Record<string, string>>({});
  protected readonly quantity = signal(1);
  protected readonly couponText = signal('');
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  protected readonly variant = computed(() => {
    const pr = this.product();
    return pr ? matchVariant(pr, this.choice()) : null;
  });
  protected readonly price = formatPrice;
  protected readonly valueOf = valueOf;

  protected async search(event: Event) {
    event.preventDefault();
    this.product.set(null);
    const q = this.query().trim();
    if (!q) return;
    await this.run(async () => this.suggestions.set(await this.api.suggest(q)));
  }

  protected async open(slug: string) {
    await this.run(async () => {
      const pr = await this.api.product(slug);
      const choice: Record<string, string> = {};
      // An axis with a single value needs no choice.
      for (const a of pr.optionAxes) if (a.values.length === 1) choice[a.code] = a.values[0].code;
      this.choice.set(choice);
      this.quantity.set(1);
      this.product.set(pr);
    });
  }

  protected pickAxis(code: string, event: Event) {
    this.choice.update((c) => ({ ...c, [code]: valueOf(event) }));
  }

  protected setQuantity(event: Event) {
    const n = Number(valueOf(event));
    this.quantity.set(Number.isInteger(n) && n >= 1 ? Math.min(n, 99) : 1);
  }

  protected async add() {
    const v = this.variant();
    if (!v) return;
    await this.change(
      () => this.api.addItem(v.id, this.quantity()),
      () => this.product.set(null),
    );
  }

  protected async changeLine(variantId: number, event: Event) {
    const n = Number(valueOf(event));
    if (!Number.isInteger(n) || n < 1) return;
    await this.change(() => this.api.setQuantity(variantId, n));
  }

  protected async remove(variantId: number) {
    await this.change(() => this.api.removeItem(variantId));
  }

  protected async coupon(event: Event) {
    event.preventDefault();
    const code = this.couponText().trim();
    if (!code) return;
    await this.change(
      () => this.api.applyCoupon(code),
      () => this.couponText.set(''),
    );
  }

  protected async dropCoupon() {
    await this.change(() => this.api.removeCoupon());
  }

  private async change(call: () => Promise<StoreCartView>, after?: () => void) {
    await this.run(async () => {
      this.cartChange.emit(await call());
      after?.();
    });
  }

  private async run(work: () => Promise<void>) {
    this.error.set('');
    this.busy.set(true);
    try {
      await work();
    } catch (e) {
      this.error.set(storeErrorMessage(e));
      this.failed.emit(e);
    } finally {
      this.busy.set(false);
    }
  }
}
