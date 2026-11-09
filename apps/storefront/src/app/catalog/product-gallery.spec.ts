import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageRef } from '@hg/models';
import { ProductGallery } from './product-gallery';

const imgs = (...names: string[]): ImageRef[] => names.map((n) => ({ url: `/media/${n}.webp`, altHe: `alt ${n}` }));

describe('ProductGallery', () => {
  let fixture: ComponentFixture<ProductGallery>;
  const el = () => fixture.nativeElement as HTMLElement;

  async function setup(images: ImageRef[]) {
    fixture = TestBed.createComponent(ProductGallery);
    document.body.appendChild(fixture.nativeElement); // focus only works on attached elements
    showDesktop.textContent = '.desktop { display: grid !important; }'; // jsdom: hidden buttons cannot take focus
    document.head.appendChild(showDesktop);
    fixture.componentRef.setInput('images', images);
    fixture.componentRef.setInput('label', 'ספה אלבה');
    fixture.detectChanges();
    await fixture.whenStable();
  }
  const update = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
  };
  const thumbs = () => Array.from(el().querySelectorAll<HTMLButtonElement>('.thumb'));
  const mainSrc = () => el().querySelector('.main img')?.getAttribute('src');
  const key = (target: Element, k: string) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

  const showDesktop = document.createElement('style');

  beforeEach(() => {
    document.documentElement.dir = 'ltr';
  });
  afterEach(() => {
    showDesktop.remove();
    fixture.nativeElement.remove();
    document.documentElement.dir = '';
  });

  it('clicking a thumbnail shows that photo and sets aria-current', async () => {
    await setup(imgs('a', 'b', 'c'));
    expect(mainSrc()).toBe('/media/a.webp');
    expect(thumbs()[0].getAttribute('aria-current')).toBe('true');
    thumbs()[2].click();
    await update();
    expect(mainSrc()).toBe('/media/c.webp');
    expect(thumbs()[2].getAttribute('aria-current')).toBe('true');
    expect(thumbs()[0].getAttribute('aria-current')).toBeNull();
  });

  it('opening full screen and pressing ArrowLeft/ArrowRight moves in reading order', async () => {
    document.documentElement.dir = 'rtl';
    await setup(imgs('a', 'b', 'c'));
    el().querySelector<HTMLButtonElement>('.main')!.click();
    await update();
    const dialog = el().querySelector('dialog')!;
    const shown = () => dialog.querySelector('img')?.getAttribute('src');
    expect(shown()).toBe('/media/a.webp');
    key(dialog, 'ArrowLeft'); // RTL: left = next
    await update();
    expect(shown()).toBe('/media/b.webp');
    key(dialog, 'ArrowRight'); // previous
    await update();
    expect(shown()).toBe('/media/a.webp');

    document.documentElement.dir = 'ltr';
    key(dialog, 'ArrowRight'); // LTR: right = next
    await update();
    expect(shown()).toBe('/media/b.webp');
  });

  it('Escape closes the dialog and returns focus to the main photo', async () => {
    await setup(imgs('a', 'b'));
    const main = el().querySelector<HTMLButtonElement>('.main')!;
    main.focus();
    main.click();
    await update();
    const dialog = el().querySelector('dialog')!;
    expect(dialog.hasAttribute('open')).toBe(true);
    key(dialog, 'Escape');
    await update();
    expect(dialog.hasAttribute('open')).toBe(false);
    expect(el().querySelector('dialog img')).toBeNull();
    expect(document.activeElement).toBe(main);
  });

  it('changing images resets to the first photo', async () => {
    await setup(imgs('a', 'b', 'c'));
    thumbs()[1].click();
    await update();
    expect(mainSrc()).toBe('/media/b.webp');
    fixture.componentRef.setInput('images', imgs('x', 'y'));
    await update();
    expect(mainSrc()).toBe('/media/x.webp');
    expect(thumbs()[0].getAttribute('aria-current')).toBe('true');
  });

  it('no images renders the placeholder and no img', async () => {
    await setup([]);
    expect(el().querySelector('.placeholder')).not.toBeNull();
    expect(el().querySelector('img')).toBeNull();
  });

  it('a new array with the same photos keeps the chosen one', async () => {
    await setup(imgs('a', 'b', 'c'));
    thumbs()[2].click();
    await update();
    fixture.componentRef.setInput('images', imgs('a', 'b', 'c'));
    await update();
    expect(mainSrc()).toBe('/media/c.webp');
  });

  it('scrolls the swipe track to the current photo, negative in RTL', async () => {
    document.documentElement.dir = 'rtl';
    await setup(imgs('a', 'b', 'c'));
    const track = el().querySelector<HTMLElement>('.track')!;
    Object.defineProperty(track, 'clientWidth', { value: 300, configurable: true });
    const scrollTo = vi.fn();
    track.scrollTo = scrollTo as unknown as typeof track.scrollTo;
    thumbs()[2].click();
    await update();
    expect(scrollTo).toHaveBeenLastCalledWith({ left: -600, behavior: 'instant' });
    track.scrollLeft = -600; // where the swipe left it
    fixture.componentRef.setInput('images', imgs('x', 'y'));
    await update();
    expect(scrollTo.mock.lastCall![0].left + 0).toBe(0);
  });

  it('does not cut a swipe short, but programmatic changes still scroll the track', async () => {
    await setup(imgs('a', 'b', 'c'));
    const track = el().querySelector<HTMLElement>('.track')!;
    Object.defineProperty(track, 'clientWidth', { value: 300, configurable: true });
    const scrollTo = vi.fn();
    track.scrollTo = scrollTo as unknown as typeof track.scrollTo;
    track.scrollLeft = 180; // 0.6 of a photo: past halfway mid-gesture
    track.dispatchEvent(new Event('scroll'));
    await update();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(thumbs()[1].getAttribute('aria-current')).toBe('true');
    thumbs()[0].click();
    await update();
    expect(scrollTo).toHaveBeenCalledWith({ left: 0, behavior: 'instant' });
  });

  it('moves focus to the close button when full screen opens', async () => {
    await setup(imgs('a', 'b'));
    el().querySelector<HTMLButtonElement>('.main')!.click();
    await update();
    await update();
    expect(document.activeElement).toBe(el().querySelector('dialog .close'));
  });
});
