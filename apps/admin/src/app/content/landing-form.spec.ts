import type { AdminLandingPage } from '@hg/models';
import { emptyLandingForm, endedLinkAllowed, landingInput, toLandingForm, type LandingForm } from './landing-form';

const IMAGE = { id: 7, image: { url: '/media/content/a.webp', altHe: '' } };

const valid = (): LandingForm => ({
  ...emptyLandingForm(),
  slug: 'winter-sale',
  titleHe: 'מבצע חורף',
  introHtml: '<h2>חם בסלון</h2><p>בחרנו בשבילכם</p>',
  image: IMAGE,
  altHe: 'ספה בסלון',
});

describe('landing form', () => {
  it('builds the input with optional fields as null and the ended link as typed', () => {
    const { input, errors } = landingInput(valid());
    expect(errors).toEqual({});
    expect(input).toEqual({
      slug: 'winter-sale',
      titleHe: 'מבצע חורף',
      sublineHe: null,
      introHtml: '<h2>חם בסלון</h2><p>בחרנו בשבילכם</p>',
      outroHtml: null,
      imageId: 7,
      mobileImageId: null,
      altHe: 'ספה בסלון',
      source: { kind: 'bestsellers' },
      status: 'draft',
      startsAt: null,
      endsAt: null,
      endedLinkUrl: '/',
      metaDescriptionHe: null,
      noindex: false,
    });
  });

  it('requires address, title, opening text, photo and alt text', () => {
    const { input, errors } = landingInput(emptyLandingForm());
    expect(input).toBeNull();
    expect(Object.keys(errors).sort()).toEqual(['altHe', 'image', 'introHtml', 'slug', 'titleHe']);
  });

  it('refuses a bad address and an empty rich text', () => {
    const f = { ...valid(), slug: 'Winter Sale', introHtml: '<p> </p>' };
    expect(Object.keys(landingInput(f).errors).sort()).toEqual(['introHtml', 'slug']);
  });

  it('requires a chosen source and at least one manual product', () => {
    expect(landingInput({ ...valid(), source: { kind: 'category', id: 0 } }).errors.source).toBeTruthy();
    expect(landingInput({ ...valid(), source: { kind: 'manual', productIds: [] } }).errors.source).toBeTruthy();
    expect(landingInput({ ...valid(), source: { kind: 'manual', productIds: [3] } }).errors.source).toBeUndefined();
  });

  it('turns an empty closing text into null and keeps a real one', () => {
    expect(landingInput({ ...valid(), outroHtml: '<p></p>' }).input?.outroHtml).toBeNull();
    expect(landingInput({ ...valid(), outroHtml: '<p>עד גמר המלאי</p>' }).input?.outroHtml).toBe('<p>עד גמר המלאי</p>');
  });

  it('accepts only a site path or https for the ended link', () => {
    expect(endedLinkAllowed('/category/sofas')).toBe(true);
    expect(endedLinkAllowed('https://example.com/x')).toBe(true);
    for (const bad of ['//evil.com', 'http://example.com', 'mailto:a@b.co', 'javascript:alert(1)', 'sofas'])
      expect(endedLinkAllowed(bad)).toBe(false);
    expect(landingInput({ ...valid(), endedLinkUrl: 'mailto:a@b.co' }).errors.endedLinkUrl).toBeTruthy();
    expect(landingInput({ ...valid(), endedLinkUrl: '  ' }).input?.endedLinkUrl).toBeNull();
  });

  it('sends Israel-day dates and refuses an end before the start', () => {
    const ok = landingInput({ ...valid(), status: 'published', startDate: '2026-12-01', endDate: '2026-12-31' });
    expect(ok.input?.startsAt).toBe('2026-11-30T22:00:00.000Z');
    expect(ok.input?.endsAt).toBe('2026-12-31T21:59:59.999Z');
    expect(landingInput({ ...valid(), startDate: '2026-12-31', endDate: '2026-12-01' }).errors.endDate).toBeTruthy();
  });

  it('round-trips a stored page into the form', () => {
    const page = {
      id: 3,
      slug: 'winter-sale',
      titleHe: 'מבצע חורף',
      sublineHe: 'ספות חמות',
      introHtml: '<p>x</p>',
      outroHtml: null,
      imageId: 7,
      image: IMAGE.image,
      mobileImageId: 9,
      mobileImage: IMAGE.image,
      altHe: 'ספה',
      source: { kind: 'room', id: 2 },
      status: 'published',
      state: 'live',
      startsAt: '2026-11-30T22:00:00.000Z',
      endsAt: '2026-12-31T21:59:59.999Z',
      endedLinkUrl: '/room/living',
      metaDescriptionHe: null,
      noindex: true,
      unavailable: { productIds: [], source: false },
      sourceLink: '/room/living',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
    } as AdminLandingPage;
    const f = toLandingForm(page);
    expect(f.startDate).toBe('2026-12-01');
    expect(f.endDate).toBe('2026-12-31');
    expect(f.mobileImage?.id).toBe(9);
    const { input } = landingInput(f);
    expect(input?.startsAt).toBe(page.startsAt);
    expect(input?.endsAt).toBe(page.endsAt);
    expect(input?.noindex).toBe(true);
    expect(input?.endedLinkUrl).toBe('/room/living');
  });
});
