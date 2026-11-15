import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { SUPPORT_LIMITS } from '@hg/models';

const MB = 1024 * 1024;
const L = SUPPORT_LIMITS;

export const PHOTO_TOO_MANY_HE = `אפשר לצרף עד ${L.photosMax} תמונות`;
export const photoTooBigHe = (name: string) => `התמונה ${name} גדולה מדי (עד ${L.photoMaxBytes / MB}MB)`;
export const photoBadTypeHe = (name: string) => `הקובץ ${name} אינו תמונה מסוג JPEG, PNG או WebP`;

/**
 * The client-side check of added photos (the server stays the authority): type first, then size, then the count.
 * Returns what may be added and the first problem found (`''` when all were accepted).
 */
export function checkPhotos(current: readonly File[], added: readonly File[]): { accepted: File[]; problem: string } {
  const accepted: File[] = [];
  let problem = '';
  for (const file of added) {
    if (!(L.photoTypes as readonly string[]).includes(file.type)) {
      problem ||= photoBadTypeHe(file.name);
    } else if (file.size > L.photoMaxBytes) {
      problem ||= photoTooBigHe(file.name);
    } else if (current.length + accepted.length >= L.photosMax) {
      problem ||= PHOTO_TOO_MANY_HE;
    } else {
      accepted.push(file);
    }
  }
  return { accepted, problem };
}

interface Picked {
  file: File;
  url: string;
}

/**
 * Photo picker of the damaged-product form (SRV-03): up to 5 JPEG, PNG or WebP photos of up to 10 MB, checked before
 * anything is uploaded, with a preview and a remove button (named by the file) for each. `accept="image/*"` lets a
 * phone offer its camera. Previews are object URLs, revoked on removal and when the picker is destroyed.
 */
@Component({
  selector: 'hg-photo-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="picker">
      <label class="field-label" [for]="inputId()">תמונות של הנזק</label>
      <p class="hint" [id]="inputId() + '-hint'">
        עד {{ max }} תמונות מסוג JPEG, PNG או WebP, עד {{ maxMb }}MB כל אחת.
      </p>
      <input
        #file
        class="input file"
        type="file"
        accept="image/*"
        multiple
        [id]="inputId()"
        [attr.aria-invalid]="message() ? true : null"
        [attr.aria-describedby]="inputId() + '-hint' + (message() ? ' ' + inputId() + '-error' : '')"
        (change)="add($event)"
      />
      <!-- The alert region stays rendered while empty, so a message put in it is announced. -->
      <p class="field-error" role="alert" [id]="inputId() + '-error'">{{ message() }}</p>
      @if (picked().length) {
        <ul class="previews">
          @for (p of picked(); track p.url) {
            <li class="preview">
              <img [src]="p.url" alt="" />
              <span class="name" dir="ltr">{{ p.file.name }}</span>
              <button type="button" class="btn btn-secondary" (click)="remove(p)">
                הסרה<span class="visually-hidden"> של התמונה {{ p.file.name }}</span>
              </button>
            </li>
          }
        </ul>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
    }

    .picker {
      display: grid;
      gap: var(--space-2);
      align-content: start;
    }

    .hint {
      margin: 0;
      color: var(--color-text-secondary);
      font-size: var(--font-small);
    }

    .field-error {
      margin: 0;
      color: var(--color-danger);
      font-size: var(--font-small);
    }

    .file {
      block-size: auto;
      padding-block: var(--space-2);
    }

    .previews {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: var(--space-3);
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    }

    .preview {
      display: grid;
      gap: var(--space-2);
      justify-items: start;
    }

    img {
      inline-size: 100%;
      aspect-ratio: 4 / 3;
      object-fit: cover;
      border-radius: var(--radius-md);
      border: var(--border-width) solid var(--color-border);
    }

    .name {
      max-inline-size: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: var(--font-small);
      color: var(--color-text-secondary);
    }

    .visually-hidden {
      position: absolute;
      inline-size: 1px;
      block-size: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
  `,
})
export class PhotoPicker {
  readonly inputId = input('dm-photos');
  /** A message from the form (e.g. "add at least one photo" or the server's); shown with the picker's own. */
  readonly error = input('');
  /** The chosen photos, after every change. */
  readonly photosChange = output<File[]>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly picked = signal<Picked[]>([]);
  protected readonly problem = signal('');
  protected readonly message = computed(() => this.problem() || this.error());
  protected readonly max = L.photosMax;
  protected readonly maxMb = L.photoMaxBytes / MB;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.picked().forEach((p) => URL.revokeObjectURL(p.url)));
  }

  protected add(event: Event): void {
    const input = event.target as HTMLInputElement;
    const added = Array.from(input.files ?? []);
    input.value = '';
    const { accepted, problem } = checkPhotos(
      this.picked().map((p) => p.file),
      added,
    );
    this.problem.set(problem);
    if (!accepted.length) return;
    this.picked.update((list) => [...list, ...accepted.map((file) => ({ file, url: URL.createObjectURL(file) }))]);
    this.emit();
  }

  protected remove(p: Picked): void {
    URL.revokeObjectURL(p.url);
    this.picked.update((list) => list.filter((x) => x !== p));
    this.problem.set('');
    this.emit();
    this.host.nativeElement.querySelector<HTMLElement>(`#${this.inputId()}`)?.focus();
  }

  private emit(): void {
    this.photosChange.emit(this.picked().map((p) => p.file));
  }
}
