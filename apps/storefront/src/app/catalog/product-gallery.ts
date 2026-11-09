import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { LucideChevronLeft, LucideChevronRight, LucideX } from '@lucide/angular';
import type { ImageRef } from '@hg/models';
import { ResponsiveImage } from './responsive-image';

const SWIPE_PX = 50;

/**
 * Product gallery (PRD-01): main photo with thumbnails on desktop, a scroll-snap swipe track with a
 * "N / M" counter on mobile, and a full-screen `<dialog>` with previous/next, arrow keys, swipe and
 * zoom. Browser-only work (dialog, pointer, scroll) happens in event handlers, never during SSR.
 */
@Component({
  selector: 'hg-product-gallery',
  imports: [ResponsiveImage, LucideChevronLeft, LucideChevronRight, LucideX],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './product-gallery.html',
  styleUrl: './product-gallery.scss',
})
export class ProductGallery {
  readonly images = input.required<ImageRef[]>();
  /** The product name: alt text fallback and the full-screen dialog label. */
  readonly label = input.required<string>();

  private readonly doc = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Photos with an alt text always set. */
  protected readonly shown = computed(() =>
    this.images().map((img) => (img.altHe ? img : { ...img, altHe: this.label() })),
  );
  /** The current photo; goes back to the first when the photos change (e.g. another color). */
  protected readonly index = linkedSignal<ImageRef[], number>({ source: this.images, computation: () => 0 });
  protected readonly current = computed(() => this.shown()[this.index()] ?? null);
  protected readonly counter = computed(() => `${this.index() + 1} / ${this.images().length}`);
  protected readonly fullscreen = signal(false);
  protected readonly zoomed = signal(false);
  protected readonly origin = signal('50% 50%');

  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  private readonly track = viewChild<ElementRef<HTMLElement>>('track');
  private opener: HTMLElement | null = null;
  private startX: number | null = null;
  private moved = false;

  protected select(i: number): void {
    this.index.set(i);
    this.zoomed.set(false);
  }

  /** The mobile track was swiped: follow the snapped photo. Scroll offsets are negative in RTL. */
  protected trackScrolled(): void {
    const el = this.track()?.nativeElement;
    if (!el || !el.clientWidth) return;
    const i = Math.round(Math.abs(el.scrollLeft) / el.clientWidth);
    const max = this.images().length - 1;
    this.index.set(Math.min(Math.max(i, 0), max));
  }

  protected open(event: Event, i: number): void {
    this.opener = event.currentTarget as HTMLElement;
    this.select(i);
    this.fullscreen.set(true);
    const dialog = this.dialog()?.nativeElement;
    if (!dialog || dialog.open) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  protected close(): void {
    const dialog = this.dialog()?.nativeElement;
    if (dialog?.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
    this.closed();
  }

  /** The dialog is closed (by us, by Escape or the browser): hand focus back to the photo we came from. */
  protected closed(): void {
    if (!this.fullscreen()) return;
    this.fullscreen.set(false);
    this.zoomed.set(false);
    this.opener?.focus();
  }

  private isRtl(): boolean {
    const dir = this.host.nativeElement.closest('[dir]')?.getAttribute('dir') ?? this.doc.documentElement.dir;
    return dir === 'rtl';
  }

  /** Steps in reading order, wrapping around. */
  protected step(delta: 1 | -1): void {
    const n = this.images().length;
    if (n < 2) return;
    this.select((this.index() + delta + n) % n);
  }

  protected key(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    // Reading direction: in RTL the arrow pointing left goes forward.
    const forward = this.isRtl() ? event.key === 'ArrowLeft' : event.key === 'ArrowRight';
    this.step(forward ? 1 : -1);
  }

  protected backdropClick(event: MouseEvent): void {
    if (event.target === this.dialog()?.nativeElement) this.close();
  }

  protected pointerDown(event: PointerEvent): void {
    this.startX = event.clientX;
    this.moved = false;
  }

  protected pointerMove(event: PointerEvent): void {
    if (this.zoomed()) this.setOrigin(event);
    else if (this.startX !== null && Math.abs(event.clientX - this.startX) > SWIPE_PX / 2) this.moved = true;
  }

  protected pointerUp(event: PointerEvent): void {
    const start = this.startX;
    this.startX = null;
    if (start === null || this.zoomed()) return;
    const dx = event.clientX - start;
    if (Math.abs(dx) < SWIPE_PX) return;
    // Dragging the photo toward the end of the line shows the next one; in RTL that is to the right.
    this.step((this.isRtl() ? dx > 0 : dx < 0) ? 1 : -1);
  }

  /** Click on the photo: a swipe is not a click; otherwise zoom 2x at the pointer, or back. */
  protected toggleZoom(event: MouseEvent): void {
    if (this.moved) {
      this.moved = false;
      return;
    }
    if (this.zoomed()) {
      this.zoomed.set(false);
      return;
    }
    this.setOrigin(event);
    this.zoomed.set(true);
  }

  private setOrigin(event: MouseEvent): void {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = ((event.clientX - rect.left) / rect.width) * 100;
    const y = ((event.clientY - rect.top) / rect.height) * 100;
    this.origin.set(`${x.toFixed(1)}% ${y.toFixed(1)}%`);
  }
}
