import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { StickyBuyBar } from './sticky-buy-bar';

type Callback = (entries: Partial<IntersectionObserverEntry>[]) => void;

class FakeObserver {
  static last: FakeObserver | null = null;
  readonly observed: Element[] = [];
  disconnected = false;
  constructor(
    readonly callback: Callback,
    readonly options?: IntersectionObserverInit,
  ) {
    FakeObserver.last = this;
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  /** `top`: the button's top edge relative to the viewport (negative = scrolled above it). */
  fire(isIntersecting: boolean, top: number) {
    const boundingClientRect = { top } as DOMRectReadOnly;
    this.callback([{ isIntersecting, boundingClientRect, target: this.observed[0] }]);
  }
}

@Component({
  imports: [StickyBuyBar],
  template: `
    <button #main type="button">main</button>
    <hg-sticky-buy-bar
      [target]="main"
      [price]="459000"
      [disabled]="disabled()"
      [error]="error()"
      (buy)="bought = bought + 1"
    />
  `,
})
class Host {
  readonly disabled = signal(false);
  readonly error = signal('');
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

  it('on phones it shows only after the main button scrolled above the view', async () => {
    mockMedia(true);
    const { fixture, el, bar } = await setup();
    expect(FakeObserver.last?.observed[0]).toBe(el.querySelector('button'));
    expect(FakeObserver.last?.options?.rootMargin).toMatch(/^-\d+px 0px 0px 0px$/);
    expect(bar()).toBeNull();

    // Still below the fold: the main button is ahead, no bar.
    FakeObserver.last!.fire(false, 900);
    fixture.detectChanges();
    expect(bar()).toBeNull();

    FakeObserver.last!.fire(false, -50);
    fixture.detectChanges();
    expect(bar()).not.toBeNull();
    expect(bar()!.textContent).toContain('4,590 ₪');
    const btn = bar()!.querySelector<HTMLButtonElement>('button')!;
    expect(btn.textContent?.trim()).toBe('הוספה לסל');
    btn.click();
    expect(fixture.componentInstance.bought).toBe(1);

    FakeObserver.last!.fire(true, 100);
    fixture.detectChanges();
    expect(bar()).toBeNull();

    FakeObserver.last!.fire(false, 900);
    fixture.detectChanges();
    expect(bar()).toBeNull();
  });

  it('reserves the bar height at the page bottom only while the bar is shown', async () => {
    mockMedia(true);
    const { fixture, bar } = await setup();
    const reserved = () => document.body.classList.contains('has-sticky-buy-bar');
    expect(reserved()).toBe(false);
    FakeObserver.last!.fire(false, -50);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(bar()).not.toBeNull();
    expect(reserved()).toBe(true);
    FakeObserver.last!.fire(true, 100);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(reserved()).toBe(false);
    FakeObserver.last!.fire(false, -50);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(reserved()).toBe(true);
    fixture.destroy();
    expect(reserved()).toBe(false);
  });

  it('shows the error of a failed add', async () => {
    mockMedia(true);
    const { fixture, bar } = await setup();
    FakeObserver.last!.fire(false, -50);
    fixture.detectChanges();
    expect(bar()!.querySelector('[role="alert"]')).toBeNull();
    fixture.componentInstance.error.set('לא הצלחנו להוסיף לסל. נסו שוב.');
    fixture.detectChanges();
    expect(bar()!.querySelector('[role="alert"]')?.textContent?.trim()).toBe('לא הצלחנו להוסיף לסל. נסו שוב.');
  });

  it('is never shown on desktop', async () => {
    mockMedia(false);
    const { fixture, bar } = await setup();
    FakeObserver.last?.fire(false, -50);
    fixture.detectChanges();
    expect(bar()).toBeNull();
  });

  it('a disabled bar says "אזל מהמלאי"', async () => {
    mockMedia(true);
    const { fixture, bar } = await setup();
    fixture.componentInstance.disabled.set(true);
    FakeObserver.last!.fire(false, -50);
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
