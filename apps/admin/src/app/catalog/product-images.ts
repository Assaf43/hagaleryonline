import { ChangeDetectionStrategy, Component, computed, inject, input, model, signal } from '@angular/core';
import { HttpEventType } from '@angular/common/http';
import { CdkDrag, CdkDragHandle, CdkDropList, type CdkDragDrop, moveItemInArray } from '@angular/cdk/drag-drop';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import {
  LucideCamera,
  LucideChevronLeft,
  LucideChevronRight,
  LucideGripVertical,
  LucideImagePlus,
  LucideTrash2,
} from '@lucide/angular';
import {
  IMAGE_KIND_LABELS_HE,
  IMAGE_UPLOAD,
  type AdminImage,
  type AdminImageInput,
  type ImageKindCode,
} from '@hg/models';
import { CatalogApi } from '../core/catalog.api';
import { IMAGE_PROBLEMS, errorMessage } from '../core/errors';

export interface ColorOption {
  code: string;
  labelHe: string;
  hex: string | null;
  /** One of the product's variants has this color. */
  used: boolean;
}

interface Upload {
  key: number;
  name: string;
  percent: number;
  error: string;
}

let nextUpload = 1;

/**
 * Product photos (Phase 2d, ADM-04): drag-and-drop or camera upload, order (drag, or the arrow
 * buttons for keyboard users), color, type, alt text and delete. Every change is saved at once —
 * photos are not part of the product's "save" button.
 */
@Component({
  selector: 'hga-product-images',
  imports: [
    CdkDropList,
    CdkDrag,
    CdkDragHandle,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressBarModule,
    MatSelectModule,
    LucideCamera,
    LucideChevronLeft,
    LucideChevronRight,
    LucideGripVertical,
    LucideImagePlus,
    LucideTrash2,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './product-images.html',
  styleUrl: './product-images.scss',
})
export class ProductImages {
  readonly productId = input.required<number>();
  readonly productActive = input(false);
  readonly colors = input<ColorOption[]>([]);
  readonly canEdit = input(false);
  /** The photos, kept in sync with the server; the parent reads the count. */
  readonly images = model<AdminImage[]>([]);

  private readonly api = inject(CatalogApi);
  private readonly snack = inject(MatSnackBar);

  protected readonly kinds = Object.entries(IMAGE_KIND_LABELS_HE) as [ImageKindCode, string][];
  protected readonly accept = IMAGE_UPLOAD.types.join(',');
  protected readonly uploads = signal<Upload[]>([]);
  protected readonly dragOver = signal(false);
  protected readonly busy = signal(false);
  /** Color and type given to the next uploads. */
  protected readonly uploadColor = signal<string | null>(null);
  protected readonly uploadKind = signal<ImageKindCode>('cutout');

  protected readonly sortedColors = computed(() => [
    ...this.colors().filter((c) => c.used),
    ...this.colors().filter((c) => !c.used),
  ]);
  /** Colors of the product that have no photo of their own yet. */
  protected readonly colorsWithoutPhotos = computed(() =>
    this.colors().filter((c) => c.used && !this.images().some((i) => i.colorCode === c.code)),
  );

  protected colorLabel(code: string | null): string {
    return code === null ? 'כל הצבעים' : (this.colors().find((c) => c.code === code)?.labelHe ?? code);
  }

  // ---------- Upload ----------

  protected onDragOver(event: DragEvent) {
    if (!this.canEdit() || !event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    this.dragOver.set(true);
  }

  protected onDrop(event: DragEvent) {
    if (!this.canEdit()) return;
    event.preventDefault();
    this.dragOver.set(false);
    this.uploadFiles([...(event.dataTransfer?.files ?? [])]);
  }

  protected onPick(input: HTMLInputElement) {
    this.uploadFiles([...(input.files ?? [])]);
    input.value = '';
  }

  /** One at a time, so a phone on a slow line is not flooded and the order stays as picked. */
  private async uploadFiles(files: File[]) {
    const queue = files.map((file) => ({
      file,
      upload: { key: nextUpload++, name: file.name, percent: 0, error: '' },
    }));
    this.uploads.update((list) => [...list, ...queue.map((q) => q.upload)]);
    for (const { file, upload } of queue) {
      const problem = !IMAGE_UPLOAD.types.includes(file.type as (typeof IMAGE_UPLOAD.types)[number])
        ? IMAGE_PROBLEMS.type
        : file.size > IMAGE_UPLOAD.maxBytes
          ? IMAGE_PROBLEMS.too_large
          : '';
      if (problem) {
        this.setUpload(upload.key, { error: problem });
        continue;
      }
      try {
        const image = await this.send(file, upload.key);
        this.images.update((list) => [...list, image]);
        this.uploads.update((list) => list.filter((u) => u.key !== upload.key));
      } catch (e) {
        this.setUpload(upload.key, { error: errorMessage(e) });
      }
    }
  }

  private send(file: File, key: number): Promise<AdminImage> {
    return new Promise((resolve, reject) => {
      this.api
        .uploadImage(this.productId(), file, { colorCode: this.uploadColor(), kind: this.uploadKind() })
        .subscribe({
          next: (event) => {
            if (event.type === HttpEventType.UploadProgress && event.total)
              this.setUpload(key, { percent: Math.round((100 * event.loaded) / event.total) });
            if (event.type === HttpEventType.Response) resolve(event.body!);
          },
          error: reject,
        });
    });
  }

  private setUpload(key: number, change: Partial<Upload>) {
    this.uploads.update((list) => list.map((u) => (u.key === key ? { ...u, ...change } : u)));
  }

  protected dismiss(key: number) {
    this.uploads.update((list) => list.filter((u) => u.key !== key));
  }

  // ---------- Order ----------

  protected drop(event: CdkDragDrop<AdminImage[]>) {
    if (event.previousIndex !== event.currentIndex) this.move(event.previousIndex, event.currentIndex);
  }

  /** Arrow buttons: in RTL, "earlier" is to the right. */
  protected move(from: number, to: number) {
    const before = this.images();
    if (to < 0 || to >= before.length) return;
    const after = [...before];
    moveItemInArray(after, from, to);
    this.images.set(after);
    this.run(
      async () =>
        this.images.set(
          await this.api.reorderImages(
            this.productId(),
            after.map((i) => i.id),
          ),
        ),
      () => this.images.set(before),
    );
  }

  // ---------- Edit and delete ----------

  protected update(image: AdminImage, change: Partial<AdminImageInput>) {
    const input: AdminImageInput = { colorCode: image.colorCode, kind: image.kind, altHe: image.altHe, ...change };
    if (!input.altHe.trim()) {
      this.snack.open('צריך תיאור לתמונה (לקוראי מסך).', undefined, { duration: 4000 });
      this.images.update((list) => [...list]);
      return;
    }
    this.run(async () => {
      const saved = await this.api.updateImage(this.productId(), image.id, input);
      this.images.update((list) => list.map((i) => (i.id === saved.id ? saved : i)));
    });
  }

  protected remove(image: AdminImage) {
    if (this.productActive() && this.images().length === 1) {
      this.snack.open('זו התמונה האחרונה של מוצר שמוצג באתר. הסתירו את המוצר קודם, או העלו תמונה אחרת.', 'הבנתי', {
        duration: 8000,
      });
      return;
    }
    if (!confirm('למחוק את התמונה? אי אפשר לבטל.')) return;
    this.run(async () => {
      await this.api.deleteImage(this.productId(), image.id);
      this.images.update((list) => list.filter((i) => i.id !== image.id));
      this.snack.open('התמונה נמחקה.', undefined, { duration: 3000 });
    });
  }

  private async run(action: () => Promise<void>, undo?: () => void) {
    this.busy.set(true);
    try {
      await action();
    } catch (e) {
      undo?.();
      this.snack.open(errorMessage(e), 'סגירה', { duration: 8000 });
    } finally {
      this.busy.set(false);
    }
  }
}
