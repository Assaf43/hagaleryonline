import { describe, expect, it } from 'vitest';
import { findViolations } from './check-inline-styles.mjs';

describe('findViolations', () => {
  it('flags a hex color in styles', () => {
    const v = findViolations('styles: `a { color: #fff; }`');
    expect(v).toHaveLength(1);
    expect(v[0].line).toBe(1);
  });

  it('flags rgb()', () => {
    expect(findViolations('styles: `a { box-shadow: 0 0 0 1px rgb(0 0 0 / 10%); }`')).toHaveLength(1);
  });

  it('flags a named color on a color property', () => {
    expect(findViolations('styles: `a { color: red; }`')).toHaveLength(1);
  });

  it('flags a primitive token', () => {
    expect(findViolations('styles: `a { color: var(--gray-500); }`')).toHaveLength(1);
  });

  it('flags black-a primitives', () => {
    expect(findViolations('styles: `a { color: var(--black-a45); }`')).toHaveLength(1);
  });

  it('allows semantic and component tokens', () => {
    expect(
      findViolations(
        'styles: `a { color: var(--color-text); block-size: var(--control-height); font-size: var(--font-small); padding: var(--space-4); border-radius: var(--radius-md); }`',
      ),
    ).toHaveLength(0);
  });

  it('works with an array of literals', () => {
    expect(findViolations('styles: [`a { color: #fff; }`]')).toHaveLength(1);
  });

  it('ignores templates', () => {
    expect(findViolations('template: `<a href="#main"><svg fill="#000"></svg></a>`, styles: `a{}`')).toHaveLength(0);
  });

  it('reports the right line in a multi-line styles block', () => {
    const src = ['@Component({', '  styles: `', '    a {', '      color: #fff;', '    }', '  `,', '})'].join('\n');
    const v = findViolations(src);
    expect(v).toHaveLength(1);
    expect(v[0].line).toBe(4);
  });
});
