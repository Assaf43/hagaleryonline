import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { ProductCard } from '@hg/models';
import { ProductRow } from './product-row';

const card = (id: number): ProductCard => ({
  id,
  slug: `p${id}`,
  modelName: `MODEL${id}`,
  nameHe: `מוצר ${id}`,
  priceFrom: 100000,
  compareAtFrom: null,
  discountPercent: null,
  hasPriceRange: false,
  swatches: [],
  image: null,
  fulfillment: 'in_stock',
  leadTimeDays: 14,
  isNew: false,
});

describe('ProductRow', () => {
  let fixture: ComponentFixture<ProductRow>;
  const el = () => fixture.nativeElement as HTMLElement;

  function create(products: ProductCard[]) {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    fixture = TestBed.createComponent(ProductRow);
    fixture.componentRef.setInput('title', 'מוצרים דומים');
    fixture.componentRef.setInput('products', products);
    fixture.detectChanges();
  }
  const buttons = () => Array.from(el().querySelectorAll<HTMLButtonElement>('.nav button'));

  afterEach(() => {
    document.documentElement.dir = '';
  });

  it('row renders nothing when empty', () => {
    create([]);
    expect(el().querySelector('section')).toBeNull();
    expect(el().textContent?.trim()).toBe('');
  });

  it('renders the title and a card per product', () => {
    create([card(1), card(2)]);
    expect(el().querySelector('h2')?.textContent).toContain('מוצרים דומים');
    expect(el().querySelectorAll('hg-product-card').length).toBe(2);
  });

  it('row buttons scroll the track and disable at the ends', async () => {
    document.documentElement.dir = 'rtl';
    create([card(1), card(2), card(3), card(4), card(5)]);
    const track = el().querySelector<HTMLElement>('.track')!;
    Object.defineProperty(track, 'clientWidth', { value: 500, configurable: true });
    Object.defineProperty(track, 'scrollWidth', { value: 1500, configurable: true });
    const scrollBy = vi.fn();
    track.scrollBy = scrollBy as unknown as typeof track.scrollBy;
    const scrolled = (left: number) => {
      track.scrollLeft = left;
      track.dispatchEvent(new Event('scroll'));
      fixture.detectChanges();
    };

    scrolled(0);
    const [prev, next] = buttons();
    expect(prev.getAttribute('aria-label')).toBe('הקודם');
    expect(next.getAttribute('aria-label')).toBe('הבא');
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);

    next.click(); // RTL: forward is a negative offset
    expect(scrollBy).toHaveBeenLastCalledWith({ left: -400, behavior: 'smooth' });

    scrolled(-500);
    expect(prev.disabled).toBe(false);
    expect(next.disabled).toBe(false);
    prev.click();
    expect(scrollBy).toHaveBeenLastCalledWith({ left: 400, behavior: 'smooth' });

    scrolled(-1000); // the end
    expect(next.disabled).toBe(true);
    expect(prev.disabled).toBe(false);
  });
});
