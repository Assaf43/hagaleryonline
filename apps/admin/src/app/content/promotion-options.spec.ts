import { promotionOptions } from './home-section.dialog';

describe('promotionOptions', () => {
  it('lists the promotions the content API offers and marks one that is not usable now', () => {
    expect(
      promotionOptions([
        { id: 1, name: 'מבצע ספות', usable: true },
        { id: 2, name: 'מבצע ישן', usable: false },
      ]),
    ).toEqual([
      { id: 1, label: 'מבצע ספות' },
      { id: 2, label: 'מבצע ישן (לא פעיל כעת)' },
    ]);
  });
});
