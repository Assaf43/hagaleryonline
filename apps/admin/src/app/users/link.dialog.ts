import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Clipboard } from '@angular/cdk/clipboard';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { LucideCopy, LucideMessageCircle } from '@lucide/angular';
import type { OneTimeLink } from '@hg/models';

export interface LinkDialogData {
  link: OneTimeLink;
  kind: 'invite' | 'reset';
  name: string;
}

/** A one-time link shown once, to copy or send on WhatsApp (decision 52). */
@Component({
  selector: 'hga-link-dialog',
  imports: [DatePipe, MatButtonModule, MatDialogModule, LucideCopy, LucideMessageCircle],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>{{ data.kind === 'invite' ? 'קישור הזמנה' : 'קישור לאיפוס סיסמה' }} — {{ data.name }}</h2>
    <mat-dialog-content>
      <p>
        שלחו את הקישור ל{{ data.name }}. בקישור
        {{ data.kind === 'invite' ? 'בוחרים סיסמה ומצטרפים' : 'בוחרים סיסמה חדשה' }}. הוא עובד פעם אחת, עד
        {{ data.link.expiresAt | date: 'd.M.yyyy HH:mm' }}, ומוצג כאן רק עכשיו.
      </p>
      <p class="link-box" dir="ltr">{{ data.link.url }}</p>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <a matButton="outlined" [href]="whatsapp()" target="_blank" rel="noopener">
        <svg lucideMessageCircle></svg>
        וואטסאפ
      </a>
      <button matButton="outlined" type="button" (click)="copy()">
        <svg lucideCopy></svg>
        {{ copied() ? 'הועתק' : 'העתקה' }}
      </button>
      <button matButton="filled" type="button" mat-dialog-close>סגירה</button>
    </mat-dialog-actions>
  `,
})
export class LinkDialog {
  protected readonly data = inject<LinkDialogData>(MAT_DIALOG_DATA);
  private readonly clipboard = inject(Clipboard);
  protected readonly copied = signal(false);
  protected readonly whatsapp = computed(() => {
    const text =
      this.data.kind === 'invite'
        ? `הוזמנת לממשק הניהול של הגלריה לכולם. לבחירת סיסמה: ${this.data.link.url}`
        : `קישור לבחירת סיסמה חדשה בממשק הניהול של הגלריה לכולם: ${this.data.link.url}`;
    return `https://wa.me/?text=${encodeURIComponent(text)}`;
  });

  copy() {
    this.copied.set(this.clipboard.copy(this.data.link.url));
  }
}
