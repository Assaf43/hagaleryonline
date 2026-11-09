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
