import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { Router } from '@angular/router';
import { AuthService } from '../core/auth.service';

/** Five minutes before the idle logout (decision 53). */
@Component({
  selector: 'hga-idle-warning-dialog',
  imports: [MatButtonModule, MatDialogModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>החיבור עומד להסתיים</h2>
    <mat-dialog-content>
      <p>לא הייתה פעילות במערכת זמן רב. בעוד <bdi>5</bdi> דקות החיבור יסתיים.</p>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton type="button" [disabled]="busy()" (click)="logout()">התנתקות</button>
      <button matButton="filled" type="button" [disabled]="busy()" (click)="keepWorking()">המשך עבודה</button>
    </mat-dialog-actions>
  `,
})
export class IdleWarningDialog {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly ref = inject(MatDialogRef<IdleWarningDialog>);
  protected readonly busy = signal(false);

  /** Asking the server who we are also touches the session; the answer counts as activity in every tab. */
  async keepWorking() {
    this.busy.set(true);
    try {
      const me = await this.auth.load(true);
      this.ref.close();
      if (!me) await this.router.navigateByUrl('/login?reason=idle');
    } catch {
      // Network trouble: stay open so the user can try again before the logout.
    } finally {
      this.busy.set(false);
    }
  }

  async logout() {
    this.ref.close();
    await this.auth.logout().catch(() => this.auth.clear());
    await this.router.navigateByUrl('/login');
  }
}
