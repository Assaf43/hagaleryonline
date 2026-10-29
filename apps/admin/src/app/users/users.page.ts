import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatMenuModule } from '@angular/material/menu';
import { MatSnackBar } from '@angular/material/snack-bar';
import { LucideEllipsisVertical, LucidePlus, LucideShieldCheck } from '@lucide/angular';
import { PERMISSION_TEMPLATES, type AdminUserRow } from '@hg/models';
import { errorMessage } from '../core/errors';
import { UsersApi } from '../core/users.api';
import { LinkDialog, type LinkDialogData } from './link.dialog';
import { UserFormDialog, type UserFormResult } from './user-form.dialog';

const STATUS_LABEL: Record<AdminUserRow['status'], string> = { invited: 'הוזמן', active: 'פעיל', disabled: 'מושבת' };

/** Users and permissions — the Super Admin's screen (decisions 48–52). Cards, so it works on a phone too. */
@Component({
  selector: 'hga-users-page',
  imports: [DatePipe, MatButtonModule, MatMenuModule, LucideEllipsisVertical, LucidePlus, LucideShieldCheck],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './users.page.html',
  styleUrl: './users.page.scss',
})
export class UsersPage implements OnInit {
  private readonly api = inject(UsersApi);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);
  protected readonly users = signal<AdminUserRow[] | null>(null);
  protected readonly error = signal('');
  protected readonly statusLabel = STATUS_LABEL;

  ngOnInit() {
    void this.reload();
  }

  templateLabel(user: AdminUserRow): string {
    if (user.isSuperAdmin) return 'Super Admin';
    const label = PERMISSION_TEMPLATES.find((t) => t.code === user.template)?.labelHe ?? '—';
    return user.extraPermissions.length || user.removedPermissions.length ? `${label} (מותאם)` : label;
  }

  create() {
    this.dialog
      .open<UserFormDialog, null, UserFormResult>(UserFormDialog, { data: null, width: '520px', maxWidth: '95vw' })
      .afterClosed()
      .subscribe((result) => {
        if (!result) return;
        void this.reload();
        if (result.invite) this.showLink({ link: result.invite, kind: 'invite', name: result.user.name });
      });
  }

  edit(user: AdminUserRow) {
    this.dialog
      .open<UserFormDialog, AdminUserRow, UserFormResult>(UserFormDialog, {
        data: user,
        width: '520px',
        maxWidth: '95vw',
      })
      .afterClosed()
      .subscribe((result) => result && void this.reload());
  }

  async inviteLink(user: AdminUserRow) {
    await this.run(async () =>
      this.showLink({ link: await this.api.inviteLink(user.id), kind: 'invite', name: user.name }),
    );
  }

  async resetPassword(user: AdminUserRow) {
    await this.run(async () =>
      this.showLink({ link: await this.api.passwordResetLink(user.id), kind: 'reset', name: user.name }),
    );
  }

  async resetTwoFactor(user: AdminUserRow) {
    if (!confirm(`לאפס את האימות הדו-שלבי של ${user.name}? בכניסה הבאה יגדירו אותו מחדש, וכל ההתחברויות שלהם ינותקו.`))
      return;
    await this.run(() => this.api.resetTwoFactor(user.id), 'האימות הדו-שלבי אופס');
  }

  async revokeSessions(user: AdminUserRow) {
    await this.run(() => this.api.revokeSessions(user.id), `ההתחברויות של ${user.name} נותקו`);
  }

  async setStatus(user: AdminUserRow, status: 'active' | 'disabled') {
    if (status === 'disabled' && !confirm(`להשבית את ${user.name}? הם ינותקו מיד ולא יוכלו להתחבר.`)) return;
    await this.run(() => this.api.update(user.id, { status }), status === 'disabled' ? 'המשתמש הושבת' : 'המשתמש הופעל');
  }

  private showLink(data: LinkDialogData) {
    this.dialog.open(LinkDialog, { data, width: '560px', maxWidth: '95vw' });
  }

  private async run(action: () => Promise<unknown>, done?: string) {
    try {
      await action();
      if (done) this.snack.open(done, undefined, { duration: 3000 });
      await this.reload();
    } catch (e) {
      this.snack.open(errorMessage(e), 'סגירה', { duration: 6000 });
    }
  }

  private async reload() {
    try {
      this.users.set(await this.api.list());
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }
}
