import { BadRequestException } from '@nestjs/common';
import { MAX_CARD_IDS, parseCardIds, parseProductListQuery } from './product-list-query.js';

describe('parseProductListQuery', () => {
  it('parses every supported parameter', () => {
    expect(
      parseProductListQuery({
        category: 'corner-sofas',
        room: 'living-room',
        q: ' ספה ',
        minPrice: '100000',
        maxWidth: '300',
        fulfillment: 'in_stock,pre_order',
        'attr.color': 'beige,gray',
        'attr.chaise-side': 'right',
        sort: 'price_asc',
        page: '2',
        pageSize: '500',
      }),
    ).toEqual({
      category: 'corner-sofas',
      room: 'living-room',
      q: 'ספה',
      minPrice: 100000,
      maxWidth: 300,
      fulfillment: ['in_stock', 'pre_order'],
      attributes: { color: ['beige', 'gray'], 'chaise-side': ['right'] },
      sort: 'price_asc',
      page: 2,
      pageSize: 60,
    });
  });

  it('accepts an empty query', () => {
    expect(parseProductListQuery({})).toEqual({});
  });

  it.each([
    [{ minPrice: 'cheap' }],
    [{ minWidth: '-5' }],
    [{ page: '1.5' }],
    [{ sort: 'random' }],
    [{ fulfillment: 'tomorrow' }],
    [{ category: 'Sofas!' }],
    [{ 'attr.color': 'beige;drop' }],
    [{ category: ['sofas', 'rugs'] }],
    [{ q: 'א'.repeat(101) }],
  ])('rejects %o', (raw) => {
    expect(() => parseProductListQuery(raw)).toThrow(BadRequestException);
  });
});

describe('parseCardIds', () => {
  it('keeps positive integers in order, first occurrence only', () => {
    expect(parseCardIds('7,3,x,3, 12 ,0,-4,1.5,,7')).toEqual([7, 3, 12]);
  });

  it('returns no ids for a missing or empty parameter', () => {
    expect(parseCardIds(undefined)).toEqual([]);
    expect(parseCardIds('')).toEqual([]);
    expect(parseCardIds('x,y')).toEqual([]);
  });

  it(`accepts ${MAX_CARD_IDS} ids and rejects more`, () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1).join(',');
    expect(parseCardIds(ids(MAX_CARD_IDS))).toHaveLength(MAX_CARD_IDS);
    expect(parseCardIds(`${ids(MAX_CARD_IDS)},1,2`)).toHaveLength(MAX_CARD_IDS);
    expect(() => parseCardIds(ids(MAX_CARD_IDS + 1))).toThrow(BadRequestException);
  });

  it('rejects a repeated parameter and unsafe numbers are dropped', () => {
    expect(() => parseCardIds(['1', '2'])).toThrow(BadRequestException);
    expect(parseCardIds('99999999999999999999,5')).toEqual([5]);
  });
});
