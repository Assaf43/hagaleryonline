import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { AuthService } from '../core/auth.service';
import { errorMessage } from '../core/errors';

@Component({
  selector: 'hga-login-page',
  imports: [ReactiveFormsModule, MatButtonModule, MatCheckboxModule, MatFormFieldModule, MatInputModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="auth-page">
      <form class="auth-card" [formGroup]="form" (ngSubmit)="submit()">
        <p class="auth-brand">הגלריה לכולם</p>
        <h1>כניסה לממשק הניהול</h1>

        <mat-form-field>
          <mat-label>אימייל</mat-label>
          <input matInput type="email" formControlName="email" autocomplete="username" dir="ltr" />
        </mat-form-field>
        <mat-form-field>
          <mat-label>סיסמה</mat-label>
          <input matInput type="password" formControlName="password" autocomplete="current-password" />
        </mat-form-field>
        <mat-checkbox formControlName="rememberDevice">לזכור את המכשיר הזה ל-30 יום</mat-checkbox>

        @if (error()) {
          <p class="auth-error" role="alert">{{ error() }}</p>
        }
        <button matButton="filled" type="submit" [disabled]="busy()">כניסה</button>
        <p class="auth-hint">שכחתם סיסמה? פנו ל-Super Admin לקבלת קישור לאיפוס.</p>
      </form>
    </main>
  `,
})
export class LoginPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly form = inject(FormBuilder).nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', Validators.required],
    rememberDevice: [false],
  });
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  async submit() {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      const { email, password, rememberDevice } = this.form.getRawValue();
      const { step } = await this.auth.login(email, password, rememberDevice);
      await this.router.navigateByUrl(step === 'setup-2fa' ? '/login/setup-2fa' : '/login/verify');
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
