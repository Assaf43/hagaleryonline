import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import type { CodeTemplateOption, IssuedPersonalCode, PersonalCodeSend } from '@hg/models';
import { CustomersApi } from '../core/customers.api';
import { errorMessage } from '../core/errors';
import { israelDay } from '../promotions/israel-time';
import { formatPrice } from '../catalog/catalog-format';
import { discountText } from './discount-text';

export interface IssueCodeDialogData {
  customerId: string;
  fullName: string;
  email: string | null;
  emailVerified: boolean;
}

const SENT_NOTE: Record<PersonalCodeSend, string> = {
  none: 'הקוד לא נשלח. אפשר להעביר אותו ללקוח בעצמכם.',
  email: 'הקוד יישלח ללקוח במייל.',
  sms: 'הקוד יישלח ללקוח ב-SMS.',
};

/**
 * "הנפקת קופון אישי" (spec §4.5, decision 94, permission club.manage): pick an active personal-code template and how
 * the code reaches the customer (not sent, e-mail, or SMS). The code is shown when it is issued (and stays on the
 * customer's page); the dialog closes with `true` once a code was issued, so the profile reloads. Closed by Escape or
 * the backdrop after issuing, `hasIssued()` tells the page to reload all the same.
 */
@Component({
  selector: 'hga-issue-code-dialog',
  imports: [MatButtonModule, MatDialogModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    .lead,
    .hint,
    .sent {
      margin: 0;
      color: var(--color-text-secondary);
      font-size: var(--font-small);
    }

    fieldset {
      margin: 0;
      padding: 0;
      border: none;
      min-inline-size: 0;
      display: grid;
      gap: var(--space-2);
    }

    legend {
      padding: 0;
      margin-block-end: var(--space-2);
      font-weight: 700;
    }

    .option {
      display: flex;
      align-items: flex-start;
      gap: var(--space-2);
    }

    .option-text {
      display: grid;
    }

    .error {
      margin: 0;
      color: var(--color-danger);
    }

    .issued {
      display: grid;
      gap: var(--space-2);
    }

    .code {
      font-size: var(--font-h3);
      font-weight: 700;
    }
  `,
  template: `
    <h2 mat-dialog-title>הנפקת קופון אישי</h2>
    @if (issued(); as result) {
      <mat-dialog-content class="issued" aria-live="polite">
        <p class="lead">הקוד הונפק ל{{ data.fullName }}.</p>
        <bdi dir="ltr" class="code">{{ result.code }}</bdi>
        <p class="lead">
          תקף עד <bdi>{{ day(result.expiresAt) }}</bdi>
        </p>
        <p class="sent">{{ sentNote() }}</p>
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button matButton="filled" type="button" class="done" (click)="ref.close(true)">סיום</button>
      </mat-dialog-actions>
    } @else {
      <form (submit)="submit($event)">
        <mat-dialog-content class="dialog-form">
          <p class="lead">קוד חד־פעמי ל{{ data.fullName }}, לפי תבנית פעילה.</p>
          @if (loading()) {
            <p class="lead" role="status">טוען תבניות…</p>
          } @else if (!templates().length) {
            <p class="lead">אין תבניות פעילות. אפשר ליצור תבנית במסך "מבצעים וקופונים".</p>
          } @else {
            <fieldset class="templates">
              <legend>תבנית</legend>
              @for (t of templates(); track t.id) {
                <label class="option">
                  <input
                    type="radio"
                    name="template"
                    [value]="t.id"
                    [checked]="templateId() === t.id"
                    (change)="templateId.set(t.id)"
                  />
                  <span class="option-text">
                    <strong>{{ t.name }}</strong>
                    <span class="hint"
                      ><bdi>{{ discountText(t.discountType, t.value) }}</bdi>
                      @if (t.minSubtotal) {
                        · קנייה מעל <bdi>{{ price(t.minSubtotal) }}</bdi>
                      }
                      · תוקף <bdi>{{ t.validityDays }}</bdi> ימים</span
                    >
                  </span>
                </label>
              }
            </fieldset>
            <fieldset class="sending">
              <legend>איך להעביר ללקוח</legend>
              <label class="option">
                <input
                  type="radio"
                  name="send"
                  value="none"
                  [checked]="send() === 'none'"
                  (change)="send.set('none')"
                />
                לא לשלוח (אמסור ללקוח בעצמי)
              </label>
              <label class="option">
                <input
                  type="radio"
                  name="send"
                  value="email"
                  [disabled]="!data.emailVerified"
                  [checked]="send() === 'email'"
                  (change)="send.set('email')"
                />
                <span class="option-text">
                  שליחה במייל
                  @if (!data.emailVerified) {
                    <span class="hint">אין ללקוח מייל מאומת.</span>
                  }
                </span>
              </label>
              <label class="option">
                <input type="radio" name="send" value="sms" [checked]="send() === 'sms'" (change)="send.set('sms')" />
                שליחה ב-SMS
              </label>
            </fieldset>
          }
          @if (problem()) {
            <p class="error" role="alert">{{ problem() }}</p>
          }
        </mat-dialog-content>
        <mat-dialog-actions align="end">
          <button matButton type="button" class="cancel" (click)="ref.close(false)">ביטול</button>
          <button matButton="filled" type="submit" class="issue" [disabled]="busy() || !templates().length">
            הנפקה
          </button>
        </mat-dialog-actions>
      </form>
    }
  `,
})
export class IssueCodeDialog {
  protected readonly data = inject<IssueCodeDialogData>(MAT_DIALOG_DATA);
  protected readonly ref = inject<MatDialogRef<IssueCodeDialog, boolean>>(MatDialogRef);
  private readonly api = inject(CustomersApi);

  protected readonly day = israelDay;
  protected readonly discountText = discountText;
  protected readonly price = formatPrice;
  protected readonly templates = signal<CodeTemplateOption[]>([]);
  protected readonly loading = signal(true);
  protected readonly templateId = signal<number | null>(null);
  protected readonly send = signal<PersonalCodeSend>('none');
  protected readonly busy = signal(false);
  protected readonly problem = signal('');
  protected readonly issued = signal<IssuedPersonalCode | null>(null);

  constructor() {
    void this.loadTemplates();
  }

  /** A code was issued in this dialog (however it is closed afterwards). */
  hasIssued(): boolean {
    return this.issued() !== null;
  }

  protected sentNote(): string {
    return SENT_NOTE[this.send()];
  }

  protected async submit(event: Event) {
    event.preventDefault();
    if (this.busy()) return;
    const templateId = this.templateId();
    if (templateId === null) {
      this.problem.set('בחרו תבנית.');
      return;
    }
    this.busy.set(true);
    this.problem.set('');
    // No Escape / backdrop close while the request runs, or a code could be issued without the profile reloading.
    this.ref.disableClose = true;
    try {
      this.issued.set(await this.api.issueCode(this.data.customerId, templateId, this.send()));
    } catch (e) {
      this.problem.set(errorMessage(e));
    } finally {
      this.busy.set(false);
      this.ref.disableClose = false;
    }
  }

  private async loadTemplates() {
    try {
      this.templates.set(await this.api.codeTemplates());
    } catch (e) {
      this.problem.set(errorMessage(e));
    } finally {
      this.loading.set(false);
    }
  }
}
