import { ChangeDetectionStrategy, Component, inject, input, model, signal } from '@angular/core';
import { HttpEventType } from '@angular/common/http';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { LucideCamera, LucideImagePlus } from '@lucide/angular';
import { CONTENT_IMAGE, type AdminContentImage } from '@hg/models';
import { CONTENT_IMAGE_PROBLEMS, errorMessage } from '../core/errors';
import { ContentApi } from './content.api';

/**
 * One content photo (banners, Phase 8b): drag a file, pick one, or take a photo with the phone camera; the photo is
 * uploaded at once (like product photos) and the field holds the stored photo. Shows a preview. A field that is not
 * `required` can be cleared. Refusals (type, size, too small) are shown in Hebrew under the field.
 */
@Component({
  selector: 'hga-content-image-field',
  imports: [MatButtonModule, MatProgressBarModule, LucideCamera, LucideImagePlus],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './content-image-field.scss',
  template: `
    <div class="field" [class.over]="dragOver()" [class.invalid]="!!error() || invalid()">
      <span class="label" [id]="id + '-label'">{{ label() }}{{ required() ? '' : ' (לא חובה)' }}</span>
      @if (value(); as current) {
        <img class="preview" [src]="current.image.url" alt="" />
      }
      <div
        class="drop"
        role="group"
        [attr.aria-labelledby]="id + '-label'"
        (dragover)="onDragOver($event)"
        (dragleave)="dragOver.set(false)"
        (drop)="onDrop($event)"
      >
        @if (!value()) {
          <svg lucideImagePlus aria-hidden="true"></svg>
          <p class="drag-note">גררו תמונה לכאן, או:</p>
        }
        <div class="pick">
          <button matButton="tonal" type="button" [disabled]="busy()" (click)="files.click()">
            {{ value() ? 'החלפת תמונה' : 'בחירת תמונה' }}
          </button>
          <button matButton="outlined" type="button" class="camera" [disabled]="busy()" (click)="camera.click()">
            <svg lucideCamera></svg>
            צילום
          </button>
          @if (value() && !required()) {
            <button matButton type="button" class="clear" [disabled]="busy()" (click)="clear()">הסרה</button>
          }
        </div>
        <input #files type="file" [accept]="accept" hidden (change)="onPick(files)" />
        <input #camera type="file" accept="image/*" capture="environment" hidden (change)="onPick(camera)" />
        <p class="hint">{{ hint() || defaultHint }}</p>
      </div>
      @if (busy()) {
        <mat-progress-bar
          [mode]="percent() < 100 ? 'determinate' : 'indeterminate'"
          [value]="percent()"
          aria-label="מעלה תמונה"
        ></mat-progress-bar>
      }
      @if (error() || errorText()) {
        <p class="error" role="alert">{{ error() || errorText() }}</p>
      }
    </div>
  `,
})
export class ContentImageField {
  readonly label = input.required<string>();
  readonly required = input(false);
  readonly hint = input('');
  /** An error from the form (e.g. "a photo is required"). */
  readonly errorText = input('');
  readonly invalid = input(false);
  /** The stored photo (id and preview), or null. */
  readonly value = model<AdminContentImage | null>(null);

  private readonly api = inject(ContentApi);
  private static nextId = 1;
  protected readonly id = `hga-content-image-${ContentImageField.nextId++}`;

  protected readonly accept = CONTENT_IMAGE.types.join(',');
  protected readonly defaultHint = `JPG, PNG או WebP, עד 15MB. לפחות ${CONTENT_IMAGE.minLongSide} פיקסלים בצד הארוך.`;
  protected readonly dragOver = signal(false);
  protected readonly busy = signal(false);
  protected readonly percent = signal(0);
  protected readonly error = signal('');

  protected onDragOver(event: DragEvent) {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    this.dragOver.set(true);
  }

  protected onDrop(event: DragEvent) {
    event.preventDefault();
    this.dragOver.set(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) void this.upload(file);
  }

  protected onPick(input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = '';
    if (file) void this.upload(file);
  }

  protected clear() {
    this.error.set('');
    this.value.set(null);
  }

  async upload(file: File) {
    if (this.busy()) return;
    this.error.set('');
    if (!CONTENT_IMAGE.types.includes(file.type as (typeof CONTENT_IMAGE.types)[number])) {
      this.error.set(CONTENT_IMAGE_PROBLEMS.type!);
      return;
    }
    if (file.size > CONTENT_IMAGE.maxBytes) {
      this.error.set(CONTENT_IMAGE_PROBLEMS.too_large!);
      return;
    }
    this.busy.set(true);
    this.percent.set(0);
    try {
      const stored = await new Promise<AdminContentImage>((resolve, reject) => {
        this.api.uploadImage(file).subscribe({
          next: (event) => {
            if (event.type === HttpEventType.UploadProgress && event.total)
              this.percent.set(Math.round((100 * event.loaded) / event.total));
            if (event.type === HttpEventType.Response) resolve(event.body!);
          },
          error: reject,
        });
      });
      this.value.set(stored);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
