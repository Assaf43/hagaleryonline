import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { AuthService } from '../core/auth.service';
import { errorMessage } from '../core/errors';

/** Every later login: a code from the authenticator app, or one recovery code (decision 51). */
@Component({
  selector: 'hga-verify-2fa-page',
  imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="auth-page">
      <form class="auth-card" (ngSubmit)="submit()">
        <p class="auth-brand">הגלריה לכולם</p>
        <h1>אימות דו-שלבי</h1>
        @if (useRecovery()) {
          <p class="auth-text">הקלידו אחד מקודי השחזור ששמרתם. כל קוד עובד פעם אחת בלבד.</p>
          <mat-form-field>
            <mat-label>קוד שחזור</mat-label>
            <input matInput name="recovery" [(ngModel)]="value" autocomplete="off" dir="ltr" placeholder="abcd-efgh" />
          </mat-form-field>
        } @else {
          <p class="auth-text">פתחו את אפליקציית האימות בטלפון והקלידו את הקוד בן 6 הספרות.</p>
          <mat-form-field>
            <mat-label>קוד אימות</mat-label>
            <input
              matInput
              name="code"
              [(ngModel)]="value"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="7"
              dir="ltr"
            />
          </mat-form-field>
        }
        @if (error()) {
          <p class="auth-error" role="alert">{{ error() }}</p>
        }
        <button matButton="filled" type="submit" [disabled]="busy() || !value">אישור</button>
        <button matButton type="button" (click)="toggle()">
          {{ useRecovery() ? 'חזרה לקוד מהאפליקציה' : 'אין לי גישה לטלפון — קוד שחזור' }}
        </button>
        <button matButton type="button" (click)="cancel()">ביטול</button>
      </form>
    </main>
  `,
})
export class Verify2faPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  protected value = '';
  protected readonly useRecovery = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  toggle() {
    this.useRecovery.update((v) => !v);
    this.value = '';
    this.error.set('');
  }

  async submit() {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.auth.verify(this.useRecovery() ? { recoveryCode: this.value } : { code: this.value });
      await this.router.navigateByUrl('/');
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  async cancel() {
    await this.auth.logout().catch(() => undefined);
    await this.router.navigateByUrl('/login');
  }
}
