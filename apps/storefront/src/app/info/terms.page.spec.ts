import { TestBed } from '@angular/core/testing';
import { Meta, Title } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { TermsPage } from './terms.page';
import { TERMS_SECTIONS } from './terms.text';

describe('TermsPage', () => {
  async function setup() {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(TermsPage);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  it('is titled "תנאי שימוש" and not indexed', async () => {
    const el = await setup();
    expect(el.querySelector('h1')?.textContent?.trim()).toBe('תנאי שימוש');
    expect(TestBed.inject(Title).getTitle()).toContain('תנאי שימוש');
    expect(TestBed.inject(Meta).getTag('name="robots"')?.content).toBe('noindex, follow');
  });

  it('has the interim sections: purchase, delivery, returns and privacy', async () => {
    const el = await setup();
    const titles = Array.from(el.querySelectorAll('section h2')).map((h) => h.textContent?.trim());
    expect(titles).toEqual(TERMS_SECTIONS.map((s) => s.titleHe));
    expect(titles).toEqual(['רכישה באתר', 'משלוח ומסירה', 'ביטול עסקה והחזרות', 'פרטיות']);
    expect(el.textContent).toContain('חוק הגנת הצרכן');
  });
});
