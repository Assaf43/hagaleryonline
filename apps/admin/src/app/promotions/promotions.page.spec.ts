import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import type { AdminPromotion, PromotionCategoryOption } from '@hg/models';
import { PromotionFormPage } from './promotion-form.page';
import { PromotionsPage } from './promotions.page';

const base: AdminPromotion = {
  id: 1,
  name: 'מבצע ספות',
  kind: 'automatic',
  code: null,
  discountType: 'percent',
  value: 15,
  target: 'categories',
  targets: [
    { id: 3, nameHe: 'ספות', modelName: null, active: true, thumbnailUrl: null },
    { id: 4, nameHe: 'כורסאות', modelName: null, active: true, thumbnailUrl: null },
  ],
  minSubtotal: 0,
  startsAt: '2026-10-31T22:00:00.000Z',
  endsAt: '2099-12-31T21:59:59.999Z',
  usageLimit: null,
  usedCount: 12,
  active: true,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
};

const COUPON: AdminPromotion = {
  ...base,
  id: 2,
  name: 'קופון חורף',
  kind: 'coupon',
  code: 'WINTER',
  discountType: 'fixed',
  value: 25_000,
  target: 'products',
  targets: [{ id: 9, nameHe: 'ספה תלת', modelName: 'ALBA', active: true, thumbnailUrl: null }],
  startsAt: null,
  endsAt: null,
  usageLimit: 50,
  usedCount: 7,
};

const CATEGORIES: PromotionCategoryOption[] = [
  { id: 3, nameHe: 'ספות', depth: 0 },
  { id: 5, nameHe: 'ספות פינתיות', depth: 1 },
  { id: 4, nameHe: 'כורסאות', depth: 0 },
];

/** Text without the bidi marks and spaces the currency formatter adds. */
const flat = (text: string | null | undefined) => (text ?? '').replace(/[‎‏\s]/g, '');

const settle = async (fixture: ComponentFixture<unknown>) => {
  await fixture.whenStable();
  fixture.detectChanges();
};

describe('admin promotions screens', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  describe('list', () => {
    async function list(items: AdminPromotion[] = [base, COUPON]) {
      const fixture = TestBed.createComponent(PromotionsPage);
      fixture.detectChanges();
      http.expectOne('/api/admin/promotions').flush(items);
      await settle(fixture);
      return { fixture, el: fixture.nativeElement as HTMLElement };
    }

    it('shows name, kind, code, value, targets, dates, used/limit and state', async () => {
      const { el } = await list();
      const rows = [...el.querySelectorAll('.promotion')];
      expect(rows).toHaveLength(2);
      const [auto, coupon] = rows;
      expect(auto.querySelector('.name')?.textContent).toContain('מבצע ספות');
      expect(auto.querySelector('a')?.getAttribute('href')).toBe('/promotions/1');
      expect(auto.querySelector('.kind')?.textContent?.trim()).toBe('מבצע אוטומטי');
      expect(auto.querySelector('.code')).toBeNull();
      expect(flat(auto.querySelector('.value')?.textContent)).toBe('15%');
      expect(auto.querySelector('.targets')?.textContent).toContain('קטגוריות: ספות, כורסאות');
      expect(auto.querySelector('.dates')?.textContent).toContain('1.11.2026');
      expect(auto.querySelector('.dates')?.textContent).toContain('31.12.2099');
      expect(auto.querySelector('.uses')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('שימושים: 12 / ללא הגבלה');
      expect(auto.querySelector('.state')?.textContent?.trim()).toBe('פעיל');

      expect(coupon.querySelector('.kind')?.textContent?.trim()).toBe('קופון');
      expect(coupon.querySelector('.code bdi[dir="ltr"]')?.textContent).toBe('WINTER');
      expect(flat(coupon.querySelector('.value')?.textContent)).toBe('250₪');
      expect(coupon.querySelector('.targets bdi[dir="ltr"]')?.textContent).toBe('ALBA');
      expect(coupon.querySelector('.dates')?.textContent?.trim()).toBe('ללא תאריכים');
      expect(coupon.querySelector('.uses')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('שימושים: 7 / 50');
    });

    it('marks inactive, ended and scheduled promotions with text', async () => {
      const { el } = await list([
        { ...base, id: 1, active: false },
        { ...base, id: 2, endsAt: '2020-01-01T00:00:00.000Z', startsAt: null },
        { ...base, id: 3, startsAt: '2099-01-01T00:00:00.000Z' },
      ]);
      const states = [...el.querySelectorAll('.state')].map((s) => s.textContent?.trim());
      expect(states).toEqual(['לא פעיל', 'הסתיים', 'מתוכנן']);
      // Only an active promotion can be deactivated.
      expect(el.querySelectorAll('button.deactivate')).toHaveLength(2);
    });

    it('deactivates after a confirmation and shows the new state', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const { fixture, el } = await list();
      el.querySelector<HTMLButtonElement>('.promotion button.deactivate')!.click();
      expect(confirm).toHaveBeenCalledWith('להשבית את "מבצע ספות"? אפשר להפעיל אותו שוב בעריכה.');
      http.expectOne({ method: 'POST', url: '/api/admin/promotions/1/deactivate' }).flush({ ...base, active: false });
      await settle(fixture);
      expect(el.querySelector('.state')?.textContent?.trim()).toBe('לא פעיל');
      confirm.mockRestore();
    });

    it('shows an empty state and a link to a new promotion', async () => {
      const { el } = await list([]);
      expect(el.querySelector('.empty')?.textContent).toContain('אין מבצעים עדיין');
      expect(el.querySelector('a.new')?.getAttribute('href')).toBe('/promotions/new');
    });
  });

  describe('form', () => {
    let fixture: ComponentFixture<PromotionFormPage>;
    const el = () => fixture.nativeElement as HTMLElement;
    const input = (id: string) => el().querySelector<HTMLInputElement>(`#${id}`)!;
    const type = (id: string, value: string) => {
      input(id).value = value;
      input(id).dispatchEvent(new Event('input'));
      fixture.detectChanges();
    };
    const save = async () => {
      el().querySelector<HTMLButtonElement>('button.save')!.click();
      await settle(fixture);
    };

    async function open(id: string, promotion?: AdminPromotion) {
      fixture = TestBed.createComponent(PromotionFormPage);
      fixture.componentRef.setInput('id', id);
      document.body.appendChild(fixture.nativeElement);
      fixture.detectChanges();
      http.expectOne('/api/admin/promotions/categories').flush(CATEGORIES);
      if (promotion) http.expectOne(`/api/admin/promotions/${promotion.id}`).flush(promotion);
      await settle(fixture);
      await settle(fixture);
    }

    afterEach(() => fixture?.nativeElement.remove());

    it('a new coupon: refuses empty fields, marks them and focuses the first', async () => {
      await open('new');
      expect(el().querySelector('h1')?.textContent).toContain('מבצע חדש');
      await save();
      http.expectNone('/api/admin/promotions');
      const name = input('promo-name');
      expect(name.getAttribute('aria-invalid')).toBe('true');
      expect(document.activeElement).toBe(name);
      const describedBy = name.getAttribute('aria-describedby') ?? '';
      const errorText = describedBy
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');
      expect(errorText).toContain('חובה לתת שם למבצע');
      expect(el().textContent).toContain('חובה למלא קוד קופון');
    });

    it('saves a new coupon with shekels as agorot and Israel dates as UTC', async () => {
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
      await open('new');
      type('promo-name', 'קופון סוף שנה');
      type('promo-code', 'end25');
      el().querySelector<HTMLInputElement>('input[name="discountType"][value="fixed"]')!.click();
      fixture.detectChanges();
      type('promo-value', '250.5');
      type('promo-min', '1000');
      type('promo-start-date', '2026-03-27');
      type('promo-end-date', '2026-03-27');
      type('promo-limit', '20');
      await save();
      const req = http.expectOne({ method: 'POST', url: '/api/admin/promotions' });
      expect(req.request.body).toEqual({
        name: 'קופון סוף שנה',
        kind: 'coupon',
        code: 'END25',
        discountType: 'fixed',
        value: 25_050,
        target: 'order',
        targetIds: [],
        minSubtotal: 100_000,
        startsAt: '2026-03-26T22:00:00.000Z',
        endsAt: '2026-03-27T20:59:59.999Z',
        usageLimit: 20,
        active: true,
      });
      req.flush({ ...COUPON, id: 8 });
      await settle(fixture);
      expect(navigate).toHaveBeenCalledWith('/promotions');
    });

    it('hides the code and the usage limit for an automatic promotion, and picks categories', async () => {
      await open('new');
      el().querySelector<HTMLInputElement>('input[name="kind"][value="automatic"]')!.click();
      fixture.detectChanges();
      expect(el().querySelector('#promo-code')).toBeNull();
      expect(el().querySelector('#promo-limit')).toBeNull();
      el().querySelector<HTMLInputElement>('input[name="target"][value="categories"]')!.click();
      fixture.detectChanges();
      const boxes = [...el().querySelectorAll<HTMLInputElement>('.categories input[type="checkbox"]')];
      expect(boxes).toHaveLength(3);
      boxes[1].click();
      fixture.detectChanges();
      type('promo-name', 'מבצע פינתיות');
      type('promo-value', '10');
      await save();
      const req = http.expectOne({ method: 'POST', url: '/api/admin/promotions' });
      expect(req.request.body).toMatchObject({
        kind: 'automatic',
        code: null,
        usageLimit: null,
        target: 'categories',
        targetIds: [5],
        discountType: 'percent',
        value: 10,
      });
      req.flush({ ...base, id: 9 });
      await settle(fixture);
    });

    it('edits a saved coupon and shows a taken code under the code field', async () => {
      await open('2', COUPON);
      expect(el().querySelector('h1')?.textContent).toContain('עריכת מבצע');
      expect(input('promo-name').value).toBe('קופון חורף');
      expect(input('promo-value').value).toBe('250');
      expect(el().querySelector('.picked bdi')?.textContent).toBe('ALBA');
      expect(el().textContent).toContain('שימושים עד עכשיו: 7');
      type('promo-code', 'taken');
      await save();
      const req = http.expectOne({ method: 'PUT', url: '/api/admin/promotions/2' });
      expect(req.request.body).toMatchObject({ code: 'TAKEN', targetIds: [9], usageLimit: 50 });
      req.flush(
        { statusCode: 409, code: 'duplicate', field: 'code', value: 'TAKEN' },
        { status: 409, statusText: 'Conflict' },
      );
      await settle(fixture);
      const code = input('promo-code');
      expect(code.getAttribute('aria-invalid')).toBe('true');
      expect(el().textContent).toContain('כבר יש קופון עם הקוד הזה');
      expect(document.activeElement).toBe(code);
    });

    it('says when the promotion does not exist', async () => {
      fixture = TestBed.createComponent(PromotionFormPage);
      fixture.componentRef.setInput('id', '77');
      fixture.detectChanges();
      http.expectOne('/api/admin/promotions/categories').flush(CATEGORIES);
      http.expectOne('/api/admin/promotions/77').flush({ code: 'not_found' }, { status: 404, statusText: 'Not Found' });
      await settle(fixture);
      await settle(fixture);
      expect(el().querySelector('[role=alert]')?.textContent).toContain('לא נמצא');
    });
  });
});
