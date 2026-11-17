import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import {
  CONSENT_ACTION_LABELS_HE,
  CONSENT_ACTOR_LABELS_HE,
  CONSENT_SOURCE_LABELS_HE,
  CUSTOMER_ORIGIN_LABELS_HE,
  MARKETING_STATUS_LABELS_HE,
  ORDER_CHANNEL_LABELS_HE,
  ORDER_STATUS_LABELS_HE,
  PERSONAL_CODE_STATUS_LABELS_HE,
  type CustomerProfile,
} from '@hg/models';
import { formatPrice } from '../catalog/catalog-format';
import { AuthService } from '../core/auth.service';
import { CustomersApi } from '../core/customers.api';
import { errorMessage } from '../core/errors';
import { israelDateTime, israelDay } from '../promotions/israel-time';
import { discountText, minimumText } from './discount-text';
import { IssueCodeDialog, type IssueCodeDialogData } from './issue-code.dialog';

/**
 * One customer (spec §4.5, CLB-09, permission customers.view): details and how the account was created, its own
 * orders (a guest order is never listed, decision 77), favorites, interest categories, the marketing consent with its
 * history, and the personal codes. "הנפקת קופון אישי" needs `club.manage` and reloads the profile when a code was
 * issued. The route's `:id` is bound to the input; only the answer to the latest request is shown.
 */
@Component({
  selector: 'hga-customer-page',
  imports: [RouterLink, MatButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './customer.page.html',
  styleUrl: './customer.page.scss',
})
export class CustomerPage {
  private readonly api = inject(CustomersApi);
  private readonly auth = inject(AuthService);
  private readonly dialog = inject(MatDialog);
  /** Increases with every load; a slower, older answer finds it changed and is dropped. */
  private requestSeq = 0;

  readonly id = input.required<string>();

  protected readonly originLabels = CUSTOMER_ORIGIN_LABELS_HE;
  protected readonly orderStatusLabels = ORDER_STATUS_LABELS_HE;
  protected readonly channelLabels = ORDER_CHANNEL_LABELS_HE;
  protected readonly marketingLabels = MARKETING_STATUS_LABELS_HE;
  protected readonly actionLabels = CONSENT_ACTION_LABELS_HE;
  protected readonly sourceLabels = CONSENT_SOURCE_LABELS_HE;
  protected readonly actorLabels = CONSENT_ACTOR_LABELS_HE;
  protected readonly codeStatusLabels = PERSONAL_CODE_STATUS_LABELS_HE;
  protected readonly dateTime = israelDateTime;
  protected readonly day = israelDay;
  protected readonly formatPrice = formatPrice;
  protected readonly discountText = discountText;
  protected readonly minimumText = minimumText;
  protected readonly profile = signal<CustomerProfile | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  /** The order page needs orders.view; without it the order number is shown as text. */
  protected readonly canSeeOrders = computed(() => this.auth.can('orders.view'));
  /** Issuing a code needs club.manage; the button is not even shown without it. */
  protected readonly canIssue = computed(() => this.auth.can('club.manage'));

  constructor() {
    effect(() => void this.load(this.id()));
  }

  protected issue(p: CustomerProfile) {
    const data: IssueCodeDialogData = {
      customerId: p.id,
      fullName: p.fullName,
      email: p.email,
      emailVerified: p.emailVerified,
    };
    this.dialog
      .open(IssueCodeDialog, { data, autoFocus: 'dialog', width: '32rem', maxWidth: '95vw' })
      .afterClosed()
      .subscribe((issued) => {
        if (issued) void this.load(p.id);
      });
  }

  protected retry() {
    void this.load(this.id());
  }

  private async load(id: string) {
    const seq = ++this.requestSeq;
    this.loading.set(true);
    this.error.set('');
    try {
      const result = await this.api.get(id);
      if (seq === this.requestSeq) this.profile.set(result);
    } catch (e) {
      if (seq !== this.requestSeq) return;
      this.profile.set(null);
      this.error.set(errorMessage(e));
    } finally {
      if (seq === this.requestSeq) this.loading.set(false);
    }
  }
}
