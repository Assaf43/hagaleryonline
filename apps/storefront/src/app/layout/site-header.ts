import { BRAND } from '@hg/models';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { filter } from 'rxjs';
import {
  LucideChevronDown,
  LucideChevronLeft,
  LucideHeart,
  LucideMenu,
  LucideShoppingBag,
  LucideUser,
  LucideX,
} from '@lucide/angular';
import { ThemeToggle } from '@hg/ui';
import { CustomerStore } from '../account/customer.store';
import { MiniCart } from '../cart/mini-cart';
import { CartStore } from '../core/cart.store';
import { FavoritesStore } from '../core/favorites.store';
import { MenuData } from './menu-data';
import { SearchBox } from './search-box';

/**
 * Sticky header (NAV-01, NAV-02, NAV-03): logo, "by room" menu, furniture types, search, theme switch and
 * favorites (CMP-01), the account (ACC-01: "התחברות", or "החשבון שלי" once the browser knows a customer is signed
 * in) and the cart (CRT-01), which opens the mini cart.
 * Desktop opens a mega-menu (room → furniture types); phones get a full-screen drawer built on
 * <dialog>, which traps focus and closes with Escape.
 */
@Component({
  selector: 'hg-site-header',
  imports: [
    RouterLink,
    RouterLinkActive,
    ThemeToggle,
    SearchBox,
    LucideChevronDown,
    LucideChevronLeft,
    LucideHeart,
    LucideMenu,
    LucideShoppingBag,
    LucideUser,
    LucideX,
    MiniCart,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './site-header.html',
  styleUrl: './site-header.scss',
})
export class SiteHeader {
  protected readonly brand = BRAND.name;
  protected readonly menu = inject(MenuData);
  private readonly router = inject(Router);
  private readonly drawer = viewChild.required<ElementRef<HTMLDialogElement>>('drawer');

  protected readonly megaOpen = signal(false);
  /** Room shown in the mega-menu's types panel. */
  protected readonly activeRoom = signal(0);
  protected readonly room = computed(() => this.menu.rooms()[this.activeRoom()] ?? null);

  private readonly favorites = inject(FavoritesStore);
  /** Favorites live on the device: the server and the hydration pass show none, then the browser's count. */
  private readonly hydrated = signal(false);
  protected readonly favoritesCount = computed(() => (this.hydrated() ? this.favorites.count() : 0));
  protected readonly favoritesLabel = computed(() => `המועדפים שלי (${this.favoritesCount()})`);

  /** The cart belongs to a cookie: the server render never reads it, the browser loads it after hydration. */
  private readonly cart = inject(CartStore);
  protected readonly cartCount = computed(() => (this.hydrated() ? this.cart.count() : 0));
  protected readonly cartLabel = computed(() => `סל הקניות (${this.cartCount()})`);

  /** The session is an httpOnly cookie: the server render and the hydration pass show the signed-out icon. */
  private readonly customer = inject(CustomerStore);
  private readonly signedIn = computed(() => this.hydrated() && this.customer.me() !== null);
  protected readonly accountLabel = computed(() => (this.signedIn() ? 'החשבון שלי' : 'התחברות'));
  protected readonly accountLink = computed(() => (this.signedIn() ? '/account/orders' : '/account'));

  constructor() {
    afterNextRender(() => {
      this.hydrated.set(true);
      void this.cart.load();
      void this.customer.load();
    });
    this.router.events
      .pipe(
        filter((e) => e instanceof NavigationEnd),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe(() => {
        this.megaOpen.set(false);
        this.closeDrawer();
      });
  }

  /** A mouse already opened the menu on hover, so a click keeps it open; keyboard and touch toggle. */
  protected roomsClick(event: MouseEvent) {
    const hoverCapable = matchMedia('(hover: hover)').matches;
    this.megaOpen.set(event.detail > 0 && hoverCapable ? true : !this.megaOpen());
  }

  /** Keyboard users tabbing out of the mega-menu close it. */
  protected focusOut(event: FocusEvent) {
    const next = event.relatedTarget as Node | null;
    if (next && !(event.currentTarget as HTMLElement).contains(next)) this.megaOpen.set(false);
  }

  protected openCart() {
    this.cart.miniCartOpen.set(true);
  }

  protected openDrawer() {
    this.drawer().nativeElement.showModal();
  }

  protected closeDrawer() {
    const dialog = this.drawer()?.nativeElement;
    if (dialog?.open) dialog.close();
  }

  /** Clicking the dark backdrop of the drawer closes it. */
  protected drawerClick(event: MouseEvent) {
    if (event.target === this.drawer().nativeElement) this.closeDrawer();
  }
}
