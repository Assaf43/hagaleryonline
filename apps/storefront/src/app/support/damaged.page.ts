import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { SUPPORT_FIELD_MESSAGES_HE, SUPPORT_LIMITS, SUPPORT_NOT_DELIVERED_HE } from '@hg/models';
import { PageMeta } from '../core/page-meta';
import { CustomerStore } from '../account/customer.store';
import { OrderStep } from './order-step';
import { PhotoPicker } from './photo-picker';
import { SupportApi, supportErrorMessage, supportFailure, supportSuccessText, type SupportOrder } from './support.api';

type DamagedField = 'orderItemId' | 'description' | 'photos';

const IDS = { orderItemId: 'dm-line', description: 'dm-description', photos: 'dm-photos' } as const;

/**
 * Damaged product `/returns/damaged` (spec §7.1, SRV-03): the order (`OrderStep`), the damaged line, a description and
 * 1–5 photos (`PhotoPicker`; checked in the browser, the server stays the authority). Only a delivered order, with no
 * day limit. The photos are sent once, with the form, and are visible only to staff. `noindex`, never in the sitemap.
 */
@Component({
  selector: 'hg-damaged-page',
  imports: [OrderStep, PhotoPicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './damaged.page.html',
  styleUrl: './support.scss',
})
export class DamagedPage {
  /** The order number from the link (`?order=`). */
  readonly order = input<string | undefined>(undefined);

  private readonly api = inject(SupportApi);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly store = inject(CustomerStore);
  /** Known only in the browser after the session loads; the server renders the signed-out text. */
  protected readonly signedIn = computed(() => this.store.me() !== null);

  protected readonly ids = IDS;
  protected readonly found = signal<SupportOrder | null>(null);
  protected readonly line = signal(0);
  protected readonly description = signal('');
  protected readonly photos = signal<File[]>([]);
  protected readonly website = signal('');
  protected readonly errors = signal<Partial<Record<DamagedField, string>>>({});
  protected readonly formError = signal('');
  protected readonly busy = signal(false);
  protected readonly done = signal('');
  protected readonly blocked = computed(() => {
    const o = this.found()?.order;
    return o && o.status !== 'delivered' ? SUPPORT_NOT_DELIVERED_HE : '';
  });
  protected readonly descriptionMax = SUPPORT_LIMITS.descriptionMax;

  constructor() {
    inject(PageMeta).set({
      title: 'דיווח על מוצר פגום',
      description: 'דיווח על מוצר שהגיע פגום, עם תמונות',
      path: '/returns/damaged',
      noindex: true,
    });
  }

  protected orderFound(result: SupportOrder | null): void {
    this.found.set(result);
    this.line.set(result && result.order.lines.length === 1 ? result.order.lines[0].orderItemId : 0);
    this.errors.set({});
    this.formError.set('');
  }

  protected setLine(event: Event): void {
    this.line.set(Number((event.target as HTMLSelectElement).value));
    this.clear('orderItemId');
  }

  protected setDescription(event: Event): void {
    this.description.set((event.target as HTMLTextAreaElement).value);
    this.clear('description');
  }

  protected setPhotos(files: File[]): void {
    this.photos.set(files);
    this.clear('photos');
  }

  protected setWebsite(event: Event): void {
    this.website.set((event.target as HTMLInputElement).value);
  }

  private clear(field: DamagedField): void {
    this.formError.set('');
    if (this.errors()[field]) this.errors.update((e) => ({ ...e, [field]: undefined }));
  }

  private focus(selector: string): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(), {
      injector: this.injector,
    });
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    const found = this.found();
    if (this.busy() || !found || this.blocked()) return;
    this.formError.set('');
    const errors: Partial<Record<DamagedField, string>> = {};
    const description = this.description().trim();
    if (!this.line()) errors.orderItemId = SUPPORT_FIELD_MESSAGES_HE.orderItemId;
    if (description.length < SUPPORT_LIMITS.descriptionMin || description.length > SUPPORT_LIMITS.descriptionMax) {
      errors.description = SUPPORT_FIELD_MESSAGES_HE.description;
    }
    if (this.photos().length < SUPPORT_LIMITS.photosMin) errors.photos = SUPPORT_FIELD_MESSAGES_HE.photos;
    this.errors.set(errors);
    const first = (['orderItemId', 'description', 'photos'] as const).find((f) => errors[f]);
    if (first) {
      this.focus(`#${IDS[first]}`);
      return;
    }
    this.busy.set(true);
    try {
      const created = await this.api.damaged(
        { order: found.ref, orderItemId: this.line(), description, website: this.website() },
        this.photos(),
      );
      this.done.set(supportSuccessText(created.ticketNumber));
      this.focus('#dm-success');
    } catch (error) {
      const failure = supportFailure(error);
      const message = supportErrorMessage(failure, 'damaged');
      const field = failure.field ?? '';
      if (
        failure.code === 'invalid_field' &&
        (field === 'orderItemId' || field === 'description' || field === 'photos')
      ) {
        this.errors.set({ [field]: message });
        this.focus(`#${IDS[field]}`);
      } else {
        this.formError.set(message);
      }
    } finally {
      this.busy.set(false);
    }
  }
}
