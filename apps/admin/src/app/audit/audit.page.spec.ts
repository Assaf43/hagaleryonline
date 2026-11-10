import { TestBed } from '@angular/core/testing';
import type { AuditEntry, AuditPage } from '@hg/models';
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
});
