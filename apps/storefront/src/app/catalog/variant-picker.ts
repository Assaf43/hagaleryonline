import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { OptionAxis, VariantDetail } from '@hg/models';
import type { OptionState } from './variant-selection';

/** Variant choice (PRD-04): swatches for colors, buttons for the rest, a diagram for the chaise side. */
@Component({
  selector: 'hg-variant-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (axis of axes(); track axis.code) {
      @let selected = current().options[axis.code];
      @let isColor = hasHex(axis);
      @let isSide = axis.code === 'chaise-side';
      <div class="axis">
        <p class="axis-label" [id]="'axis-' + axis.code">
          {{ axis.nameHe }}
          @if (isColor) {
            <span class="chosen">{{ labelOf(axis, selected) }}</span>
          }
        </p>
        @if (isSide) {
          <p class="hint">למסתכלים מול הספה</p>
        }
        <div class="options" role="radiogroup" [attr.aria-labelledby]="'axis-' + axis.code">
          @for (value of axis.values; track value.code; let first = $first) {
            @let isSelected = value.code === selected;
            @let unavailable = states()[axis.code]?.[value.code] === 'unavailable';
            <button
              type="button"
              role="radio"
              class="option"
              [class.color]="isColor"
              [class.side]="isSide"
              [class.selected]="isSelected"
              [class.unavailable]="unavailable"
              [attr.aria-checked]="isSelected"
              [attr.aria-label]="isColor ? value.labelHe + (unavailable ? ' (לא זמין)' : '') : null"
              [attr.title]="isColor ? value.labelHe : null"
              [tabindex]="isSelected || (first && !hasSelection(axis, selected)) ? 0 : -1"
              (click)="picked.emit({ axis: axis.code, value: value.code })"
              (keydown)="onKey($event, axis, value.code)"
            >
              @if (isColor) {
                <span class="swatch" [style.background]="value.hex"></span>
              } @else {
                @if (isSide) {
                  <svg class="diagram" viewBox="0 0 48 32" aria-hidden="true">
                    <rect x="2" y="2" width="44" height="16" rx="3" class="body" />
                    @if (value.code !== 'left') {
                      <rect
                        x="30"
                        y="18"
                        width="16"
                        height="12"
                        rx="3"
                        class="body"
                        [class.dashed]="value.code !== 'right'"
                      />
                    }
                    @if (value.code !== 'right') {
                      <rect
                        x="2"
                        y="18"
                        width="16"
                        height="12"
                        rx="3"
                        class="body"
                        [class.dashed]="value.code !== 'left'"
                      />
                    }
                  </svg>
                }
                <span class="text" [class.struck]="unavailable">{{ value.labelHe }}</span>
                @if (unavailable) {
                  <span class="visually-hidden"> (לא זמין)</span>
                }
              }
            </button>
          }
        </div>
      </div>
    }
    <p class="notice" [class.empty]="!notice()" aria-live="polite">{{ notice() }}</p>
  `,
  styles: `
    :host {
      display: block;
    }

    .axis {
      margin-block-end: var(--space-4);
    }

    .axis-label {
      margin: 0 0 var(--space-2);
      font-weight: 600;
    }

    .chosen {
      font-weight: 400;
      color: var(--color-text-secondary);
      margin-inline-start: var(--space-2);
    }

    .hint {
      margin: 0 0 var(--space-2);
      font-size: var(--font-caption);
      color: var(--color-text-secondary);
    }

    .options {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }

    .option {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-2);
      min-block-size: var(--icon-button-size);
      min-inline-size: var(--icon-button-size);
      padding-inline: var(--space-4);
      font: inherit;
      color: var(--color-text);
      background: transparent;
      border: var(--border-width) solid var(--color-border-strong);
      border-radius: var(--radius-md);
      cursor: pointer;
    }

    .option:hover {
      background: var(--color-surface-alt);
    }

    .option.selected {
      border: var(--border-width-strong) solid var(--color-text);
      padding-inline: calc(var(--space-4) - 1px);
    }

    .option.color {
      padding: 0;
      border-radius: var(--radius-pill);
      border-color: transparent;
    }

    .option.color.selected {
      border-color: var(--color-text);
      padding: 0;
    }

    .option.color .swatch {
      inline-size: 32px;
      block-size: 32px;
    }

    .option.color .swatch {
      position: relative;
    }

    /* Struck through: a diagonal line over the color, still selectable. */
    .option.color.unavailable .swatch::after {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: inherit;
      background: linear-gradient(
        135deg,
        transparent calc(50% - 1px),
        var(--color-text) calc(50% - 1px),
        var(--color-text) calc(50% + 1px),
        transparent calc(50% + 1px)
      );
    }

    .option.side {
      flex-direction: column;
      gap: var(--space-1);
      padding-block: var(--space-2);
    }

    .struck {
      text-decoration: line-through;
      color: var(--color-text-secondary);
    }

    .diagram {
      inline-size: 48px;
      block-size: 32px;
    }

    .body {
      fill: var(--color-surface-alt);
      stroke: currentcolor;
      stroke-width: 1.5;
    }

    .body.dashed {
      stroke-dasharray: 3 2;
      fill: none;
    }

    .notice {
      margin: 0;
      padding: var(--space-3) var(--space-4);
      background: var(--color-info-soft);
      border-radius: var(--radius-md);
      font-size: var(--font-small);
    }

    .notice.empty {
      padding: 0;
      background: none;
    }
  `,
})
export class VariantPicker {
  readonly axes = input.required<readonly OptionAxis[]>();
  readonly current = input.required<VariantDetail>();
  readonly states = input.required<Record<string, Record<string, OptionState>>>();
  readonly notice = input<string | null>(null);
  readonly picked = output<{ axis: string; value: string }>();

  protected hasHex(axis: OptionAxis): boolean {
    return axis.values.some((v) => v.hex);
  }

  protected hasSelection(axis: OptionAxis, selected: string | undefined): boolean {
    return axis.values.some((v) => v.code === selected);
  }

  protected labelOf(axis: OptionAxis, code: string | undefined): string {
    return axis.values.find((v) => v.code === code)?.labelHe ?? '';
  }

  /** Radio-group keys: arrows move the choice along the reading direction (mirrored in RTL). */
  protected onKey(event: KeyboardEvent, axis: OptionAxis, current: string): void {
    const target = event.currentTarget as HTMLElement;
    const rtl = getComputedStyle(target).direction === 'rtl';
    let step = 0;
    if (event.key === 'ArrowDown') step = 1;
    else if (event.key === 'ArrowUp') step = -1;
    else if (event.key === 'ArrowRight') step = rtl ? -1 : 1;
    else if (event.key === 'ArrowLeft') step = rtl ? 1 : -1;
    if (!step) return;
    event.preventDefault();
    const index = axis.values.findIndex((v) => v.code === current);
    const next = axis.values[(index + step + axis.values.length) % axis.values.length];
    const buttons = Array.from(target.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]') ?? []);
    this.picked.emit({ axis: axis.code, value: next.code });
    buttons[axis.values.indexOf(next)]?.focus();
  }
}
