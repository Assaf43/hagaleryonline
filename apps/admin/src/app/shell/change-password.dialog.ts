import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar } from '@angular/material/snack-bar';
import { AuthService } from '../core/auth.service';
import { errorMessage } from '../core/errors';

/** Needs the current password and a 2FA code; other devices are logged out (decision 59). */
@Component({
  selector: 'hga-change-password-dialog',
  imports: [FormsModule, MatButtonModule, MatDialogModule, MatFormFieldModule, MatInputModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>החלפת סיסמה</h2>
    <form (ngSubmit)="submit()">
      <mat-dialog-content class="dialog-form">
        <mat-form-field>
          <mat-label>הסיסמה הנוכחית</mat-label>
          <input matInput type="password" name="current" [(ngModel)]="current" autocomplete="current-password" />
        </mat-form-field>
        <mat-form-field>
          <mat-label>סיסמה חדשה</mat-label>
          <input matInput type="password" name="next" [(ngModel)]="next" autocomplete="new-password" />
          <mat-hint>לפחות 12 תווים. משפט של כמה מילים עובד מצוין.</mat-hint>
        </mat-form-field>
        <mat-form-field>
          <mat-label>קוד מאפליקציית האימות</mat-label>
          <input matInput name="code" [(ngModel)]="code" inputmode="numeric" autocomplete="one-time-code" dir="ltr" />
        </mat-form-field>
        <p class="dialog-note">אחרי ההחלפה תנותקו מכל שאר המכשירים.</p>
        @if (error()) {
          <p class="form-error" role="alert">{{ error() }}</p>
        }
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button matButton type="button" mat-dialog-close>ביטול</button>
        <button matButton="filled" type="submit" [disabled]="busy() || !current || !next || !code">שמירה</button>
      </mat-dialog-actions>
    </form>
  `,
})
export class ChangePasswordDialog {
  private readonly auth = inject(AuthService);
  private readonly ref = inject(MatDialogRef<ChangePasswordDialog>);
  private readonly snack = inject(MatSnackBar);
  protected current = '';
  protected next = '';
  protected code = '';
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  async submit() {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.auth.changePassword(this.current, this.next, this.code);
      this.snack.open('הסיסמה הוחלפה', undefined, { duration: 3000 });
      this.ref.close();
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
