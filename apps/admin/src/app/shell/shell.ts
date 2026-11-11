import { BreakpointObserver } from '@angular/cdk/layout';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatMenuModule } from '@angular/material/menu';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatToolbarModule } from '@angular/material/toolbar';
import { map } from 'rxjs';
import {
  LucideBadgePercent,
  LucideFileSpreadsheet,
  LucideFolderTree,
  LucideKeyRound,
  LucideLayoutDashboard,
  LucideLogOut,
  LucideMenu,
  LucidePlugZap,
  LucideReceipt,
  LucideScrollText,
  LucideSofa,
  LucideTruck,
  LucideUserRound,
  LucideUsers,
} from '@lucide/angular';
import { BRAND } from '@hg/models';
import type { Permission } from '@hg/models';
import { ThemeToggle } from '@hg/ui';
import { AuthService } from '../core/auth.service';
import { ChangePasswordDialog } from './change-password.dialog';

/** Signed-in layout: toolbar, side navigation (a drawer on phones), and the page (ADM-15). */
@Component({
  selector: 'hga-shell',
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MatButtonModule,
    MatMenuModule,
    MatSidenavModule,
    MatToolbarModule,
    ThemeToggle,
    LucideBadgePercent,
    LucideFileSpreadsheet,
    LucideFolderTree,
    LucideKeyRound,
    LucideLayoutDashboard,
    LucideLogOut,
    LucideMenu,
    LucidePlugZap,
    LucideReceipt,
    LucideScrollText,
    LucideSofa,
    LucideTruck,
    LucideUserRound,
    LucideUsers,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './shell.html',
  styleUrl: './shell.scss',
})
export class Shell {
  protected readonly brand = BRAND.name;
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly dialog = inject(MatDialog);

  protected readonly isPhone = toSignal(
    inject(BreakpointObserver)
      .observe('(max-width: 1023.98px)')
      .pipe(map((s) => s.matches)),
    { initialValue: false },
  );
  protected readonly canSeeAudit = computed(() => this.can('audit.view'));

  protected can(permission: Permission): boolean {
    return this.auth.me()?.permissions.includes(permission) ?? false;
  }

  changePassword() {
    this.dialog.open(ChangePasswordDialog, { width: '440px', maxWidth: '95vw' });
  }

  async logout(everywhere = false) {
    await this.auth.logout(everywhere).catch(() => this.auth.clear());
    await this.router.navigateByUrl('/login');
  }
}
