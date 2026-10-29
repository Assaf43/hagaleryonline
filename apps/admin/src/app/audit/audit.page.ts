import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import type { AuditEntry, AuditPage } from '@hg/models';
import { errorMessage } from '../core/errors';
import { UsersApi } from '../core/users.api';

const ACTIONS: Record<string, string> = {
  'auth.login': 'התחברות',
  'auth.2fa_enabled': 'הפעלת אימות דו-שלבי',
  'auth.password_changed': 'החלפת סיסמה',
  'auth.password_reset': 'בחירת סיסמה חדשה מקישור איפוס',
  'auth.logout_all': 'יציאה מכל המכשירים',
  'user.create': 'יצירת משתמש',
  'user.create_super_admin': 'יצירת ה-Super Admin',
  'user.update': 'עדכון משתמש',
  'user.invite_accepted': 'הצטרפות מקישור הזמנה',
  'user.invite_link': 'קישור הזמנה חדש',
  'user.password_reset_link': 'קישור לאיפוס סיסמה',
  'user.2fa_reset': 'איפוס אימות דו-שלבי',
  'user.sessions_revoked': 'ניתוק כל ההתחברויות',
};

const FIELDS: Record<string, string> = {
  name: 'שם',
  email: 'אימייל',
  status: 'מצב',
  template: 'תבנית',
  extraPermissions: 'הרשאות שנוספו',
  removedPermissions: 'הרשאות שהוסרו',
};

/** Who changed what and when (ADM-11, decision 54). */
@Component({
  selector: 'hga-audit-page',
  imports: [DatePipe, MatButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>יומן שינויים</h1>
    <p class="page-intro">כל שינוי במשתמשים, בהרשאות ובהתחברויות. בהמשך גם מוצרים, מחירים ומלאי. נשמר שנתיים.</p>
    @if (error()) {
      <p class="form-error" role="alert">{{ error() }}</p>
    }
    @if (data(); as d) {
      <ul class="audit-list">
        @for (entry of d.items; track entry.id) {
          <li class="audit-item">
            <p class="audit-head">
              <strong>{{ actionLabel(entry.action) }}</strong>
              <span class="muted">{{ entry.createdAt | date: 'd.M.yyyy HH:mm' }}</span>
            </p>
            <p class="muted">
              {{ entry.actor ? 'על ידי ' + entry.actor.name : 'פעולת מערכת' }}
              @if (entry.entityId) {
                · {{ entry.entityType === 'admin_user' ? 'משתמש' : entry.entityType }}:
                {{ entry.entityLabel ?? '#' + entry.entityId }}
              }
            </p>
            @for (change of changes(entry); track change.field) {
              <p class="audit-change">
                {{ change.label }}: <span class="before">{{ change.before }}</span> ←
                <span class="after">{{ change.after }}</span>
              </p>
            }
          </li>
        } @empty {
          <li class="muted">עדיין אין רשומות.</li>
        }
      </ul>
      @if (d.total > d.pageSize) {
        <div class="pager">
          <button matButton="outlined" type="button" [disabled]="d.page === 1" (click)="go(d.page - 1)">הקודם</button>
          <span class="muted">עמוד {{ d.page }} מתוך {{ pages(d) }}</span>
          <button matButton="outlined" type="button" [disabled]="d.page >= pages(d)" (click)="go(d.page + 1)">
            הבא
          </button>
        </div>
      }
    }
  `,
  styles: `
    .audit-list {
      list-style: none;
      padding: 0;
      margin: 0;
      display: grid;
      gap: var(--space-2);
    }

    .audit-item {
      padding: var(--space-3) var(--space-4);
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      display: grid;
      gap: var(--space-1);
    }

    .audit-head {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: var(--space-2);
    }

    .muted {
      color: var(--color-text-secondary);
      font-size: var(--font-small);
    }

    .audit-change {
      font-size: var(--font-small);
    }

    .before {
      color: var(--color-text-secondary);
      text-decoration: line-through;
    }

    .pager {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-3);
      margin-block-start: var(--space-4);
    }
  `,
})
export class AuditPageComponent implements OnInit {
  private readonly api = inject(UsersApi);
  protected readonly data = signal<AuditPage | null>(null);
  protected readonly error = signal('');

  ngOnInit() {
    void this.go(1);
  }

  async go(page: number) {
    try {
      this.data.set(await this.api.audit(page));
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  actionLabel(action: string): string {
    return ACTIONS[action] ?? action;
  }

  pages(d: AuditPage): number {
    return Math.ceil(d.total / d.pageSize);
  }

  /** Fields that differ between before and after, for "user.update". */
  changes(entry: AuditEntry): { field: string; label: string; before: string; after: string }[] {
    const before = (entry.before ?? {}) as Record<string, unknown>;
    const after = (entry.after ?? {}) as Record<string, unknown>;
    if (!entry.before || !entry.after) return [];
    return Object.keys(FIELDS)
      .filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
      .map((field) => ({ field, label: FIELDS[field], before: show(before[field]), after: show(after[field]) }));
  }
}

function show(value: unknown): string {
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  return value == null || value === '' ? '—' : String(value);
}
