import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { filter } from 'rxjs';
import { LucideChevronDown, LucideChevronLeft, LucideMenu, LucideX } from '@lucide/angular';
import { ThemeToggle } from '@hg/ui';
import { MenuData } from './menu-data';
import { SearchBox } from './search-box';

/**
 * Sticky header (NAV-01, NAV-02): logo, "by room" menu, furniture types, search and theme switch.
 * Desktop opens a mega-menu (room → furniture types); phones get a full-screen drawer built on
 * <dialog>, which traps focus and closes with Escape. Favorites and cart join in later phases.
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
    LucideMenu,
    LucideX,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './site-header.html',
  styleUrl: './site-header.scss',
})
export class SiteHeader {
  protected readonly menu = inject(MenuData);
  private readonly router = inject(Router);
  private readonly drawer = viewChild.required<ElementRef<HTMLDialogElement>>('drawer');

  protected readonly megaOpen = signal(false);
  /** Room shown in the mega-menu's types panel. */
  protected readonly activeRoom = signal(0);
  protected readonly room = computed(() => this.menu.rooms()[this.activeRoom()] ?? null);

  constructor() {
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
