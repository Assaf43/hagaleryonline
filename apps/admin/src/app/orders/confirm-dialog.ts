import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';

export interface ConfirmDialogData {
  message: string;
}

/** A yes / no question before a step that cannot be undone; closes with `true` only on "אישור". */
@Component({
  selector: 'hga-confirm-dialog',
  imports: [MatButtonModule, MatDialogModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <mat-dialog-content>
      <p class="confirm-message">{{ data.message }}</p>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton type="button" class="confirm-no" [mat-dialog-close]="false" cdkFocusInitial>ביטול</button>
      <button matButton="filled" type="button" class="confirm-yes" [mat-dialog-close]="true">אישור</button>
    </mat-dialog-actions>
  `,
})
export class ConfirmDialog {
  protected readonly data = inject<ConfirmDialogData>(MAT_DIALOG_DATA);
}
