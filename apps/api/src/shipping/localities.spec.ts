import { normalizeLocality } from './localities.js';

describe('normalizeLocality', () => {
  it('folds gershayim and geresh variants, trims and collapses spaces', () => {
    expect(normalizeLocality('  ניר   ח״ן ')).toBe('ניר ח"ן');
    expect(normalizeLocality('ג׳ת')).toBe("ג'ת");
  });

  it('treats a hyphen, maqaf, en dash or em dash and the spaces around it as one space', () => {
    const expected = 'תל אביב יפו';
    for (const q of ['תל אביב יפו', 'תל אביב-יפו', 'תל אביב - יפו', 'תל אביב־יפו', 'תל אביב – יפו', 'תל אביב —יפו']) {
      expect(normalizeLocality(q)).toBe(expected);
    }
  });

  it('drops a leading or trailing dash', () => {
    expect(normalizeLocality('תל אביב -')).toBe('תל אביב');
    expect(normalizeLocality('- יפו')).toBe('יפו');
  });
});
