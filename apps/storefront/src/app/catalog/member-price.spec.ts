import { memberPriceView } from './member-price';

describe('memberPriceView', () => {
  it('shows the regular price only while the viewer is unknown (server render)', () => {
    expect(memberPriceView(100_000, null, 90_000, null)).toEqual({
      main: 100_000,
      struck: null,
      memberLine: null,
      joinLink: false,
    });
  });

  it('gives a guest the regular price and a member hint line with a join link', () => {
    expect(memberPriceView(100_000, null, 90_000, false)).toEqual({
      main: 100_000,
      struck: null,
      memberLine: { kind: 'guest', price: 90_000 },
      joinLink: true,
    });
  });

  it('keeps the sale as it is for a guest', () => {
    const v = memberPriceView(80_000, 100_000, 70_000, false);
    expect(v).toMatchObject({ main: 80_000, struck: 100_000, memberLine: { kind: 'guest', price: 70_000 } });
  });

  it('makes the member price the main price for a member and strikes the regular price', () => {
    expect(memberPriceView(100_000, null, 90_000, true)).toEqual({
      main: 90_000,
      struck: 100_000,
      memberLine: { kind: 'member' },
      joinLink: false,
    });
  });

  it('member on sale: main = member price, struck = the current (sale) price', () => {
    expect(memberPriceView(80_000, 100_000, 70_000, true)).toMatchObject({ main: 70_000, struck: 80_000 });
  });

  it('no member price (or not lower): nothing changes for anybody', () => {
    for (const viewer of [null, false, true]) {
      expect(memberPriceView(100_000, 120_000, null, viewer)).toEqual({
        main: 100_000,
        struck: 120_000,
        memberLine: null,
        joinLink: false,
      });
    }
    expect(memberPriceView(100_000, null, 100_000, true).memberLine).toBeNull();
  });
});
