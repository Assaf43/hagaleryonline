import { BadRequestException } from '@nestjs/common';
import { parseProductListQuery } from './product-list-query.js';

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
