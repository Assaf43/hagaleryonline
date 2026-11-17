import { ChangeDetectionStrategy, Component, DestroyRef, PLATFORM_ID, PendingTasks, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { SiteFooter } from './layout/site-footer';
import { SiteHeader } from './layout/site-header';
import { MenuData } from './layout/menu-data';
import { AnnouncementBar } from './content/announcement-bar';
import { SiteContentStore } from './content/site-content.store';

@Component({
  selector: 'hg-root',
  imports: [RouterOutlet, SiteHeader, SiteFooter, AnnouncementBar],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <hg-announcement-bar />
    <hg-site-header />
    <main id="main" tabindex="-1">
      <router-outlet />
    </main>
    <hg-site-footer />
  `,
  styles: `
    main {
      display: block;
      min-block-size: 60vh;
      outline: none;
    }
  `,
})
export class App {
  constructor() {
    void inject(MenuData).load();
    const content = inject(SiteContentStore);
    void inject(PendingTasks).run(() => content.load());
    // A new page starts at the top; filter and "load more" changes (same path) keep the scroll.
    if (isPlatformBrowser(inject(PLATFORM_ID))) {
      let path = '';
      inject(Router)
        .events.pipe(
          filter((e) => e instanceof NavigationEnd),
          takeUntilDestroyed(inject(DestroyRef)),
        )
        .subscribe((e) => {
          const next = e.urlAfterRedirects.split('?')[0];
          if (path && next !== path) window.scrollTo({ top: 0 });
          path = next;
        });
    }
  }
}
