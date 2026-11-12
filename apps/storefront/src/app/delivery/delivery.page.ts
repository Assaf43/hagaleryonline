import {
  ChangeDetectionStrategy,
  Component,
  PLATFORM_ID,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import type { DeliveryLinkView } from '@hg/models';
import { PageMeta } from '../core/page-meta';
import { DeliveryApi } from './delivery.api';

/**
 * Delivery date confirmation `/delivery/:token` (spec §5.3, SHP-04). The token in the URL is the only key, so the
 * slot is read only in the browser (the server renders a shell and the token never reaches the HTML cache). The
 * customer confirms the date or asks for another one, with an optional note; a slot answers once.
 */
@Component({
  selector: 'hg-delivery-page',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './delivery.page.html',
  styleUrl: './delivery.page.scss',
})
export class DeliveryPage {
  readonly token = input.required<string>();

  private readonly api = inject(DeliveryApi);
  private readonly meta = inject(PageMeta);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));

  protected readonly slot = signal<DeliveryLinkView | null>(null);
  protected readonly state = signal<'loading' | 'ready' | 'invalid' | 'error'>('loading');
  protected readonly sending = signal(false);
  protected readonly sendError = signal('');
  protected readonly note = signal('');
  /** "9.12.2026" from the Israel calendar date as given (no timezone shift). */
  protected readonly date = computed(() => {
    const d = this.slot()?.date;
    const m = d ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(d) : null;
    return m ? `${Number(m[3])}.${Number(m[2])}.${m[1]}` : (d ?? '');
  });
  /** Bumped on every load, so an older answer is dropped. */
  private generation = 0;

  constructor() {
    effect(() => {
      const token = this.token();
      untracked(() => {
        this.meta.set({
          title: 'אישור מועד אספקה',
          description: 'אישור מועד האספקה של ההזמנה',
          path: '/delivery',
          noindex: true,
        });
        if (this.browser) void this.load(token);
      });
    });
  }

  protected reload(): void {
    void this.load(this.token());
  }

  private async load(token: string): Promise<void> {
    const generation = ++this.generation;
    this.state.set('loading');
    this.sendError.set('');
    try {
      const view = await this.api.view(token);
      if (generation !== this.generation) return;
      this.slot.set(view);
      this.state.set('ready');
    } catch (error) {
      if (generation !== this.generation) return;
      this.state.set(error instanceof HttpErrorResponse && error.status === 404 ? 'invalid' : 'error');
    }
  }

  protected setNote(event: Event): void {
    this.note.set((event.target as HTMLTextAreaElement).value);
  }

  protected async respond(answer: 'confirm' | 'change'): Promise<void> {
    if (this.sending()) return;
    this.sending.set(true);
    this.sendError.set('');
    const note = this.note().trim();
    try {
      const view = await this.api.answer(this.token(), {
        answer,
        ...(answer === 'change' && note ? { note } : {}),
      });
      this.slot.set(view);
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 409) await this.load(this.token());
      else if (error instanceof HttpErrorResponse && error.status === 404) this.state.set('invalid');
      else this.sendError.set('לא הצלחנו לשלוח את התשובה. אפשר לנסות שוב.');
    } finally {
      this.sending.set(false);
    }
  }
}
