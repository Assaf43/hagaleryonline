import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { StickyBuyBar } from './sticky-buy-bar';

type Callback = (entries: Partial<IntersectionObserverEntry>[]) => void;

class FakeObserver {
  static last: FakeObserver | null = null;
  readonly observed: Element[] = [];
  disconnected = false;
  constructor(readonly callback: Callback) {
    FakeObserver.last = this;
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  fire(isIntersecting: boolean) {
    this.callback([{ isIntersecting, target: this.observed[0] }]);
  }
}

@Component({
  imports: [StickyBuyBar],
  template: `
    <button #main type="button">main</button>
    <hg-sticky-buy-bar [target]="main" [price]="459000" [disabled]="disabled()" (buy)="bought = bought + 1" />
  `,
})
class Host {
  readonly disabled = signal(false);
  bought = 0;
}

function mockMedia(mobile: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: mobile,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

describe('StickyBuyBar', () => {
  beforeEach(() => {
    FakeObserver.last = null;
    vi.stubGlobal('IntersectionObserver', FakeObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  async function setup() {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    return { fixture, el, bar: () => el.querySelector('.sticky-bar') };
  }

  it('on phones it shows when the main button leaves the view, and hides when it comes back', async () => {
    mockMedia(true);
    const { fixture, el, bar } = await setup();
    expect(FakeObserver.last?.observed[0]).toBe(el.querySelector('button'));
    expect(bar()).toBeNull();

    FakeObserver.last!.fire(false);
    fixture.detectChanges();
    expect(bar()).not.toBeNull();
    expect(bar()!.textContent).toContain('4,590 ₪');
    const btn = bar()!.querySelector<HTMLButtonElement>('button')!;
    expect(btn.textContent?.trim()).toBe('הוספה לסל');
    btn.click();
    expect(fixture.componentInstance.bought).toBe(1);

    FakeObserver.last!.fire(true);
    fixture.detectChanges();
    expect(bar()).toBeNull();
  });

  it('is never shown on desktop', async () => {
    mockMedia(false);
    const { fixture, bar } = await setup();
    FakeObserver.last?.fire(false);
    fixture.detectChanges();
    expect(bar()).toBeNull();
  });

  it('a disabled bar says "אזל מהמלאי"', async () => {
    mockMedia(true);
    const { fixture, bar } = await setup();
    fixture.componentInstance.disabled.set(true);
    FakeObserver.last!.fire(false);
    fixture.detectChanges();
    const btn = bar()!.querySelector<HTMLButtonElement>('button')!;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent?.trim()).toBe('אזל מהמלאי');
  });

  it('stops observing when destroyed', async () => {
    mockMedia(true);
    const { fixture } = await setup();
    fixture.destroy();
    expect(FakeObserver.last?.disconnected).toBe(true);
  });
});
