import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Component, signal } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import type { LocalityOption } from '@hg/models';
import { LocalityField } from './locality-field';

@Component({
  imports: [LocalityField],
  template: '<hg-locality-field inputId="loc" [error]="error()" [(value)]="value" />',
})
class Host {
  readonly value = signal<LocalityOption | null>(null);
  readonly error = signal('');
}

const ROWS: LocalityOption[] = [
  { id: 5000, nameHe: 'תל אביב - יפו' },
  { id: 2610, nameHe: 'תל מונד' },
  { id: 8700, nameHe: 'רמת השרון' },
];

describe('LocalityField', () => {
  let fixture: ComponentFixture<Host>;
  let http: HttpTestingController;
  let el: HTMLElement;
  let input: HTMLInputElement;

  const type = (text: string) => {
    input.value = text;
    input.dispatchEvent(new Event('input'));
  };
  const key = (k: string) => {
    const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    fixture.detectChanges();
    return event;
  };
  const options = () => Array.from(el.querySelectorAll<HTMLElement>('[role="option"]'));
  const localityRequests = () => http.match((r) => r.url === '/api/localities');

  async function open(q = 'תל', rows = ROWS) {
    type(q);
    vi.advanceTimersByTime(200);
    const [req] = localityRequests();
    expect(req.request.params.get('q')).toBe(q);
    req.flush(rows);
    fixture.detectChanges();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    el = fixture.nativeElement;
    input = el.querySelector('input')!;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is a labelled combobox', () => {
    expect(input.id).toBe('loc');
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector('label[for="loc"]')?.textContent).toContain('יישוב');
  });

  it('searches 200 ms after typing and lists the localities', async () => {
    type('תל');
    vi.advanceTimersByTime(199);
    expect(localityRequests().length).toBe(0);
    await open('תל');
    expect(options().map((o) => o.textContent?.trim())).toEqual(ROWS.map((r) => r.nameHe));
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-controls')).toBe(el.querySelector('[role="listbox"]')!.id);
  });

  it('arrow keys move the active option and wrap', async () => {
    await open();
    key('ArrowDown');
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[0].id);
    expect(options()[0].getAttribute('aria-selected')).toBe('true');
    key('ArrowUp');
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[2].id);
    key('ArrowDown');
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[0].id);
  });

  it('Enter picks the active option, fills the input and closes', async () => {
    await open();
    key('ArrowDown');
    key('ArrowDown');
    const enter = key('Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(fixture.componentInstance.value()).toEqual(ROWS[1]);
    expect(input.value).toBe('תל מונד');
    expect(el.querySelector('[role="listbox"]')).toBeNull();
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('Enter without an active option does not submit the form or pick anything', async () => {
    await open();
    const enter = key('Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(fixture.componentInstance.value()).toBeNull();
  });

  it('Escape closes and keeps the text', async () => {
    await open();
    key('Escape');
    expect(el.querySelector('[role="listbox"]')).toBeNull();
    expect(input.value).toBe('תל');
  });

  it('a click on an option picks it', async () => {
    await open();
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    options()[2].dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    options()[2].click();
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toEqual(ROWS[2]);
    expect(input.value).toBe('רמת השרון');
  });

  it('typing after a pick clears the value', async () => {
    await open();
    key('ArrowDown');
    key('Enter');
    type('תל אביב');
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBeNull();
  });

  it('says when nothing was found', async () => {
    await open('zz', []);
    expect(el.textContent).toContain('לא נמצא יישוב בשם הזה');
    expect(options().length).toBe(0);
  });

  it('shows the error and points the input at it', () => {
    fixture.componentInstance.error.set('יש לבחור יישוב מהרשימה');
    fixture.detectChanges();
    const error = el.querySelector('#loc-error')!;
    expect(error.textContent).toContain('יש לבחור יישוב מהרשימה');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe('loc-error');
  });

  it('shows the picked name when the value is set from outside', () => {
    fixture.componentInstance.value.set(ROWS[0]);
    fixture.detectChanges();
    expect(input.value).toBe('תל אביב - יפו');
  });
});
