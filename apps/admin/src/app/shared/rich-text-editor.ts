import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  afterNextRender,
  computed,
  input,
  model,
  signal,
  viewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import {
  LucideBold,
  LucideHeading,
  LucideHeading2,
  LucideHeading3,
  LucideItalic,
  LucideLink,
  LucideList,
  LucideListOrdered,
} from '@lucide/angular';

type Mark = 'bold' | 'italic' | 'heading' | 'h2' | 'h3' | 'bulletList' | 'orderedList' | 'link';

/**
 * `description`: product description (h3 only, https / mailto links, as before). `page`: info pages (h2 and h3).
 * `inline`: short texts such as FAQ answers (no headings). `page` and `inline` links follow the server rule.
 */
export type EditorMode = 'description' | 'page' | 'inline';

const SITE_PATH = /^\/(?![/\\])/;
const HTTPS_LINK = /^https:\/\/[^/?#\\@\s]+(?:[/?#]|$)/i;
const MAILTO_LINK = /^mailto:[^/\\]/i;
const TEL_LINK = /^tel:\+?[0-9][0-9-]*$/i;

/** Whether the editor accepts this link address. Content modes mirror the API: https, mailto, tel or a `/path`. */
export function linkAllowed(url: string, mode: EditorMode): boolean {
  if (mode === 'description') return /^(https?:\/\/|mailto:)/i.test(url);
  // oxlint-disable-next-line no-control-regex -- control characters are exactly what is refused here.
  if (!url || /[\s\\\u0000-\u001f\u007f]/.test(url)) return false;
  return HTTPS_LINK.test(url) || MAILTO_LINK.test(url) || TEL_LINK.test(url) || SITE_PATH.test(url);
}

/** The toolbar buttons of a mode, in order. */
export function editorButtons(mode: EditorMode): { mark: Mark; label: string }[] {
  const heading: { mark: Mark; label: string }[] =
    mode === 'page'
      ? [
          { mark: 'h2', label: 'כותרת' },
          { mark: 'h3', label: 'כותרת משנה' },
        ]
      : mode === 'description'
        ? [{ mark: 'heading', label: 'כותרת' }]
        : [];
  return [
    ...heading,
    { mark: 'bold', label: 'מודגש' },
    { mark: 'italic', label: 'נטוי' },
    { mark: 'bulletList', label: 'רשימה' },
    { mark: 'orderedList', label: 'רשימה ממוספרת' },
    { mark: 'link', label: 'קישור' },
  ];
}

/**
 * Rich-text editor (decision 56, 99; modes above). Description mode: heading, bold, italic, lists and links only — no colors
 * or font sizes, so every product page follows the brand. The API sanitizes the HTML again.
 */
@Component({
  selector: 'hga-rich-text-editor',
  imports: [
    MatButtonModule,
    LucideBold,
    LucideHeading,
    LucideHeading2,
    LucideHeading3,
    LucideItalic,
    LucideLink,
    LucideList,
    LucideListOrdered,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rte" [class.focused]="focused()">
      <span class="rte-label" [id]="labelId">{{ label() }}</span>
      <div class="rte-toolbar" role="toolbar" [attr.aria-label]="'עיצוב ' + label()">
        @for (b of buttons(); track b.mark) {
          <button
            matIconButton
            type="button"
            [attr.aria-label]="b.label"
            [attr.aria-pressed]="active().has(b.mark)"
            [class.on]="active().has(b.mark)"
            (click)="apply(b.mark)"
          >
            @switch (b.mark) {
              @case ('heading') {
                <svg lucideHeading></svg>
              }
              @case ('h2') {
                <svg lucideHeading2></svg>
              }
              @case ('h3') {
                <svg lucideHeading3></svg>
              }
              @case ('bold') {
                <svg lucideBold></svg>
              }
              @case ('italic') {
                <svg lucideItalic></svg>
              }
              @case ('bulletList') {
                <svg lucideList></svg>
              }
              @case ('orderedList') {
                <svg lucideListOrdered></svg>
              }
              @case ('link') {
                <svg lucideLink></svg>
              }
            }
          </button>
        }
      </div>
      <div #host class="rte-body"></div>
    </div>
  `,
  styles: `
    .rte {
      border: var(--border-width) solid var(--color-border-strong);
      border-radius: var(--radius-sm);
      background: var(--color-surface);
    }

    .rte.focused {
      border-color: var(--color-accent);
      box-shadow: 0 0 0 1px var(--color-accent);
    }

    .rte-label {
      display: block;
      padding: var(--space-2) var(--space-3) 0;
      font-size: var(--font-caption);
      color: var(--color-text-secondary);
    }

    .rte-toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-1);
      padding: var(--space-1) var(--space-2);
      border-block-end: var(--border-width) solid var(--color-border);
    }

    .rte-toolbar svg {
      inline-size: var(--icon-size-md);
      block-size: var(--icon-size-md);
    }

    .rte-toolbar .on {
      background: var(--color-accent-soft);
      color: var(--color-on-accent-soft);
    }

    .rte-body ::ng-deep .ProseMirror {
      min-block-size: 140px;
      padding: var(--space-3);
      outline: none;
      line-height: 1.6;
    }

    .rte-body ::ng-deep .ProseMirror p,
    .rte-body ::ng-deep .ProseMirror ul,
    .rte-body ::ng-deep .ProseMirror ol {
      margin-block: 0 var(--space-2);
    }

    .rte-body ::ng-deep .ProseMirror h2 {
      font-size: var(--font-h2);
      margin-block: var(--space-2);
    }

    .rte-body ::ng-deep .ProseMirror h3 {
      font-size: var(--font-h3);
      margin-block: var(--space-2);
    }

    .rte-body ::ng-deep .ProseMirror a {
      color: var(--color-accent);
    }
  `,
})
export class RichTextEditor implements OnDestroy {
  readonly label = input('תיאור');
  readonly value = model('');
  readonly mode = input<EditorMode>('description');
  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  protected readonly labelId = `rte-${Math.random().toString(36).slice(2, 8)}`;
  protected readonly focused = signal(false);
  protected readonly active = signal(new Set<Mark>());
  protected readonly buttons = computed(() => editorButtons(this.mode()));
  private editor?: Editor;

  constructor() {
    afterNextRender(() => {
      this.editor = new Editor({
        element: this.host().nativeElement,
        content: this.value(),
        extensions: [
          StarterKit.configure({
            heading: this.mode() === 'inline' ? false : { levels: this.mode() === 'page' ? [2, 3] : [3] },
            blockquote: false,
            code: false,
            codeBlock: false,
            horizontalRule: false,
            strike: false,
            underline: false,
            link: {
              openOnClick: false,
              autolink: this.mode() === 'description',
              protocols: this.mode() === 'description' ? ['mailto'] : ['mailto', 'tel'],
            },
          }),
        ],
        editorProps: {
          attributes: { dir: 'rtl', 'aria-multiline': 'true', role: 'textbox', 'aria-labelledby': this.labelId },
        },
        onUpdate: ({ editor }) => this.value.set(editor.isEmpty ? '' : editor.getHTML()),
        onTransaction: () => this.refreshState(),
        onFocus: () => this.focused.set(true),
        onBlur: () => this.focused.set(false),
      });
    });
  }

  /** Replaces the content, e.g. after the product was reloaded. */
  setContent(html: string) {
    this.editor?.commands.setContent(html, { emitUpdate: false });
  }

  protected apply(mark: Mark) {
    const chain = this.editor?.chain().focus();
    if (!chain) return;
    switch (mark) {
      case 'heading':
        chain.toggleHeading({ level: 3 }).run();
        break;
      case 'h2':
        chain.toggleHeading({ level: 2 }).run();
        break;
      case 'h3':
        chain.toggleHeading({ level: 3 }).run();
        break;
      case 'bold':
        chain.toggleBold().run();
        break;
      case 'italic':
        chain.toggleItalic().run();
        break;
      case 'bulletList':
        chain.toggleBulletList().run();
        break;
      case 'orderedList':
        chain.toggleOrderedList().run();
        break;
      case 'link': {
        if (this.editor!.isActive('link')) {
          chain.unsetLink().run();
          break;
        }
        const url = prompt(
          this.mode() === 'description'
            ? 'כתובת הקישור (מתחילה ב-https://)'
            : 'כתובת הקישור (https://, mailto:, tel: או כתובת באתר שמתחילה ב-/)',
          'https://',
        );
        const href = url !== null && this.mode() !== 'description' ? url.trim() : url;
        if (href && linkAllowed(href, this.mode())) chain.setLink({ href }).run();
        break;
      }
    }
  }

  private refreshState() {
    const editor = this.editor;
    if (!editor) return;
    const on = new Set<Mark>();
    if (editor.isActive('heading', { level: 3 })) on.add(this.mode() === 'page' ? 'h3' : 'heading');
    if (editor.isActive('heading', { level: 2 })) on.add('h2');
    for (const mark of ['bold', 'italic', 'bulletList', 'orderedList', 'link'] as const) {
      if (editor.isActive(mark)) on.add(mark);
    }
    this.active.set(on);
  }

  ngOnDestroy() {
    this.editor?.destroy();
  }
}
