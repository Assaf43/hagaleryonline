import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { FavoritesStore } from '../core/favorites.store';
import { FavoriteButton } from './favorite-button';

describe('FavoriteButton', () => {
  let fixture: ComponentFixture<FavoriteButton>;
  let favorites: FavoritesStore;
  const button = () => (fixture.nativeElement as HTMLElement).querySelector('button')!;
  const status = () => (fixture.nativeElement as HTMLElement).querySelector('[aria-live="polite"]')!;

  beforeEach(() => {
    localStorage.clear();
    favorites = TestBed.inject(FavoritesStore);
    fixture = TestBed.createComponent(FavoriteButton);
    fixture.componentRef.setInput('productId', 5);
    fixture.detectChanges();
  });

  afterEach(() => localStorage.clear());

  it('reflects has() in aria-pressed and label', () => {
    expect(button().getAttribute('aria-pressed')).toBe('false');
    expect(button().getAttribute('aria-label')).toBe('הוספה למועדפים');

    favorites.toggle(5);
    fixture.detectChanges();
    expect(button().getAttribute('aria-pressed')).toBe('true');
    expect(button().getAttribute('aria-label')).toBe('הסרה מהמועדפים');
    expect(button().classList).toContain('on');
  });

  it('toggle on click', () => {
    expect(status().textContent?.trim()).toBe('');

    button().click();
    fixture.detectChanges();
    expect(favorites.has(5)).toBe(true);
    expect(button().getAttribute('aria-pressed')).toBe('true');
    expect(status().textContent?.trim()).toBe('נוסף למועדפים');

    button().click();
    fixture.detectChanges();
    expect(favorites.has(5)).toBe(false);
    expect(status().textContent?.trim()).toBe('הוסר מהמועדפים');
  });
});

describe('FavoriteButton accessible description', () => {
  it('two buttons for two products have different descriptions, with the same label', () => {
    localStorage.clear();
    const make = (id: number, name: string) => {
      const f = TestBed.createComponent(FavoriteButton);
      f.componentRef.setInput('productId', id);
      f.componentRef.setInput('productName', name);
      f.detectChanges();
      return f.nativeElement as HTMLElement;
    };
    const a = make(1, 'ALBA');
    const b = make(2, 'MILO');
    document.body.append(a, b);
    const describedBy = (host: HTMLElement) => {
      const btn = host.querySelector('button')!;
      return document.getElementById(btn.getAttribute('aria-describedby')!)!.textContent!.trim();
    };
    expect(describedBy(a)).toBe('ALBA');
    expect(describedBy(b)).toBe('MILO');
    expect(a.querySelector('button')!.getAttribute('aria-describedby')).not.toBe(
      b.querySelector('button')!.getAttribute('aria-describedby'),
    );
    expect(a.querySelector('button')!.getAttribute('aria-label')).toBe('הוספה למועדפים');
    a.remove();
    b.remove();
    localStorage.clear();
  });
});
