import { buildProductSearchText, expandTerms, normalizeSearchText, tokenizeQuery } from './search-text.js';

describe('normalizeSearchText', () => {
  it('drops geresh and quotes so spelling variants meet', () => {
    expect(normalizeSearchText('שז׳לונג')).toBe('שזלונג');
    expect(normalizeSearchText("שז'לונג")).toBe('שזלונג');
    expect(normalizeSearchText('מק״ט')).toBe('מקט');
  });

  it('splits hyphenated and maqaf words', () => {
    expect(normalizeSearchText('תלת-מושבית')).toBe('תלת מושבית');
    expect(normalizeSearchText('תלת־מושבית')).toBe('תלת מושבית');
  });

  it('lower-cases English and removes niqqud', () => {
    expect(normalizeSearchText('ALBA-300')).toBe('alba 300');
    expect(normalizeSearchText('סָפָּה')).toBe('ספה');
  });
});

describe('tokenizeQuery', () => {
  it('drops one-letter terms and duplicates', () => {
    expect(tokenizeQuery('ספה ו ספה פינתית')).toEqual(['ספה', 'פינתית']);
  });
});

describe('buildProductSearchText', () => {
  it('joins model name, Hebrew content, labels and SKUs', () => {
    const text = buildProductSearchText({
      modelName: 'ALBA',
      nameHe: 'ספה פינתית אלבה',
      descriptionHe: 'ישיבה עמוקה',
      categoryNamesHe: ['ספות', 'ספות פינתיות'],
      attributeLabelsHe: ['בז׳', 'בז׳', 'אריג'],
      skus: ['ALB-300-BG-R'],
    });
    expect(text).toBe('alba ספה פינתית אלבה ספות ספות פינתיות בז אריג alb 300 bg r ישיבה עמוקה');
  });
});

describe('expandTerms', () => {
  it('adds every term of a matching synonym group', () => {
    expect(expandTerms(['כורסא'], [['כורסה', 'כורסא', 'armchair']])).toEqual([
      [
        { text: 'כורסא', weight: 1 },
        { text: 'כורסה', weight: 0.9 },
        { text: 'armchair', weight: 0.9 },
      ],
    ]);
  });

  it('also tries the word without one or two Hebrew prefixes, at a lower weight', () => {
    const [alternatives] = expandTerms(['והספה'], [['ספה', 'sofa']]);
    expect(alternatives).toEqual([
      { text: 'והספה', weight: 1 },
      { text: 'הספה', weight: 0.7 },
      { text: 'ספה', weight: 0.7 },
      { text: 'sofa', weight: 0.7 },
    ]);
  });

  it('never strips a word below three letters', () => {
    expect(expandTerms(['הדום'], [])[0].map((a) => a.text)).toEqual(['הדום', 'דום']);
    expect(expandTerms(['בית'], [])[0].map((a) => a.text)).toEqual(['בית']);
    expect(expandTerms(['alba'], [])[0].map((a) => a.text)).toEqual(['alba']);
  });
});
