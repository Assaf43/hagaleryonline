import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { DATE_FIELD_INVALID, DateField, fromIsoDay, toIsoDay } from './date-field';

@Component({
  imports: [DateField, FormsModule],
  template: `
    <hga-date-field label="תאריך" inputId="d1" [(value)]="day" />
    <hga-date-field
      label="תאריך"
      inputId="d2"
      name="d2"
      [ngModel]="model()"
      (ngModelChange)="model.set($event)"
      [ngModelOptions]="{ standalone: true }"
    />
  `,
})
class Host {
  readonly day = signal('2026-12-03');
  readonly model = signal('');
}

describe('DateField', () => {
  async function mount() {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const box = (id: string) => el.querySelector<HTMLInputElement>(`#${id}`)!;
    const type = (id: string, text: string, commit = true) => {
      const input = box(id);
      input.value = text;
      input.dispatchEvent(new Event('input'));
      if (commit) input.dispatchEvent(new Event('change'));
      fixture.detectChanges();
      fixture.detectChanges(); // the field's error state is read on the next check
    };
    return { fixture, el, box, type };
  }

  it('shows an ISO value as day.month.year, whatever the browser language is', async () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
    const { box } = await mount();
    expect(box('d1').value).toBe('03.12.2026');
    expect(box('d1').getAttribute('dir')).toBe('ltr');
    vi.restoreAllMocks();
  });

  it('writes the ISO day for a typed day.month.year, through a signal and through ngModel', async () => {
    const { fixture, type } = await mount();
    type('d1', '4.1.2027');
    expect(fixture.componentInstance.day()).toBe('2027-01-04');
    type('d2', '3.12.2026');
    expect(fixture.componentInstance.model()).toBe('2026-12-03');
  });

  it('shows an ngModel value, and reports text that is not a date', async () => {
    const { fixture, el, box, type } = await mount();
    fixture.componentInstance.model.set('2026-02-09');
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve)); // ngModel writes its value in a microtask
    fixture.detectChanges();
    expect(box('d2').value).toBe('09.02.2026');

    type('d1', '12/31/2026');
    expect(fixture.componentInstance.day()).toBe('');
    expect(el.textContent).toContain(DATE_FIELD_INVALID);
  });

  it('keeps half-typed text while the date is not complete yet', async () => {
    const { fixture, box, type } = await mount();
    type('d1', '4.1', false);
    expect(fixture.componentInstance.day()).toBe('');
    expect(box('d1').value).toBe('4.1');
  });

  it('labels the calendar button', async () => {
    const { el } = await mount();
    expect(el.querySelector('mat-datepicker-toggle button')?.getAttribute('aria-label')).toBe('בחירת תאריך');
  });
});

describe('ISO day helpers', () => {
  it('round-trips and refuses an impossible day', () => {
    expect(toIsoDay(new Date(2026, 11, 3))).toBe('2026-12-03');
    expect(toIsoDay(fromIsoDay('2026-12-03')!)).toBe('2026-12-03');
    expect(fromIsoDay('2026-02-31')).toBeNull();
    expect(fromIsoDay('')).toBeNull();
  });
});
