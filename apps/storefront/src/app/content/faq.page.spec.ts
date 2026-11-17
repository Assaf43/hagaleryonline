import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { FaqPage } from './faq.page';

describe('FaqPage', () => {
  it('renders groups as h2 with details / summary', async () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    const fixture = TestBed.createComponent(FaqPage);
    fixture.detectChanges();
    TestBed.inject(HttpTestingController)
      .expectOne('/api/content/faq')
      .flush({
        groups: [{ titleHe: 'משלוחים', items: [{ questionHe: 'מתי מגיע?', answerHtml: '<p>בקרוב</p>' }] }],
      });
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('h2')?.textContent).toBe('משלוחים');
    expect(el.querySelector('details summary')?.textContent).toContain('מתי מגיע?');
    expect(el.querySelector('details hg-rich-text p')?.textContent).toBe('בקרוב');
  });
});
