import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Clipboard } from '@angular/cdk/clipboard';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import type { TotpSetup } from '@hg/models';
import { AuthService } from '../core/auth.service';
import { errorMessage } from '../core/errors';

/** First login: scan the QR code, confirm one code, keep the 10 recovery codes (decision 51). */
@Component({
  selector: 'hga-setup-2fa-page',
  imports: [FormsModule, MatButtonModule, MatCheckboxModule, MatFormFieldModule, MatInputModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="auth-page">
      @if (recoveryCodes(); as codes) {
        <section class="auth-card">
          <p class="auth-brand">הגלריה לכולם</p>
          <h1>שמרו את קודי השחזור</h1>
          <p class="auth-text">
            אם תאבדו את הטלפון, כל אחד מהקודים האלה יאפשר להיכנס פעם אחת. שמרו אותם במקום בטוח, למשל במנהל סיסמאות. הם
            מוצגים עכשיו בלבד.
          </p>
          <ol class="recovery-codes" dir="ltr">
            @for (code of codes; track code) {
              <li>{{ code }}</li>
            }
          </ol>
          <div class="auth-row">
            <button matButton="outlined" type="button" (click)="copy(codes)">{{ copied() ? 'הועתק' : 'העתקה' }}</button>
            <button matButton="outlined" type="button" (click)="download(codes)">הורדה כקובץ</button>
          </div>
          <mat-checkbox [(ngModel)]="saved">שמרתי את הקודים</mat-checkbox>
          <button matButton="filled" type="button" [disabled]="!saved" (click)="finish()">כניסה לממשק</button>
        </section>
      } @else {
        <form class="auth-card" (ngSubmit)="enable()">
          <p class="auth-brand">הגלריה לכולם</p>
          <h1>הגדרת אימות דו-שלבי</h1>
          <ol class="auth-steps">
            <li>התקינו בטלפון אפליקציית אימות, למשל Google Authenticator או Microsoft Authenticator.</li>
            <li>סרקו באפליקציה את הקוד שמתחת.</li>
            <li>הקלידו כאן את הקוד בן 6 הספרות שמופיע באפליקציה.</li>
          </ol>
          @if (setup(); as s) {
            <img class="qr" [src]="s.qrDataUrl" alt="קוד QR להוספה לאפליקציית האימות" width="200" height="200" />
            <p class="auth-hint">
              לא מצליחים לסרוק? הקלידו באפליקציה את המפתח: <bdi class="secret" dir="ltr">{{ s.secret }}</bdi>
            </p>
          } @else if (!error()) {
            <p class="auth-text">טוען…</p>
          }
          <mat-form-field>
            <mat-label>קוד מהאפליקציה</mat-label>
            <input
              matInput
              name="code"
              [(ngModel)]="code"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="7"
              dir="ltr"
            />
          </mat-form-field>
          @if (error()) {
            <p class="auth-error" role="alert">{{ error() }}</p>
          }
          <button matButton="filled" type="submit" [disabled]="busy() || !setup() || !code">הפעלה</button>
        </form>
      }
    </main>
  `,
})
export class Setup2faPage implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly clipboard = inject(Clipboard);
  protected code = '';
  protected saved = false;
  protected readonly setup = signal<TotpSetup | null>(null);
  protected readonly recoveryCodes = signal<string[] | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly copied = signal(false);

  async ngOnInit() {
    try {
      this.setup.set(await this.auth.setupTotp());
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  async enable() {
    this.busy.set(true);
    this.error.set('');
    try {
      this.recoveryCodes.set((await this.auth.enableTotp(this.code)).recoveryCodes);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  copy(codes: string[]) {
    this.copied.set(this.clipboard.copy(codes.join('\n')));
  }

  download(codes: string[]) {
    const text = `הגלריה לכולם — קודי שחזור לאימות דו-שלבי\nכל קוד עובד פעם אחת.\n\n${codes.join('\n')}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'hagalery-recovery-codes.txt' });
    a.click();
    URL.revokeObjectURL(url);
  }

  finish() {
    void this.router.navigateByUrl('/');
  }
}
