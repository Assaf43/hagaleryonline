import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  PLATFORM_ID,
  afterNextRender,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { LucideChevronLeft, LucideChevronRight } from '@lucide/angular';
import type { ProductCard as Card } from '@hg/models';
import { ProductCard } from './product-card';

/** The share of the visible width one button press scrolls. */
const STEP = 0.8;

/**
 * A titled horizontal row of product cards (PRD-12): a scroll-snap track that swipes on touch, with
 * previous/next buttons from the desktop breakpoint. Renders nothing for an empty list.
 */
@Component({
  selector: 'hg-product-row',
  imports: [ProductCard, LucideChevronLeft, LucideChevronRight],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './product-row.html',
  styleUrl: './product-row.scss',
})
export class ProductRow {
  readonly title = input.required<string>();
  readonly products = input.required<Card[]>();

  private readonly doc = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly track = viewChild<ElementRef<HTMLElement>>('track');

  protected readonly atStart = signal(true);
  protected readonly atEnd = signal(false);

  constructor() {
    // Measure once rendered and whenever the list changes.
    afterNextRender(() => this.measure());
    effect(() => {
      this.products();
      this.track();
      if (this.browser) queueMicrotask(() => this.measure());
    });
  }

  private isRtl(): boolean {
    const dir = this.host.nativeElement.closest('[dir]')?.getAttribute('dir') ?? this.doc.documentElement.dir;
    return dir === 'rtl';
  }

  /** Scroll offsets are negative in RTL, so the distance from the start is the absolute value. */
  protected measure(): void {
    const el = this.track()?.nativeElement;
    if (!el) return;
    const from = Math.abs(el.scrollLeft);
    this.atStart.set(from <= 1);
    this.atEnd.set(from + el.clientWidth >= el.scrollWidth - 1);
  }

  /** `1` goes toward the end of the line (left in RTL), `-1` back. */
  protected scroll(direction: 1 | -1): void {
    const el = this.track()?.nativeElement;
    if (!el) return;
    const sign = this.isRtl() ? -1 : 1;
    el.scrollBy({ left: sign * direction * el.clientWidth * STEP, behavior: 'smooth' });
  }
}
