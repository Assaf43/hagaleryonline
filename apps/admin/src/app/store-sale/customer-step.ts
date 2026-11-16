import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import type {
  StoreCartView,
  StoreCodeChannel,
  StoreCodeRequest,
  StoreCustomerLookup,
  StoreVerifyRequest,
} from '@hg/models';
import { errorCode, storeErrorMessage } from '../core/errors';
import { StoreOrdersApi } from '../core/store-orders.api';
import { FORM_STYLES } from './form.styles';
import { isCompleteCode, sanitizeCode } from './steps';

const valueOf = (event: Event) => (event.target as HTMLInputElement).value;

/**
 * Step 2 (spec §4.1): the customer confirms by a code sent to the phone, or (existing account with a verified
 * e-mail) to the e-mail. A new phone takes a name and e-mail and gets a quick account when the code is right.
 */
@Component({
  selector: 'hga-customer-step',
  imports: [MatButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [FORM_STYLES],
  template: `
    <h2 tabindex="-1" data-step-heading>לקוח</h2>
    @if (cart()?.customer; as c) {
      <section class="card" aria-label="הלקוח המאושר">
        <span>
          <strong>{{ c.fullName }}</strong> · <bdi dir="ltr">{{ c.phone }}</bdi>
          @if (c.isNew) {
            <span class="muted"> · לקוח חדש</span>
          }
        </span>
        <span class="actions">
          <button matButton="outlined" type="button" (click)="change()">החלפת לקוח</button>
          <button matButton="filled" type="button" (click)="next.emit()">המשך למשלוח</button>
        </span>
      </section>
    } @else {
      <form class="row" (submit)="lookup($event)">
        <label>
          <span>טלפון נייד של הלקוח</span>
          <input
            name="phone"
            type="tel"
            inputmode="tel"
            autocomplete="off"
            dir="ltr"
            [value]="phone()"
            (input)="phone.set(valueOf($event))"
          />
        </label>
        <button matButton="filled" type="submit" [disabled]="busy() || !phone().trim()">בדיקה</button>
      </form>

      @if (found(); as f) {
        @if (f.exists) {
          <p>
            <strong>{{ f.fullName }}</strong>
            @if (f.maskedEmail) {
              · <bdi dir="ltr">{{ f.maskedEmail }}</bdi>
            }
          </p>
          @if (!f.maskedEmail) {
            <label>
              <span>מייל (אין מייל בחשבון, יישמר כלא מאומת)</span>
              <input
                name="email"
                type="email"
                dir="ltr"
                autocomplete="off"
                [value]="email()"
                (input)="email.set(valueOf($event))"
              />
            </label>
          }
          <div class="actions">
            <button matButton="filled" type="button" [disabled]="busy()" (click)="send('sms')">שלח קוד ב-SMS</button>
            @if (f.emailVerified) {
              <button matButton="outlined" type="button" [disabled]="busy()" (click)="send('email')">
                שלח קוד למייל
              </button>
            }
          </div>
        } @else {
          <div class="row">
            <label>
              <span>שם מלא</span>
              <input name="fullName" autocomplete="off" [value]="fullName()" (input)="fullName.set(valueOf($event))" />
            </label>
            <label>
              <span>מייל</span>
              <input
                name="email"
                type="email"
                dir="ltr"
                autocomplete="off"
                [value]="email()"
                (input)="email.set(valueOf($event))"
              />
            </label>
          </div>
          <div class="actions">
            <button matButton="filled" type="button" [disabled]="busy()" (click)="send('sms')">שלח קוד</button>
          </div>
        }
      }

      @if (emailTaken()) {
        <p class="notice" role="alert">
          המייל הזה כבר שייך לחשבון קיים של הלקוח.
          <button matButton="outlined" type="button" [disabled]="busy()" (click)="confirmExisting()">
            אשר את החשבון הקיים
          </button>
        </p>
      }

      @if (sent()) {
        <form class="row" (submit)="verify($event)">
          <label>
            <span>הקוד שהלקוח קיבל (6 ספרות)</span>
            <input
              name="code"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="6"
              dir="ltr"
              [value]="code()"
              (input)="setCode($event)"
            />
          </label>
          <button matButton="filled" type="submit" [disabled]="busy() || !codeReady()">אישור</button>
        </form>
      }
    }
    <div aria-live="polite">
      @if (status()) {
        <p class="muted">{{ status() }}</p>
      }
    </div>
    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }
  `,
})
export class CustomerStep {
  private readonly api = inject(StoreOrdersApi);
  readonly cart = input<StoreCartView | null>(null);
  readonly cartChange = output<StoreCartView>();
  readonly next = output<void>();
  readonly failed = output<unknown>();

  protected readonly phone = signal('');
  protected readonly fullName = signal('');
  protected readonly email = signal('');
  protected readonly code = signal('');
  protected readonly found = signal<StoreCustomerLookup | null>(null);
  protected readonly sent = signal(false);
  protected readonly emailTaken = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly status = signal('');
  protected readonly codeReady = computed(() => isCompleteCode(this.code()));
  protected readonly valueOf = valueOf;
  /** What the pending code was sent for: the verify call repeats it with the code. */
  private pending: StoreCodeRequest | null = null;

  protected setCode(event: Event) {
    const clean = sanitizeCode(valueOf(event));
    this.code.set(clean);
    // Keep the field to digits even when the typed text had other characters.
    (event.target as HTMLInputElement).value = clean;
  }

  protected async lookup(event: Event) {
    event.preventDefault();
    this.reset();
    await this.run(async () => this.found.set(await this.api.lookup(this.phone().trim())));
  }

  protected async send(channel: StoreCodeChannel) {
    const f = this.found();
    if (!f) return;
    const phone = this.phone().trim();
    const email = this.email().trim();
    let request: StoreCodeRequest;
    if (f.exists) {
      request = { phone, channel, ...(!f.maskedEmail && email ? { newCustomer: { email } } : {}) };
    } else {
      request = { phone, channel: 'sms', newCustomer: { fullName: this.fullName().trim(), email } };
    }
    await this.sendRequest(request);
  }

  protected async confirmExisting() {
    this.emailTaken.set(false);
    await this.sendRequest({ email: this.email().trim(), channel: 'email' });
  }

  private async sendRequest(request: StoreCodeRequest) {
    this.emailTaken.set(false);
    await this.run(
      async () => {
        await this.api.sendCode(request);
        this.pending = request;
        this.code.set('');
        this.sent.set(true);
        this.status.set(request.channel === 'email' ? 'נשלח קוד למייל של הלקוח.' : 'נשלח קוד ב-SMS ללקוח.');
      },
      (e) => {
        if (errorCode(e) === 'email_taken') {
          this.emailTaken.set(true);
          return true;
        }
        return false;
      },
    );
  }

  protected async verify(event: Event) {
    event.preventDefault();
    const request = this.pending;
    if (!request || !this.codeReady()) return;
    await this.run(async () => {
      const view = await this.api.verify({ ...request, code: this.code() } as StoreVerifyRequest);
      this.status.set('');
      this.reset();
      this.cartChange.emit(view);
    });
  }

  protected async change() {
    await this.run(async () => {
      this.reset();
      this.cartChange.emit(await this.api.clearCustomer());
    });
  }

  private reset() {
    this.found.set(null);
    this.sent.set(false);
    this.emailTaken.set(false);
    this.pending = null;
    this.code.set('');
    this.error.set('');
  }

  /** `handled` returns true for an error the step shows in its own way. */
  private async run(work: () => Promise<void>, handled?: (e: unknown) => boolean) {
    this.error.set('');
    this.busy.set(true);
    try {
      await work();
    } catch (e) {
      if (!handled?.(e)) this.error.set(storeErrorMessage(e));
      this.failed.emit(e);
    } finally {
      this.busy.set(false);
    }
  }
}
