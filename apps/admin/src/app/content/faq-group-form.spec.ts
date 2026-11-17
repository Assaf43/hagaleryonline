import { faqGroupInput, moveItem, type FaqGroupDraft } from './faq-group-form.page';

const draft = (): FaqGroupDraft => ({
  titleHe: 'משלוחים',
  sortOrder: '0',
  published: true,
  items: [
    { key: 1, id: 10, questionHe: 'א', answerHtml: '<p>1</p>', published: true },
    { key: 2, questionHe: 'ב', answerHtml: '<p>2</p>', published: false },
    { key: 3, id: 12, questionHe: 'ג', answerHtml: '<p>3</p>', published: true },
  ],
});

describe('FAQ group form', () => {
  it('moves an item up or down and ignores the ends', () => {
    expect(moveItem([1, 2, 3], 1, -1)).toEqual([2, 1, 3]);
    expect(moveItem([1, 2, 3], 1, 1)).toEqual([1, 3, 2]);
    expect(moveItem([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
    expect(moveItem([1, 2, 3], 2, 1)).toEqual([1, 2, 3]);
  });

  it('sends the items in list order, with ids only for existing ones', () => {
    const d = draft();
    d.items = moveItem(d.items, 2, -1);
    const { input } = faqGroupInput(d);
    expect(input?.items.map((i) => i.questionHe)).toEqual(['א', 'ג', 'ב']);
    expect(input?.items.map((i) => i.id)).toEqual([10, 12, undefined]);
    expect(input?.items[2]).not.toHaveProperty('id');
  });

  it('names the item row of a missing question or answer', () => {
    const d = draft();
    d.items[1].questionHe = ' ';
    d.items[2].answerHtml = '';
    const { input, errors } = faqGroupInput(d);
    expect(input).toBeNull();
    expect(Object.keys(errors).sort()).toEqual(['items.1.questionHe', 'items.2.answerHtml']);
  });
});
