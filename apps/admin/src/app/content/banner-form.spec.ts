import type { AdminBanner } from '@hg/models';
import { bannerInput, emptyBannerForm, toBannerForm, type BannerForm } from './banner-form';

const IMAGE = { id: 7, image: { url: '/media/content/a.webp', altHe: '' } };

const valid = (): BannerForm => ({
  ...emptyBannerForm(),
  nameHe: 'מבצע חורף',
  headlineHe: 'מבצע החורף',
  linkUrl: '/category/sofas',
  image: IMAGE,
  altHe: 'ספה בסלון',
});

describe('banner form', () => {
  it('builds the input with optional fields as null', () => {
    const { input, errors } = bannerInput(valid());
    expect(errors).toEqual({});
    expect(input).toEqual({
      nameHe: 'מבצע חורף',
      headlineHe: 'מבצע החורף',
      sublineHe: null,
      ctaLabelHe: null,
      linkUrl: '/category/sofas',
      imageId: 7,
      mobileImageId: null,
      altHe: 'ספה בסלון',
      active: true,
      startsAt: null,
      endsAt: null,
    });
  });

  it('sends the phone photo when there is one', () => {
    const f = { ...valid(), mobileImage: { id: 9, image: IMAGE.image } };
    expect(bannerInput(f).input?.mobileImageId).toBe(9);
  });

  it('requires name, headline, link, desktop photo and alt text', () => {
    const { input, errors } = bannerInput(emptyBannerForm());
    expect(input).toBeNull();
    expect(Object.keys(errors).sort()).toEqual(['altHe', 'headlineHe', 'image', 'linkUrl', 'nameHe']);
  });

  it('refuses too long optional texts and an end before the start', () => {
    const f = {
      ...valid(),
      sublineHe: 'א'.repeat(161),
      ctaLabelHe: 'ב'.repeat(31),
      startDate: '2026-12-10',
      endDate: '2026-12-01',
    };
    const { input, errors } = bannerInput(f);
    expect(input).toBeNull();
    expect(Object.keys(errors).sort()).toEqual(['ctaLabelHe', 'endDate', 'sublineHe']);
  });

  it('sends whole Israel days', () => {
    const f = { ...valid(), startDate: '2026-12-01', endDate: '2026-12-31' };
    const { input } = bannerInput(f);
    expect(input?.startsAt).toBeTruthy();
    expect(Date.parse(input!.endsAt!)).toBeGreaterThan(Date.parse(input!.startsAt!));
  });

  it('fills the form from a saved banner', () => {
    const b: AdminBanner = {
      id: 3,
      nameHe: 'ש',
      headlineHe: 'כ',
      sublineHe: null,
      ctaLabelHe: 'לחנות',
      linkUrl: '/x',
      imageId: 7,
      image: IMAGE.image,
      mobileImageId: null,
      mobileImage: null,
      altHe: 'א',
      active: false,
      startsAt: null,
      endsAt: null,
      createdAt: '2026-11-17T10:00:00.000Z',
      updatedAt: '2026-11-17T10:00:00.000Z',
    };
    const f = toBannerForm(b);
    expect(f.image?.id).toBe(7);
    expect(f.mobileImage).toBeNull();
    expect(f.sublineHe).toBe('');
    expect(f.active).toBe(false);
  });
});
