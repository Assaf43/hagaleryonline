import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Component } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import type { SearchSuggestions } from '@hg/models';
import { SearchBox } from './search-box';

@Component({ imports: [SearchBox], template: '<hg-search-box idPrefix="t" />' })
class Host {}

const URL_RE = /^\/api\/search\/suggest/;

function suggestions(products: number, categories: number): SearchSuggestions {
  return {
    products: Array.from({ length: products }, (_, i) => ({
      slug: `p${i}`,
      modelName: `MODEL${i}`,
      nameHe: `מוצר ${i}`,
      priceFrom: 100000 + i,
      image: null,
    })),
    categories: Array.from({ length: categories }, (_, i) => ({ slug: `c${i}`, nameHe: `קטגוריה ${i}` })),
  };
}

describe('SearchBox', () => {
  let fixture: ComponentFixture<Host>;
  let http: HttpTestingController;
  let el: HTMLElement;
  let input: HTMLInputElement;

  const type = (text: string) => {
    input.value = text;
    input.dispatchEvent(new Event('input'));
  };
  const key = (k: string) =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const settle = () => {
    fixture.detectChanges();
  };
  const requests = () => http.match((r) => URL_RE.test(r.url));
  const options = () => Array.from(el.querySelectorAll<HTMLElement>('[role="option"]'));

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    el = fixture.nativeElement;
    input = el.querySelector('input')!;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function flushWith(req: TestRequest, body: SearchSuggestions) {
    req.flush(body);
    settle();
  }

  async function open(q = 'ספה', p = 8, c = 5) {
    type(q);
    vi.advanceTimersByTime(200);
    const [req] = requests();
    await flushWith(req, suggestions(p, c));
  }

  it('does not request for one character or whitespace', () => {
    type('a');
    type('  ');
    vi.advanceTimersByTime(300);
    expect(requests().length).toBe(0);
    settle();
    expect(el.querySelector('[role="listbox"]')).toBeNull();
  });

  it('requests after 200 ms with the trimmed query', () => {
    type(' ספ ');
    vi.advanceTimersByTime(199);
    expect(requests().length).toBe(0);
    vi.advanceTimersByTime(1);
    const reqs = requests();
    expect(reqs.length).toBe(1);
    expect(reqs[0].request.params.get('q')).toBe('ספ');
  });

  it('cancels the previous request', async () => {
    type('ספ');
    vi.advanceTimersByTime(200);
    const [first] = requests();
    type('ספה');
    vi.advanceTimersByTime(200);
    const [second] = requests();
    expect(first.cancelled).toBe(true);
    await flushWith(second, suggestions(1, 0));
    expect(options().length).toBe(2);
  });

  it('renders products, categories and the all-results row', async () => {
    await open();
    const opts = options();
    expect(opts.length).toBe(6 + 4 + 1);
    expect(opts[0].querySelector('a')!.getAttribute('href')).toBe('/product/p0');
    expect(opts[6].querySelector('a')!.getAttribute('href')).toBe('/category/c0');
    expect(opts[10].querySelector('a')!.getAttribute('href')).toBe(`/search?q=${encodeURIComponent('ספה')}`);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(el.querySelector('[role="status"]')!.textContent).toContain('10 תוצאות');
  });

  it('arrow keys move the active option and wrap', async () => {
    await open();
    key('ArrowDown');
    settle();
    const opts = options();
    expect(input.getAttribute('aria-activedescendant')).toBe(opts[0].id);
    key('ArrowUp');
    settle();
    expect(input.getAttribute('aria-activedescendant')).toBe(opts[opts.length - 1].id);
  });

  it('Enter on an active option navigates to it', async () => {
    const nav = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    await open();
    key('ArrowDown');
    key('Enter');
    expect(nav).toHaveBeenCalledWith('/product/p0');
  });

  it('Enter with no active option submits the current text, even before suggestions arrive', async () => {
    const nav = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    type('ספה');
    vi.advanceTimersByTime(50);
    key('Enter');
    expect(nav).toHaveBeenCalledWith(['/search'], { queryParams: { q: 'ספה' } });
    vi.advanceTimersByTime(300);
    for (const req of requests()) req.flush(suggestions(2, 1));
    settle();
    expect(el.querySelector('[role="listbox"]')).toBeNull();
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('Enter after typing more searches the new text, not the stale active option', async () => {
    const router = TestBed.inject(Router);
    const byUrl = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    const nav = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    await open();
    key('ArrowDown');
    type('ספות');
    key('Enter');
    expect(byUrl).not.toHaveBeenCalled();
    expect(nav).toHaveBeenCalledWith(['/search'], { queryParams: { q: 'ספות' } });
  });

  it('keeps focus on mousedown and still navigates on click', async () => {
    await open();
    const link = options()[0].querySelector('a')!;
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    link.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    settle();
    expect(options().length).toBe(11);
    const nav = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    link.click();
    expect(nav).toHaveBeenCalledWith(expect.anything(), expect.anything());
  });

  it('Enter on an active option clears focus', async () => {
    vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    document.body.appendChild(el);
    input.focus();
    await open();
    key('ArrowDown');
    key('Enter');
    expect(document.activeElement).not.toBe(input);
    el.remove();
  });

  it('scrolls the active option into view', async () => {
    const spy = vi.fn();
    Element.prototype.scrollIntoView = spy;
    await open();
    key('ArrowDown');
    settle();
    await fixture.whenStable();
    expect(spy).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('reopens when the same text is typed again after Escape', async () => {
    await open();
    key('Escape');
    settle();
    type('ספ');
    type('ספה');
    vi.advanceTimersByTime(200);
    const [req] = requests();
    expect(req).toBeTruthy();
    await flushWith(req, suggestions(1, 0));
    expect(options().length).toBe(2);
  });

  it('retries the same query after an error', () => {
    type('ספה');
    vi.advanceTimersByTime(200);
    requests()[0].flush('x', { status: 500, statusText: 'err' });
    settle();
    type('ספה');
    vi.advanceTimersByTime(200);
    expect(requests().length).toBe(1);
  });

  it('a newer value cancels the in-flight request and its result is not shown', async () => {
    await open();
    type('ספהx');
    vi.advanceTimersByTime(200);
    const [stale] = requests();
    type('ספה');
    vi.advanceTimersByTime(200);
    expect(stale.cancelled).toBe(true);
    settle();
    expect(options().length).toBe(11);
    expect(el.textContent).not.toContain('ספהx');
  });

  it('mouseenter does not scroll, ArrowDown does', async () => {
    const spy = vi.fn();
    Element.prototype.scrollIntoView = spy;
    await open();
    options()[2].dispatchEvent(new MouseEvent('mouseenter'));
    settle();
    await fixture.whenStable();
    expect(spy).not.toHaveBeenCalled();
    key('ArrowDown');
    settle();
    await fixture.whenStable();
    expect(spy).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('hovering an option makes it active', async () => {
    await open();
    options()[2].dispatchEvent(new MouseEvent('mouseenter'));
    settle();
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[2].id);
  });

  it('Escape closes and keeps the text', async () => {
    await open();
    key('Escape');
    settle();
    expect(el.querySelector('[role="listbox"]')).toBeNull();
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.value).toBe('ספה');
  });

  it('no results shows the empty line', async () => {
    await open('ספה', 0, 0);
    expect(el.textContent).toContain('לא נמצאו תוצאות ל־"ספה"');
    expect(options().length).toBe(0);
  });
});
