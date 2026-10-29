import { ChangeDetectionStrategy, Component, OnInit, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { errorMessage } from '../core/errors';
import { UsersApi } from '../core/users.api';

/** Invite and password-reset links (decisions 52, 59): the user, and only the user, chooses the password. */
@Component({
  selector: 'hga-link-page',
  imports: [FormsModule, RouterLink, MatButtonModule, MatFormFieldModule, MatInputModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="auth-page">
      <section class="auth-card">
        <p class="auth-brand">הגלריה לכולם</p>
        @if (done()) {
          <h1>הסיסמה נשמרה</h1>
          <p class="auth-text">עכשיו אפשר להיכנס. בכניסה הראשונה תגדירו אימות דו-שלבי בטלפון.</p>
          <a matButton="filled" routerLink="/login">לכניסה</a>
        } @else if (link(); as l) {
          <h1>{{ l.type === 'invite' ? 'ברוכים הבאים, ' + l.name : 'בחירת סיסמה חדשה' }}</h1>
          <p class="auth-text">
            {{ l.type === 'invite' ? 'בחרו סיסמה לחשבון' : 'בחרו סיסמה חדשה לחשבון' }} <bdi dir="ltr">{{ l.email }}</bdi
            >.
          </p>
          <form class="auth-form" (ngSubmit)="submit()">
            <mat-form-field>
              <mat-label>סיסמה</mat-label>
              <input matInput type="password" name="password" [(ngModel)]="password" autocomplete="new-password" />
              <mat-hint>לפחות 12 תווים. משפט של כמה מילים עובד מצוין.</mat-hint>
            </mat-form-field>
            <mat-form-field>
              <mat-label>שוב את אותה סיסמה</mat-label>
              <input matInput type="password" name="confirm" [(ngModel)]="confirm" autocomplete="new-password" />
            </mat-form-field>
            @if (error()) {
              <p class="auth-error" role="alert">{{ error() }}</p>
            }
            <button matButton="filled" type="submit" [disabled]="busy() || !password">שמירה</button>
          </form>
        } @else if (error()) {
          <h1>הקישור לא תקין</h1>
          <p class="auth-error" role="alert">{{ error() }}</p>
        } @else {
          <p class="auth-text">טוען…</p>
        }
      </section>
    </main>
  `,
})
export class LinkPage implements OnInit {
  private readonly api = inject(UsersApi);
  /** From the route (/invite/:token or /reset-password/:token). */
  readonly token = input.required<string>();
  protected password = '';
  protected confirm = '';
  protected readonly link = signal<{ type: 'invite' | 'reset'; email: string; name: string } | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly done = signal(false);

  async ngOnInit() {
    try {
      this.link.set(await this.api.describeLink(this.token()));
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  async submit() {
    if (this.password !== this.confirm) {
      this.error.set('הסיסמאות לא זהות.');
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      await this.api.useLink(this.token(), this.password);
      this.done.set(true);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
