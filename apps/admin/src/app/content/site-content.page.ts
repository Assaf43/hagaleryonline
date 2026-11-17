import { ChangeDetectionStrategy, Component, HostListener, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar } from '@angular/material/snack-bar';
import type { AdminSiteContent } from '@hg/models';
import { errorMessage } from '../core/errors';
import { RichTextEditor } from '../shared/rich-text-editor';
import { ContentApi } from './content.api';
import { FieldErrors, LEAVE_PROMPT, refusal } from './form-support';

interface SiteForm {
  supportPhone: string;
  supportEmail: string;
  whatsapp: string;
  shippingHtml: string;
}

const PHONE = /^\+?[0-9][0-9 -]{4,18}[0-9]$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WHATSAPP = /^[1-9][0-9]{7,14}$/;

const toForm = (s: AdminSiteContent): SiteForm => ({
  supportPhone: s.supportPhone,
  supportEmail: s.supportEmail,
  whatsapp: s.whatsapp,
  shippingHtml: s.shippingHtml,
});

/**
 * "פרטי האתר" (SRV-04, permission content.manage): the customer-service phone, e-mail and WhatsApp number and the
 * shipping text of the product page. Seeded placeholders show "טקסט זמני" until the first save.
 */
@Component({
  selector: 'hga-site-content-page',
  imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, RichTextEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './content.scss',
  template: `
    <h1>פרטי האתר</h1>
    <p class="page-intro">פרטי שירות הלקוחות שמופיעים באתר, והטקסט על המשלוח שמופיע בדף המוצר.</p>

    @if (loadError()) {
      <div class="form-error" role="alert">
        <p>{{ loadError() }}</p>
        <button matButton="outlined" type="button" (click)="load()">נסו שוב</button>
      </div>
    } @else if (!loaded()) {
      <p class="page-intro" role="status">טוען…</p>
    } @else {
      <form class="panel" novalidate (submit)="save($event)">
        @if (saved()?.interim) {
          <p class="notice">טקסט זמני: אלה הערכים ההתחלתיים. שמירה מסירה את הסימון.</p>
        }
        <div class="fields">
          <mat-form-field subscriptSizing="dynamic">
            <mat-label>טלפון שירות</mat-label>
            <input
              matInput
              id="site-phone"
              dir="ltr"
              inputmode="tel"
              autocomplete="off"
              [ngModel]="form().supportPhone"
              (ngModelChange)="set('supportPhone', $event)"
              [ngModelOptions]="{ standalone: true }"
              [errorStateMatcher]="fe.matcher('supportPhone')"
            />
            <mat-error>{{ fe.all()['supportPhone'] }}</mat-error>
          </mat-form-field>
          <mat-form-field subscriptSizing="dynamic">
            <mat-label>דוא"ל שירות</mat-label>
            <input
              matInput
              id="site-email"
              type="email"
              dir="ltr"
              autocomplete="off"
              [ngModel]="form().supportEmail"
              (ngModelChange)="set('supportEmail', $event)"
              [ngModelOptions]="{ standalone: true }"
              [errorStateMatcher]="fe.matcher('supportEmail')"
            />
            <mat-error>{{ fe.all()['supportEmail'] }}</mat-error>
          </mat-form-field>
          <mat-form-field subscriptSizing="dynamic">
            <mat-label>מספר וואטסאפ</mat-label>
            <input
              matInput
              id="site-whatsapp"
              dir="ltr"
              inputmode="numeric"
              autocomplete="off"
              [ngModel]="form().whatsapp"
              (ngModelChange)="set('whatsapp', $event)"
              [ngModelOptions]="{ standalone: true }"
              [errorStateMatcher]="fe.matcher('whatsapp')"
            />
            <mat-hint>ספרות בלבד, עם קידומת מדינה וללא פלוס. למשל: 972501234567</mat-hint>
            <mat-error>{{ fe.all()['whatsapp'] }}</mat-error>
          </mat-form-field>
        </div>

        <hga-rich-text-editor
          mode="inline"
          label="טקסט המשלוח בדף המוצר"
          [value]="form().shippingHtml"
          (valueChange)="setShipping($event)"
        />
        @if (fe.all()['shippingHtml']; as shippingError) {
          <p class="field-error" role="alert">{{ shippingError }}</p>
        }

        @if (problem()) {
          <p class="form-error" role="alert">{{ problem() }}</p>
        }
        <div class="actions">
          <button matButton="filled" type="submit" [disabled]="saving()">שמירה</button>
        </div>
      </form>
    }
  `,
})
export class SiteContentPage {
  private readonly api = inject(ContentApi);
  private readonly snack = inject(MatSnackBar);

  protected readonly fe = new FieldErrors();
  protected readonly form = signal<SiteForm>({ supportPhone: '', supportEmail: '', whatsapp: '', shippingHtml: '' });
  protected readonly saved = signal<AdminSiteContent | null>(null);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal('');
  protected readonly saving = signal(false);
  protected readonly problem = signal('');
  private readonly baseline = signal('');
  protected readonly dirty = computed(() => this.loaded() && JSON.stringify(this.form()) !== this.baseline());

  constructor() {
    void this.load();
  }

  canLeave(): boolean {
    return !this.dirty() || confirm(LEAVE_PROMPT);
  }

  @HostListener('window:beforeunload', ['$event'])
  protected beforeUnload(event: BeforeUnloadEvent) {
    if (this.dirty()) event.preventDefault();
  }

  protected set(field: 'supportPhone' | 'supportEmail' | 'whatsapp', value: string) {
    this.form.update((f) => ({ ...f, [field]: value }));
    this.fe.clear(field);
  }

  protected setShipping(shippingHtml: string) {
    this.form.update((f) => ({ ...f, shippingHtml }));
    this.fe.clear('shippingHtml');
  }

  async save(event?: Event) {
    event?.preventDefault();
    const prev = this.saved();
    if (this.saving() || !prev) return;
    this.problem.set('');
    const f = this.form();
    const errors: Record<string, string> = {};
    if (!PHONE.test(f.supportPhone.trim())) errors['supportPhone'] = 'מספר הטלפון לא תקין.';
    if (!EMAIL.test(f.supportEmail.trim())) errors['supportEmail'] = 'כתובת הדוא"ל לא תקינה.';
    if (!WHATSAPP.test(f.whatsapp.trim())) {
      errors['whatsapp'] = 'מספר הוואטסאפ צריך להיות ספרות בלבד, עם קידומת מדינה וללא פלוס.';
    }
    if (!f.shippingHtml.trim()) errors['shippingHtml'] = 'יש למלא את טקסט המשלוח.';
    this.fe.set(errors);
    if (Object.keys(errors).length) return;
    this.saving.set(true);
    try {
      const saved = await this.api.saveSite({
        supportPhone: f.supportPhone.trim(),
        supportEmail: f.supportEmail.trim(),
        whatsapp: f.whatsapp.trim(),
        shippingHtml: f.shippingHtml,
        expectedUpdatedAt: prev.updatedAt,
      });
      this.saved.set(saved);
      this.form.set(toForm(saved));
      this.baseline.set(JSON.stringify(this.form()));
      this.snack.open('פרטי האתר נשמרו', undefined, { duration: 2500 });
    } catch (e) {
      const r = refusal(e);
      if (r.field && ['supportPhone', 'supportEmail', 'whatsapp', 'shippingHtml'].includes(r.field)) {
        this.fe.set({ [r.field]: r.message });
      } else {
        this.problem.set(r.message);
      }
    } finally {
      this.saving.set(false);
    }
  }

  async load() {
    this.loaded.set(false);
    this.loadError.set('');
    try {
      const s = await this.api.site();
      this.saved.set(s);
      this.form.set(toForm(s));
      this.fe.set({});
      this.baseline.set(JSON.stringify(this.form()));
      this.loaded.set(true);
    } catch (e) {
      this.loadError.set(errorMessage(e));
    }
  }
}
