import { TestBed } from '@angular/core/testing';
import { Meta, Title } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';
import { SizingGuidePage } from './sizing-guide.page';
import { SIZING_STEPS } from './sizing-guide.text';

describe('SizingGuidePage', () => {
  async function setup() {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(SizingGuidePage);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  it('renders four steps with titles', async () => {
    const el = await setup();
    const titles = Array.from(el.querySelectorAll('li h2')).map((h) => h.textContent?.trim());
    expect(titles).toEqual(['רושמים את המידות', 'מודדים את המקום', 'מסמנים בנייר דבק', 'בודקים את התוצאה']);
    expect(SIZING_STEPS).toHaveLength(4);
    expect(el.querySelectorAll('li svg[aria-hidden="true"]').length).toBe(4);
  });

  it('sets title and description', async () => {
    await setup();
    expect(TestBed.inject(Title).getTitle()).toContain('מדריך מידות');
    expect(TestBed.inject(Meta).getTag('name="description"')?.content).toBe(
      'איך למדוד את המקום בבית לפני שמזמינים רהיט, בארבעה צעדים פשוטים.',
    );
  });
});
