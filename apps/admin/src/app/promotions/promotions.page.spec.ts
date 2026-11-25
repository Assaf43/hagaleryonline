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
  isWelcome: false,
  validityDays: null,
  membersOnly: false,
  appliesToMemberPrices: false,
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

/** The text a sighted user sees (without the visually hidden cell labels). */
const visible = (e: Element | null | undefined) => {
  if (!e) return undefined;
  const copy = e.cloneNode(true) as Element;
  copy.querySelectorAll('.visually-hidden').forEach((h) => h.remove());
  return copy.textContent?.trim();
};

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
      expect(visible(auto.querySelector('.kind'))).toBe('מבצע אוטומטי');
      expect(auto.querySelector('.code')).toBeNull();
      expect(flat(visible(auto.querySelector('.value')))).toBe('15%');
      expect(auto.querySelector('.targets')?.textContent).toContain('קטגוריות: ספות, כורסאות');
      expect(visible(auto.querySelector('.dates'))).toContain('1.11.2026');
      expect(visible(auto.querySelector('.dates'))).toContain('31.12.2099');
      expect(auto.querySelector('.uses')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('שימושים: 12 / ללא הגבלה');
      expect(visible(auto.querySelector('.state'))).toBe('פעיל');

      expect(visible(coupon.querySelector('.kind'))).toBe('קופון');
      expect(coupon.querySelector('.code bdi[dir="ltr"]')?.textContent).toBe('WINTER');
      expect(flat(visible(coupon.querySelector('.value')))).toBe('250₪');
      expect(coupon.querySelector('.targets bdi[dir="ltr"]')?.textContent).toBe('ALBA');
      expect(visible(coupon.querySelector('.dates'))).toBe('ללא תאריכים');
      expect(coupon.querySelector('.uses')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('שימושים: 7 / 50');
      // Every cell says what it is to a screen reader (the columns have no visible headers).
      const hidden = [...auto.querySelectorAll('.visually-hidden')].map((h) => h.textContent?.trim());
      expect(hidden).toEqual(expect.arrayContaining(['סוג:', 'הנחה:', 'חל על:', 'תאריכים:', 'מצב:']));
      expect(coupon.querySelector('.code .visually-hidden')?.textContent?.trim()).toBe('קוד:');
    });

    it('says the intro without the misleading "once used" rule', async () => {
      const { el } = await list();
      expect(el.querySelector('.page-intro')?.textContent).toContain('אי אפשר למחוק מבצעים, רק להשבית אותם.');
      expect(el.querySelector('.page-intro')?.textContent).not.toContain('שכבר שימש');
    });

    it('marks inactive, ended and scheduled promotions with text', async () => {
      const { el } = await list([
        { ...base, id: 1, active: false },
        { ...base, id: 2, endsAt: '2020-01-01T00:00:00.000Z', startsAt: null },
        { ...base, id: 3, startsAt: '2099-01-01T00:00:00.000Z' },
        // Used up wins over active (owner ruling R22).
        { ...COUPON, id: 4, usageLimit: 7, usedCount: 7 },
        { ...COUPON, id: 5, usageLimit: 7, usedCount: 9 },
      ]);
      const states = [...el.querySelectorAll('.state')].map((s) => visible(s));
      expect(states).toEqual(['לא פעיל', 'הסתיים', 'מתוכנן', 'נוצל', 'נוצל']);
      // Only an active promotion can be deactivated.
      expect(el.querySelectorAll('button.deactivate')).toHaveLength(4);
    });

    it('deactivates after a confirmation and shows the new state', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const { fixture, el } = await list();
      el.querySelector<HTMLButtonElement>('.promotion button.deactivate')!.click();
      expect(confirm).toHaveBeenCalledWith('להשבית את "מבצע ספות"? אפשר להפעיל אותו שוב בעריכה.');
      http.expectOne({ method: 'POST', url: '/api/admin/promotions/1/deactivate' }).flush({ ...base, active: false });
      await settle(fixture);
      expect(visible(el.querySelector('.state'))).toBe('לא פעיל');
      confirm.mockRestore();
    });

    it('marks the welcome benefit with a chip', async () => {
      const { el } = await list([{ ...base, isWelcome: true }, COUPON]);
      const [welcome, coupon] = [...el.querySelectorAll('.promotion')];
      expect(welcome.querySelector('.flag-chip')?.textContent?.trim()).toBe('הטבת הצטרפות');
      expect(coupon.querySelector('.flag-chip')).toBeNull();
    });

    it('badges members-only and applies-to-member-prices promotions', async () => {
      const { el } = await list([{ ...base, membersOnly: true, appliesToMemberPrices: true }, COUPON]);
      const [club, plain] = [...el.querySelectorAll('.promotion')];
      expect(club.textContent).toContain('חברים בלבד');
      expect(club.textContent).toContain('גם על מחירי מועדון');
      expect(plain.textContent).not.toContain('חברים בלבד');
      expect(plain.textContent).not.toContain('גם על מחירי מועדון');
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
      type('promo-value', '250');
      type('promo-min', '1000');
      type('promo-start-date', '27.3.2026');
      type('promo-end-date', '27.3.2026');
      type('promo-limit', '20');
      await save();
      const req = http.expectOne({ method: 'POST', url: '/api/admin/promotions' });
      expect(req.request.body).toEqual({
        name: 'קופון סוף שנה',
        kind: 'coupon',
        code: 'END25',
        discountType: 'fixed',
        value: 25_000,
        target: 'order',
        targetIds: [],
        minSubtotal: 100_000,
        startsAt: '2026-03-26T22:00:00.000Z',
        endsAt: '2026-03-27T20:59:59.999Z',
        usageLimit: 20,
        validityDays: null,
        active: true,
        isWelcome: false,
        membersOnly: false,
        appliesToMemberPrices: false,
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
      // Used already: changing the code has a consequence (R22).
      expect(el().querySelector('.used-warning')?.textContent?.trim()).toBe(
        'המבצע כבר נוצל. שינוי הקוד יסיר אותו מסלים פתוחים.',
      );
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

    it('shows no "already used" warning for an unused promotion, and the approved hints', async () => {
      await open('2', { ...COUPON, usedCount: 0 });
      expect(el().querySelector('.used-warning')).toBeNull();
      expect(el().textContent).toContain('ההנחה לא תעלה על סכום המוצרים שהמבצע חל עליהם');
      expect(el().textContent).toContain(
        'מספר ההזמנות שאפשר לבצע עם הקופון (כולל הזמנות שממתינות לתשלום). ריק = ללא הגבלה.',
      );
      el().querySelector<HTMLInputElement>('input[name="kind"][value="automatic"]')!.click();
      fixture.detectChanges();
      expect(el().textContent).toContain('חל אוטומטית בסל, בלי קוד, על כל הזמנה שעומדת בתנאים.');
    });

    describe('club switches (decision 92)', () => {
      const membersBox = () => el().querySelector<HTMLInputElement>('#promo-members-only');
      const memberPricesBox = () => el().querySelector<HTMLInputElement>('#promo-member-prices');

      it('are offered with their labels and hints, and saved when ticked', async () => {
        await open('new');
        expect(membersBox()?.type).toBe('checkbox');
        expect(membersBox()?.checked).toBe(false);
        expect(el().querySelector('label[for="promo-members-only"]')?.textContent?.trim()).toBe('חברי מועדון בלבד');
        expect(el().querySelector('label[for="promo-member-prices"]')?.textContent?.trim()).toBe(
          'חל גם על מחירי מועדון',
        );
        expect(el().textContent).toContain(
          'רק לקוחות מחוברים שהם חברי מועדון. קופון לחברים בלבד תקף פעם אחת לכל חשבון.',
        );
        expect(el().textContent).toContain(
          'כשהמתג כבוי, שורות שנמכרות במחיר מועדון לא יקבלו את ההנחה הזו (הלקוח ישלם את הסכום הנמוך מבין השניים).',
        );
        type('promo-name', 'קופון מועדון');
        type('promo-code', 'CLUB5');
        type('promo-value', '5');
        membersBox()!.click();
        memberPricesBox()!.click();
        fixture.detectChanges();
        await save();
        const req = http.expectOne({ method: 'POST', url: '/api/admin/promotions' });
        expect(req.request.body).toMatchObject({ membersOnly: true, appliesToMemberPrices: true });
        req.flush({ ...COUPON, id: 8 });
        await settle(fixture);
      });

      it('show the saved state', async () => {
        await open('1', { ...base, membersOnly: true, appliesToMemberPrices: false });
        expect(membersBox()?.checked).toBe(true);
        expect(memberPricesBox()?.checked).toBe(false);
      });
    });

    describe('personal-code template (decisions 93-94, spec 4.5)', () => {
      const kindRadio = () => el().querySelector<HTMLInputElement>('input[name="kind"][value="personal_template"]')!;

      it('is a third kind, "תבנית לקוד אישי", with validity days and no code or usage limit', async () => {
        await open('new');
        expect(kindRadio().closest('label')?.textContent?.trim()).toBe('תבנית לקוד אישי');
        expect(el().querySelector('#promo-validity')).toBeNull();
        kindRadio().click();
        fixture.detectChanges();
        await settle(fixture);
        expect(input('promo-validity').value).toBe('30');
        expect(el().textContent).toContain('ימי תוקף');
        expect(el().querySelector('#promo-code')).toBeNull();
        expect(el().querySelector('#promo-limit')).toBeNull();
      });

      it('saves a template with its validity days', async () => {
        await open('new');
        kindRadio().click();
        fixture.detectChanges();
        type('promo-name', 'קוד חג');
        type('promo-value', '15');
        type('promo-validity', '45');
        await save();
        const req = http.expectOne({ method: 'POST', url: '/api/admin/promotions' });
        expect(req.request.body).toMatchObject({
          kind: 'personal_template',
          code: null,
          usageLimit: null,
          validityDays: 45,
          isWelcome: false,
        });
        req.flush({ ...base, id: 9, kind: 'personal_template', validityDays: 45 });
        await settle(fixture);
      });

      it('refuses missing or out-of-range validity days under the field, before sending', async () => {
        await open('new');
        kindRadio().click();
        fixture.detectChanges();
        type('promo-name', 'קוד חג');
        type('promo-value', '15');
        for (const bad of ['', '0', '366', 'x']) {
          type('promo-validity', bad);
          await save();
          expect(el().textContent).toContain('מספר שלם בין 1 ל-365');
          expect(document.activeElement).toBe(input('promo-validity'));
        }
        http.expectNone('/api/admin/promotions');
      });

      it('shows a saved template with its days', async () => {
        await open('1', { ...base, kind: 'personal_template', validityDays: 21 });
        expect(input('promo-validity').value).toBe('21');
      });
    });

    describe('welcome mark (decision 93)', () => {
      const welcomeBox = () => el().querySelector<HTMLInputElement>('#promo-welcome');
      const LABEL = 'הטבת הצטרפות (כל חשבון חדש מקבל ממנה קוד אישי)';

      it('is offered only for a personal-code template, unchecked, with its label', async () => {
        await open('new');
        expect(welcomeBox()).toBeNull();
        el().querySelector<HTMLInputElement>('input[name="kind"][value="automatic"]')!.click();
        fixture.detectChanges();
        expect(welcomeBox()).toBeNull();
        el().querySelector<HTMLInputElement>('input[name="kind"][value="personal_template"]')!.click();
        fixture.detectChanges();
        expect(welcomeBox()?.type).toBe('checkbox');
        expect(welcomeBox()?.checked).toBe(false);
        expect(el().querySelector("label[for='promo-welcome']")?.textContent?.trim()).toBe(LABEL);
        // Its hint is read with it.
        const hint = document.getElementById(welcomeBox()!.getAttribute('aria-describedby') ?? '');
        expect(hint?.textContent).toContain('אחת');
      });

      it('saves the welcome mark of a template', async () => {
        await open('new');
        el().querySelector<HTMLInputElement>('input[name="kind"][value="personal_template"]')!.click();
        fixture.detectChanges();
        type('promo-name', 'הטבת הצטרפות 10%');
        type('promo-value', '10');
        welcomeBox()!.click();
        fixture.detectChanges();
        await save();
        const req = http.expectOne({ method: 'POST', url: '/api/admin/promotions' });
        expect(req.request.body).toMatchObject({ kind: 'personal_template', isWelcome: true, validityDays: 30 });
        req.flush({ ...base, id: 9, kind: 'personal_template', validityDays: 30, isWelcome: true });
        await settle(fixture);
      });

      it('shows a saved welcome template checked, and the API refusal in Hebrew', async () => {
        await open('1', { ...base, kind: 'personal_template', validityDays: 30, isWelcome: true });
        expect(welcomeBox()?.checked).toBe(true);
        await save();
        const req = http.expectOne({ method: 'PUT', url: '/api/admin/promotions/1' });
        expect(req.request.body).toMatchObject({ isWelcome: true });
        req.flush({ statusCode: 400, code: 'invalid', field: 'isWelcome' }, { status: 400, statusText: 'Bad Request' });
        await settle(fixture);
        expect(el().querySelector('.form-error[role=alert]')?.textContent?.trim()).toBe(
          'הטבת הצטרפות אפשרית רק בתבנית לקוד אישי.',
        );
      });
    });

    it('date fields stay between 2000 and 2100', async () => {
      await open('new');
      for (const id of ['promo-start-date', 'promo-end-date']) {
        expect(input(id).getAttribute('min')).toBe('2000-01-01');
        expect(input(id).getAttribute('max')).toBe('2100-12-31');
      }
    });

    it('asks before leaving with unsaved changes, and not otherwise', async () => {
      await open('2', COUPON);
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      expect(fixture.componentInstance.canLeave()).toBe(true);
      expect(confirm).not.toHaveBeenCalled();
      type('promo-name', 'שם אחר');
      expect(fixture.componentInstance.canLeave()).toBe(false);
      expect(confirm).toHaveBeenCalledWith('יש שינויים שלא נשמרו. לצאת בלי לשמור?');
      confirm.mockReturnValue(true);
      expect(fixture.componentInstance.canLeave()).toBe(true);
      confirm.mockRestore();
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
