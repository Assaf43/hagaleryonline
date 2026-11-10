import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  untracked,
  viewChild,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { CdkTrapFocus } from '@angular/cdk/a11y';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { LucideX } from '@lucide/angular';
import { filter } from 'rxjs';
import { CartStore } from '../core/cart.store';
import { formatPrice } from '../core/format';
import { ResponsiveImage } from '../catalog/responsive-image';

let nextId = 0;

/**
 * Mini cart (CRT-01, spec §3.2): a side `<dialog>` that opens after an add and from the header's cart
 * button (`CartStore.miniCartOpen`). Focus moves in, stays trapped (native modal + CDK trap), and goes
 * back to the button that opened it on close (Escape, the close button, the backdrop or a link).
 */
@Component({
  selector: 'hg-mini-cart',
  imports: [RouterLink, CdkTrapFocus, LucideX, ResponsiveImage],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './mini-cart.html',
  styleUrl: './mini-cart.scss',
})
export class MiniCart {
  protected readonly cart = inject(CartStore);
  private readonly doc = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly closeBtn = viewChild<ElementRef<HTMLButtonElement>>('closeBtn');
  protected readonly titleId = `hg-mini-cart-title-${nextId++}`;

  /** No answer from the server yet: show "טוען…" rather than an empty cart. */
  protected readonly loading = computed(() => this.cart.view() === null);
  protected readonly lines = computed(() => this.cart.view()?.lines ?? []);
  protected readonly notices = computed(() => this.cart.view()?.notices ?? []);
  protected readonly subtotal = computed(() => formatPrice(this.cart.view()?.subtotal ?? 0));
  protected readonly price = formatPrice;

  /** The element focused before opening, to hand focus back. */
  private opener: HTMLElement | null = null;

  constructor() {
    effect(() => {
      const open = this.cart.miniCartOpen();
      untracked(() => (open ? this.show() : this.hide()));
    });
    inject(Router)
      .events.pipe(
        filter((e) => e instanceof NavigationEnd),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe(() => this.close());
  }

  protected close(): void {
    this.cart.miniCartOpen.set(false);
    this.hide();
  }

  /** Clicking the dark backdrop closes it. */
  protected backdropClick(event: MouseEvent): void {
    if (event.target === this.dialog().nativeElement) this.close();
  }

  /** Escape: our own handling, so it behaves the same where `<dialog>` has no native cancel. */
  protected escape(event: Event): void {
    event.preventDefault();
    this.close();
  }

  private show(): void {
    const dialog = this.dialog().nativeElement;
    if (dialog.open) return;
    const active = this.doc.activeElement;
    this.opener = active instanceof HTMLElement && active !== this.doc.body ? active : null;
    dialog.showModal();
    // Opened before the header's load answered (or it failed): read the cart now.
    if (this.cart.view() === null) void this.cart.load();
    afterNextRender(() => this.closeBtn()?.nativeElement.focus(), { injector: this.injector });
  }

  private hide(): void {
    const dialog = this.dialog()?.nativeElement;
    if (!dialog?.open) return;
    dialog.close();
    const opener = this.opener;
    this.opener = null;
    if (opener?.isConnected) opener.focus();
  }

  /** The browser closed the dialog by itself (e.g. its own Escape handling). */
  protected closed(): void {
    if (this.cart.miniCartOpen()) this.cart.miniCartOpen.set(false);
    const opener = this.opener;
    this.opener = null;
    if (opener?.isConnected) opener.focus();
  }
}
