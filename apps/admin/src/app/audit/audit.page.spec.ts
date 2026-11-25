import { TestBed } from '@angular/core/testing';
import { AUDIT_ACTION_LABELS, AUDIT_ENTITY_LABELS, type AuditEntry, type AuditPage } from '@hg/models';
import { UsersApi } from '../core/users.api';
import { AuditPageComponent } from './audit.page';

const entry = (over: Partial<AuditEntry>): AuditEntry => ({
  id: 1,
  createdAt: '2026-11-10T09:00:00Z',
  actor: { id: 1, name: 'בעלת העסק' },
  action: 'shipping.rates.update',
  entityType: 'shipping',
  entityId: null,
  entityLabel: null,
  before: null,
  after: null,
  ...over,
});

describe('AuditPageComponent', () => {
  async function render(items: AuditEntry[]) {
    const page: AuditPage = { items, total: items.length, page: 1, pageSize: 50 };
    TestBed.configureTestingModule({ providers: [{ provide: UsersApi, useValue: { audit: async () => page } }] });
    const fixture = TestBed.createComponent(AuditPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }
  const changes = (el: HTMLElement) =>
    [...el.querySelectorAll('.audit-change')].map((c) => c.textContent!.replace(/\s+/g, ' ').trim());

  it('shows a shipping price list change line by line, in Hebrew', async () => {
    const el = await render([
      entry({
        before: { 'ברירת מחדל': 'הובלה ₪150 / הרכבה ₪0', 'הנחה לפריט נוסף': '50%' },
        after: { 'ברירת מחדל': 'הובלה ₪450 / הרכבה ₪200', 'הנחה לפריט נוסף': '40%' },
      }),
    ]);
    expect(el.textContent).toContain('עדכון מחירון המשלוחים');
    expect(el.textContent).not.toContain('[object Object]');
    expect(changes(el)).toEqual([
      'ברירת מחדל: הובלה ₪150 / הרכבה ₪0 ← הובלה ₪450 / הרכבה ₪200',
      'הנחה לפריט נוסף: 50% ← 40%',
    ]);
  });

  it('shows what a new or deleted shipping zone held', async () => {
    const zone = { שם: 'אילת', תוספת: '₪250', יישובים: 'אילת, שחר' };
    const el = await render([
      entry({ id: 1, action: 'shipping_zone.create', entityType: 'shipping_zone', entityId: '3', after: zone }),
      entry({ id: 2, action: 'shipping_zone.delete', entityType: 'shipping_zone', entityId: '3', before: zone }),
    ]);
    expect(el.textContent).not.toContain('[object Object]');
    expect(changes(el)).toEqual([
      'שם: — ← אילת',
      'תוספת: — ← ₪250',
      'יישובים: — ← אילת, שחר',
      'שם: אילת ← —',
      'תוספת: ₪250 ← —',
      'יישובים: אילת, שחר ← —',
    ]);
  });

  it('shows a content page change readable, with HTML collapsed', async () => {
    const el = await render([
      entry({
        action: 'content.page.update',
        entityType: 'info_page',
        entityId: '2',
        before: { כותרת: 'משלוחים', תוכן: '<p>ישן</p>' },
        after: { כותרת: 'משלוחים והחזרות', תוכן: '<p>חדש</p>' },
      }),
    ]);
    expect(el.textContent).toContain('עדכון עמוד מידע');
    expect(el.textContent).toContain('עמוד מידע');
    expect(changes(el)).toEqual(['כותרת: משלוחים ← משלוחים והחזרות', 'תוכן: (טקסט) ← (טקסט)']);
  });

  it('shows an order cancel in Hebrew and an unknown old action as it is', async () => {
    const el = await render([
      entry({ id: 1, action: 'order.cancel', entityType: 'order', entityId: '100008' }),
      entry({ id: 2, action: 'legacy.thing', entityType: 'legacy_entity', entityId: '5' }),
    ]);
    expect(el.textContent).toContain('ביטול הזמנה');
    expect(el.textContent).toContain('הזמנה: #100008');
    expect(el.textContent).toContain('legacy.thing');
    expect(el.textContent).toContain('legacy_entity');
  });

  it('shows the cancel reason and refund of an order cancel in Hebrew', async () => {
    const el = await render([
      entry({
        action: 'order.cancel',
        entityType: 'order',
        entityId: '100008',
        before: { status: 'paid' },
        after: { status: 'cancelled', reason: 'הלקוח ביקש', refund: 'partial', refundAmount: 12500 },
      }),
    ]);
    const text = changes(el).join('|');
    expect(text).toContain('סיבת ביטול: — ← הלקוח ביקש');
    expect(text).toContain('החזר כספי: — ← חלקי');
    expect(text).toContain('סכום החזר:');
    expect(text).toContain('125');
  });

  it('shows an order status move before and after, with the Hebrew status names', async () => {
    const el = await render([
      entry({
        action: 'order.status',
        entityType: 'order',
        entityId: '100008',
        before: { status: 'paid' },
        after: { status: 'processing' },
      }),
    ]);
    expect(el.textContent).toContain('שינוי סטטוס הזמנה');
    expect(changes(el)).toEqual(['מצב: שולמה ← בהכנה']);
  });

  it('shows the delivery slot of a move to delivery scheduled, and a slot-only change', async () => {
    const el = await render([
      entry({
        id: 1,
        action: 'order.status',
        entityType: 'order',
        entityId: '100008',
        before: { status: 'processing' },
        after: { status: 'delivery_scheduled', slot: { date: '2026-11-17', windowFrom: '09:00', windowTo: '13:00' } },
      }),
      entry({
        id: 2,
        action: 'order.status',
        entityType: 'order',
        entityId: '100008',
        before: { status: 'delivery_scheduled' },
        after: { status: 'delivery_scheduled', slot: { date: '2026-11-18', windowFrom: '10:00', windowTo: '12:00' } },
      }),
    ]);
    expect(changes(el)).toEqual([
      'מצב: בהכנה ← אספקה מתואמת',
      'חלון אספקה: — ← 2026-11-17 09:00–13:00',
      'חלון אספקה: — ← 2026-11-18 10:00–12:00',
    ]);
  });

  it('has a Hebrew label for every audit action and entity type', () => {
    for (const label of [...Object.values(AUDIT_ACTION_LABELS), ...Object.values(AUDIT_ENTITY_LABELS)]) {
      expect(label).toMatch(/[א-ת]/);
    }
  });
});
