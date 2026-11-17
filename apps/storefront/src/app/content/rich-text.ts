import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Renders content HTML that the API already sanitized (`sanitizeContentHtml`). Angular's own sanitizer stays on:
 * nothing here ever bypasses it.
 */
@Component({
  selector: 'hg-rich-text',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[innerHTML]': 'html()' },
  template: '',
  styles: `
    :host {
      display: block;
    }

    :host ::ng-deep :is(p, ul, ol, h2, h3) {
      margin-block: 0 var(--space-3);
    }

    :host ::ng-deep :is(ul, ol) {
      padding-inline-start: var(--space-5);
    }

    :host ::ng-deep h2 {
      font-size: var(--font-h3);
      margin-block-start: var(--space-5);
    }

    :host ::ng-deep h3 {
      font-size: var(--font-body);
      margin-block-start: var(--space-4);
    }

    :host ::ng-deep a {
      color: inherit;
      text-decoration: underline;
    }
  `,
})
export class RichText {
  readonly html = input.required<string>();
}
