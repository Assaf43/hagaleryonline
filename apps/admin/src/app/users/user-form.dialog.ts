import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import {
  PERMISSIONS,
  PERMISSION_TEMPLATES,
  type AdminUserRow,
  type OneTimeLink,
  type Permission,
  type PermissionTemplate,
} from '@hg/models';
import { errorMessage } from '../core/errors';
import { UsersApi } from '../core/users.api';

export type UserFormResult = { user: AdminUserRow; invite?: OneTimeLink };

/**
 * Create or edit a user (decision 49): pick a template, then tick or untick single permissions.
 * Differences from the template are saved as added / removed permissions.
 */
@Component({
  selector: 'hga-user-form-dialog',
  imports: [
    FormsModule,
    MatButtonModule,
    MatCheckboxModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>{{ editing ? 'עריכת ' + editing.name : 'משתמש חדש' }}</h2>
    <form (ngSubmit)="save()">
      <mat-dialog-content class="dialog-form">
        <mat-form-field>
          <mat-label>שם</mat-label>
          <input matInput name="name" [(ngModel)]="name" required maxlength="100" />
        </mat-form-field>
        @if (!editing) {
          <mat-form-field>
            <mat-label>אימייל</mat-label>
            <input matInput type="email" name="email" [(ngModel)]="email" required dir="ltr" />
          </mat-form-field>
        }
        <mat-form-field>
          <mat-label>תבנית הרשאות</mat-label>
          <mat-select name="template" [ngModel]="template()" (ngModelChange)="useTemplate($event)">
            @for (t of templates; track t.code) {
              <mat-option [value]="t.code">{{ t.labelHe }}</mat-option>
            }
          </mat-select>
        </mat-form-field>

        <fieldset class="permissions">
          <legend>הרשאות</legend>
          @for (p of permissions; track p.key) {
            <mat-checkbox [checked]="checked().has(p.key)" (change)="toggle(p.key, $event.checked)">
              {{ p.labelHe }}
              @if (differs(p.key)) {
                <span class="custom-mark">(שונה מהתבנית)</span>
              }
            </mat-checkbox>
          }
        </fieldset>
        @if (error()) {
          <p class="form-error" role="alert">{{ error() }}</p>
        }
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button matButton type="button" mat-dialog-close>ביטול</button>
        <button matButton="filled" type="submit" [disabled]="busy() || !name.trim() || (!editing && !email.trim())">
          {{ editing ? 'שמירה' : 'יצירה וקבלת קישור הזמנה' }}
        </button>
      </mat-dialog-actions>
    </form>
  `,
})
export class UserFormDialog {
  private readonly api = inject(UsersApi);
  private readonly ref = inject(MatDialogRef<UserFormDialog, UserFormResult>);
  protected readonly editing = inject<AdminUserRow | null>(MAT_DIALOG_DATA);
  protected readonly templates = PERMISSION_TEMPLATES;
  protected readonly permissions = PERMISSIONS;

  protected name = this.editing?.name ?? '';
  protected email = '';
  protected readonly template = signal<PermissionTemplate>(this.editing?.template ?? 'content_editor');
  protected readonly checked = signal(
    new Set<Permission>(this.editing?.permissions ?? this.templatePermissions('content_editor')),
  );
  private readonly fromTemplate = computed(() => new Set<Permission>(this.templatePermissions(this.template())));
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  useTemplate(code: PermissionTemplate) {
    this.template.set(code);
    this.checked.set(new Set(this.templatePermissions(code)));
  }

  toggle(permission: Permission, on: boolean) {
    const next = new Set(this.checked());
    if (on) next.add(permission);
    else next.delete(permission);
    this.checked.set(next);
  }

  differs(permission: Permission): boolean {
    return this.checked().has(permission) !== this.fromTemplate().has(permission);
  }

  async save() {
    const base = this.fromTemplate();
    const chosen = this.checked();
    const extraPermissions = [...chosen].filter((p) => !base.has(p));
    const removedPermissions = [...base].filter((p) => !chosen.has(p));
    this.busy.set(true);
    this.error.set('');
    try {
      if (this.editing) {
        const user = await this.api.update(this.editing.id, {
          name: this.name,
          template: this.template(),
          extraPermissions,
          removedPermissions,
        });
        this.ref.close({ user });
      } else {
        this.ref.close(
          await this.api.create({
            name: this.name,
            email: this.email,
            template: this.template(),
            extraPermissions,
            removedPermissions,
          }),
        );
      }
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  private templatePermissions(code: PermissionTemplate): Permission[] {
    return [...(PERMISSION_TEMPLATES.find((t) => t.code === code)?.permissions ?? [])];
  }
}
