import { TestBed } from '@angular/core/testing';
import type { StorePendingOrder } from '@hg/models';
import { PendingOrders } from './pending-orders';

const order = (number: number, actions: StorePendingOrder['actions']): StorePendingOrder => ({
  number,
  fullName: 'רון לוי',
  total: 100_000,
  status: 'pending_payment',
  reservedUntil: '2026-11-16T10:00:00.000Z',
  actions,
});

describe('store sale pending orders', () => {
  it('shows nothing for an empty list', () => {
    const fixture = TestBed.createComponent(PendingOrders);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('section')).toBeNull();
  });

  it('renders buttons from actions only and emits the order number', () => {
    const fixture = TestBed.createComponent(PendingOrders);
    fixture.componentRef.setInput('orders', [order(1, ['retry', 'cancel']), order(2, ['cancel']), order(3, [])]);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const rows = [...el.querySelectorAll('.card')];
    const labels = rows.map((r) => [...r.querySelectorAll('button')].map((b) => b.textContent?.trim()));
    expect(labels).toEqual([['נסה שוב', 'בטל'], ['בטל'], []]);
    const retry = vi.fn();
    const cancel = vi.fn();
    fixture.componentInstance.retry.subscribe(retry);
    fixture.componentInstance.cancel.subscribe(cancel);
    rows[0].querySelectorAll('button')[0].click();
    rows[1].querySelector('button')!.click();
    expect(retry).toHaveBeenCalledWith(1);
    expect(cancel).toHaveBeenCalledWith(2);
    expect(rows[0].querySelector('bdi')?.textContent).toBe('1');
  });
});
