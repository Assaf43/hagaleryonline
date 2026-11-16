import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import type { ProductCard as Card, VariantDetail } from '@hg/models';
import { CustomerStore } from '../account/customer.store';
import { customerMe } from '../account/account.testing';
import { PriceBlock } from './price-block';
import { ProductCard } from './product-card';
import { JoinBox } from './member-join-box';

const card: Card = {
  id: 1,
  slug: 'alba',
  modelName: 'ALBA',
  nameHe: 'ספה',
  priceFrom: 100_000,
  compareAtFrom: null,
  discountPercent: null,
  memberPriceFrom: 90_000,
  hasPriceRange: false,
  swatches: [],
  image: null,
  fulfillment: 'in_stock',
  leadTimeDays: 14,
  isNew: false,
};

function setup() {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] });
  return TestBed.inject(CustomerStore);
}

describe('member price on the product card', () => {
  function render(store: CustomerStore) {
    const f = TestBed.createComponent(ProductCard);
    f.componentRef.setInput('product', card);
    f.detectChanges();
    return { f, text: () => (f.nativeElement as HTMLElement).textContent ?? '' };
  }

  it('shows the regular price only before the browser knows the viewer (server render)', () => {
    const { text } = render(setup());
    expect(text()).toContain('1,000');
    expect(text()).not.toContain('חברי מועדון');
    expect(text()).not.toContain('900');
  });

  it('shows the guest line once the viewer is a guest', () => {
    const store = setup();
    store.restore(null);
    const { text } = render(store);
    expect(text()).toContain('חברי מועדון:');
    expect(text()).toContain('900');
    expect(text()).toContain('1,000');
  });

  it('puts the member price on the main line for a member, the regular price struck, and a label', () => {
    const store = setup();
    store.restore(customerMe());
    const { f, text } = render(store);
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('.price')?.textContent).toContain('900');
    expect(el.querySelector('s')?.textContent).toContain('מחיר רגיל');
    expect(el.querySelector('s')?.textContent).toContain('1,000');
    expect(text()).toContain('מחיר מועדון');
    expect(text()).not.toContain('חברי מועדון:');
    expect(el.querySelector('.price')?.classList.contains('sale')).toBe(false);
  });
});

describe('member price on the product page', () => {
  const variant = { price: 100_000, compareAtPrice: null, memberPrice: 90_000 } as VariantDetail;

  function render(store: CustomerStore) {
    const f = TestBed.createComponent(PriceBlock);
    f.componentRef.setInput('variant', variant);
    f.detectChanges();
    return f.nativeElement as HTMLElement;
  }

  it('regular only until known; member price main for a member', () => {
    const store = setup();
    expect(render(store).textContent).not.toContain('900');
    store.restore(customerMe());
    const el = render(store);
    expect(el.querySelector('.price-now')?.textContent).toContain('900');
    expect(el.querySelector('s')?.textContent).toContain('1,000');
    expect(el.textContent).toContain('מחיר מועדון');
  });

  it('a guest gets a box with a join link carrying the product url', () => {
    const store = setup();
    store.restore(null);
    const f = TestBed.createComponent(JoinBox);
    f.componentRef.setInput('variant', variant);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.textContent).toContain('חברי מועדון משלמים');
    expect(el.textContent).toContain('900');
    const a = el.querySelector('a')!;
    expect(a.textContent).toContain('התחברות או הצטרפות');
    expect(a.getAttribute('href')).toMatch(/^\/account\?next=/);
  });

  it('no box for a member or while unknown', () => {
    const store = setup();
    const f = TestBed.createComponent(JoinBox);
    f.componentRef.setInput('variant', variant);
    f.detectChanges();
    expect((f.nativeElement as HTMLElement).querySelector('a')).toBeNull();
    store.restore(customerMe());
    f.detectChanges();
    expect((f.nativeElement as HTMLElement).querySelector('a')).toBeNull();
  });
});
