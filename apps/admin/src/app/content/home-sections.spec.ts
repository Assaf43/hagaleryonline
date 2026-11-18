import type { AdminHome, ProductSource } from '@hg/models';
import {
  firstProblem,
  hasUnavailable,
  homeInput,
  homeSignature,
  moveItem,
  newSection,
  sectionProblems,
  toDrafts,
  type HomeDraft,
} from './home-sections';

const home: AdminHome = {
  updatedAt: '2026-11-17T10:00:00.000Z',
  sections: [
    {
      id: 1,
      kind: 'hero',
      bannerIds: [3],
      titleHe: null,
      visible: true,
      unavailable: { bannerIds: [3], categoryIds: [], productIds: [], source: false },
    },
    {
      id: 4,
      kind: 'products',
      source: { kind: 'bestsellers' },
      count: 4,
      titleHe: 'הנמכרים',
      visible: false,
      unavailable: { bannerIds: [], categoryIds: [], productIds: [], source: false },
    },
  ],
};

describe('home sections', () => {
  it('moves a section up or down and keeps the ends', () => {
    expect(moveItem([1, 2, 3], 1, -1)).toEqual([2, 1, 3]);
    expect(moveItem([1, 2, 3], 1, 1)).toEqual([1, 3, 2]);
    expect(moveItem([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
    expect(moveItem([1, 2, 3], 2, 1)).toEqual([1, 2, 3]);
  });

  it('sends the whole list in order, ids only for saved sections, no keys or marks', () => {
    const list = moveItem(toDrafts(home), 1, -1);
    list.push(newSection('trust'));
    const input = homeInput(list, home.updatedAt);
    expect(input.expectedUpdatedAt).toBe(home.updatedAt);
    expect(input.sections.map((s) => s.kind)).toEqual(['products', 'hero', 'trust']);
    expect(input.sections.map((s) => s.id)).toEqual([4, 1, undefined]);
    expect(input.sections[2]).not.toHaveProperty('id');
    expect(input.sections[0]).toEqual({
      id: 4,
      kind: 'products',
      source: { kind: 'bestsellers' },
      count: 4,
      titleHe: 'הנמכרים',
      visible: false,
    });
  });

  it('turns a blank title into null', () => {
    const d = { ...newSection('trust'), titleHe: '   ' };
    expect(homeInput([d], '').sections[0].titleHe).toBeNull();
  });

  it('starts every kind with sensible settings', () => {
    expect(newSection('hero')).toMatchObject({ kind: 'hero', bannerIds: [], visible: true });
    expect(newSection('products')).toMatchObject({ source: { kind: 'bestsellers' }, count: 4 });
    expect(newSection('categories')).toMatchObject({ categoryIds: [] });
  });

  describe('source field per kind', () => {
    const products = (source: ProductSource) => ({ ...newSection('products'), source }) as HomeDraft;

    it('accepts best sellers and newest without more settings', () => {
      expect(sectionProblems(products({ kind: 'newest' }))).toEqual({});
    });

    it('asks for a category, room or promotion', () => {
      expect(sectionProblems(products({ kind: 'category', id: 0 }))['source']).toContain('קטגוריה');
      expect(sectionProblems(products({ kind: 'room', id: 0 }))['source']).toContain('חדר');
      expect(sectionProblems(products({ kind: 'promotion', id: 0 }))['source']).toContain('מבצע');
      expect(sectionProblems(products({ kind: 'room', id: 2 }))).toEqual({});
    });

    it('needs 1 to 48 manual products', () => {
      expect(sectionProblems(products({ kind: 'manual', productIds: [] }))['source']).toBeTruthy();
      expect(sectionProblems(products({ kind: 'manual', productIds: [5] }))).toEqual({});
      const many = Array.from({ length: 49 }, (_, i) => i + 1);
      expect(sectionProblems(products({ kind: 'manual', productIds: many }))['source']).toBeTruthy();
    });
  });

  it('needs 2 to 8 category tiles and at most 5 hero / 4 pair banners', () => {
    const tiles = (ids: number[]) => ({ ...newSection('categories'), categoryIds: ids }) as HomeDraft;
    expect(sectionProblems(tiles([1]))['categoryIds']).toBeTruthy();
    expect(sectionProblems(tiles([1, 2]))).toEqual({});
    expect(sectionProblems(tiles([1, 2, 3, 4, 5, 6, 7, 8, 9]))['categoryIds']).toBeTruthy();
    const hero = (n: number) =>
      ({ ...newSection('hero'), bannerIds: Array.from({ length: n }, (_, i) => i + 1) }) as HomeDraft;
    const pair = (n: number) =>
      ({ ...newSection('banner_pair'), bannerIds: Array.from({ length: n }, (_, i) => i + 1) }) as HomeDraft;
    expect(sectionProblems(hero(5))).toEqual({});
    expect(sectionProblems(hero(6))['bannerIds']).toBeTruthy();
    expect(sectionProblems(pair(4))).toEqual({});
    expect(sectionProblems(pair(5))['bannerIds']).toBeTruthy();
  });

  it('names the first section with a problem, and refuses an empty list', () => {
    expect(firstProblem([])?.index).toBe(-1);
    const list = [newSection('trust'), newSection('categories')];
    expect(firstProblem(list)?.index).toBe(1);
    expect(firstProblem([newSection('trust')])).toBeNull();
  });

  it('knows when the site cannot show something', () => {
    expect(hasUnavailable({ bannerIds: [], categoryIds: [], productIds: [], source: false })).toBe(false);
    expect(hasUnavailable({ bannerIds: [], categoryIds: [], productIds: [4], source: false })).toBe(true);
    expect(hasUnavailable({ bannerIds: [], categoryIds: [], productIds: [], source: true })).toBe(true);
  });

  it('has a signature that ignores keys and changes with the order', () => {
    const a = toDrafts(home);
    const b = toDrafts(home);
    expect(homeSignature(a)).toBe(homeSignature(b));
    expect(homeSignature(moveItem(a, 0, 1))).not.toBe(homeSignature(a));
  });
});
