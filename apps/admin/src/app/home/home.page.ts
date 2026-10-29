import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { PERMISSIONS } from '@hg/models';
import { AuthService } from '../core/auth.service';

@Component({
  selector: 'hga-home-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>שלום, {{ auth.me()?.name }}</h1>
    <p class="page-intro">ניהול הקטלוג, התמונות והייבוא יתווספו בשלבים הבאים.</p>
    <section class="panel">
      <h2>ההרשאות שלכם</h2>
      @if (auth.isSuperAdmin()) {
        <p>אתם ה-Super Admin: יש לכם את כל ההרשאות, ורק אתם מנהלים משתמשים והרשאות.</p>
      }
      <ul class="permission-list">
        @for (p of permissions(); track p.key) {
          <li>{{ p.labelHe }}</li>
        } @empty {
          <li>אין הרשאות. פנו ל-Super Admin.</li>
        }
      </ul>
    </section>
  `,
})
export class HomePage {
  protected readonly auth = inject(AuthService);
  protected readonly permissions = computed(() => {
    const mine = new Set<string>(this.auth.me()?.permissions ?? []);
    return PERMISSIONS.filter((p) => mine.has(p.key));
  });
}
