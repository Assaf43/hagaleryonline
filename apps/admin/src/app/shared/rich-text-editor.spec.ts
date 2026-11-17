import { TestBed } from '@angular/core/testing';
import { RichTextEditor, editorButtons, linkAllowed } from './rich-text-editor';

const labels = (mode: 'description' | 'page' | 'inline') => editorButtons(mode).map((b) => b.label);

describe('rich text editor modes', () => {
  it('description keeps one heading button, as the product form had', () => {
    expect(labels('description')).toEqual(['כותרת', 'מודגש', 'נטוי', 'רשימה', 'רשימה ממוספרת', 'קישור']);
  });

  it('page offers a heading and a sub-heading, inline offers none', () => {
    expect(labels('page').slice(0, 2)).toEqual(['כותרת', 'כותרת משנה']);
    expect(labels('inline')).toEqual(['מודגש', 'נטוי', 'רשימה', 'רשימה ממוספרת', 'קישור']);
  });

  it('renders the toolbar of the chosen mode', () => {
    for (const [mode, count] of [
      ['description', 6],
      ['page', 7],
      ['inline', 5],
    ] as const) {
      const fixture = TestBed.createComponent(RichTextEditor);
      fixture.componentRef.setInput('mode', mode);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelectorAll('.rte-toolbar button')).toHaveLength(count);
    }
  });

  it('defaults to description mode', () => {
    const fixture = TestBed.createComponent(RichTextEditor);
    fixture.detectChanges();
    expect(fixture.componentInstance.mode()).toBe('description');
  });
});

describe('linkAllowed', () => {
  it('description mode keeps its old rule: http, https and mailto only', () => {
    expect(linkAllowed('https://example.com', 'description')).toBe(true);
    expect(linkAllowed('http://example.com', 'description')).toBe(true);
    expect(linkAllowed('mailto:a@b.co', 'description')).toBe(true);
    expect(linkAllowed('tel:+972501234567', 'description')).toBe(false);
    expect(linkAllowed('/about', 'description')).toBe(false);
  });

  it.each(['page', 'inline'] as const)('%s mode accepts https, mailto, tel and a site path', (mode) => {
    expect(linkAllowed('https://example.com/a?b=1', mode)).toBe(true);
    expect(linkAllowed('mailto:service@example.com', mode)).toBe(true);
    expect(linkAllowed('tel:+972-3-0000000', mode)).toBe(true);
    expect(linkAllowed('/shipping', mode)).toBe(true);
  });

  it.each(['page', 'inline'] as const)('%s mode refuses http, scripts, data, // and spaces', (mode) => {
    expect(linkAllowed('http://example.com', mode)).toBe(false);
    expect(linkAllowed('javascript:alert(1)', mode)).toBe(false);
    expect(linkAllowed('data:text/html,x', mode)).toBe(false);
    expect(linkAllowed('//evil.example', mode)).toBe(false);
    expect(linkAllowed('/\\evil.example', mode)).toBe(false);
    expect(linkAllowed('https://exa mple.com', mode)).toBe(false);
    expect(linkAllowed('tel:abc', mode)).toBe(false);
    expect(linkAllowed('', mode)).toBe(false);
  });
});
