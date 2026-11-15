import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { SUPPORT_LIMITS } from '@hg/models';
import { PHOTO_TOO_MANY_HE, PhotoPicker, checkPhotos, photoBadTypeHe, photoTooBigHe } from './photo-picker';

const file = (name: string, type = 'image/jpeg', size = 1000) => {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};

describe('checkPhotos (SRV-03)', () => {
  it('accepts JPEG, PNG and WebP up to 10 MB', () => {
    const photos = [
      file('a.jpg'),
      file('b.png', 'image/png'),
      file('c.webp', 'image/webp', SUPPORT_LIMITS.photoMaxBytes),
    ];
    expect(checkPhotos([], photos)).toEqual({ accepted: photos, problem: '' });
  });

  it('refuses a file over 10 MB, naming it', () => {
    const big = file('big.jpg', 'image/jpeg', SUPPORT_LIMITS.photoMaxBytes + 1);
    expect(checkPhotos([], [big, file('ok.jpg')])).toEqual({
      accepted: [expect.objectContaining({ name: 'ok.jpg' })],
      problem: photoTooBigHe('big.jpg'),
    });
  });

  it.each(['image/gif', 'application/pdf', 'image/heic', ''])('refuses the type "%s"', (type) => {
    expect(checkPhotos([], [file('x.bin', type)])).toEqual({ accepted: [], problem: photoBadTypeHe('x.bin') });
  });

  it('allows at most 5 photos in total', () => {
    const current = [1, 2, 3, 4].map((n) => file(`p${n}.jpg`));
    const result = checkPhotos(current, [file('a.jpg'), file('b.jpg')]);
    expect(result.accepted.map((f) => f.name)).toEqual(['a.jpg']);
    expect(result.problem).toBe(PHOTO_TOO_MANY_HE);
  });
});

describe('PhotoPicker', () => {
  let fixture: ComponentFixture<PhotoPicker>;
  let emitted: File[][];
  let created: string[];
  let revoked: string[];
  const el = () => fixture.nativeElement as HTMLElement;
  const input = () => el().querySelector<HTMLInputElement>('input[type="file"]')!;
  const pick = (...files: File[]) => {
    Object.defineProperty(input(), 'files', { value: files, configurable: true });
    input().dispatchEvent(new Event('change'));
    fixture.detectChanges();
  };

  beforeEach(() => {
    created = [];
    revoked = [];
    URL.createObjectURL = vi.fn((f: Blob) => {
      const url = `blob:test/${(f as File).name}`;
      created.push(url);
      return url;
    });
    URL.revokeObjectURL = vi.fn((u: string) => void revoked.push(u));
    emitted = [];
    fixture = TestBed.createComponent(PhotoPicker);
    document.body.appendChild(fixture.nativeElement);
    fixture.componentInstance.photosChange.subscribe((f) => emitted.push(f));
    fixture.detectChanges();
  });

  afterEach(() => fixture.nativeElement.remove());

  it('is a labelled file input that lets a phone offer its camera', () => {
    expect(input().getAttribute('accept')).toBe('image/*');
    expect(input().multiple).toBe(true);
    expect(el().querySelector('label')!.getAttribute('for')).toBe(input().id);
    expect(el().textContent).toContain('עד 5 תמונות מסוג JPEG, PNG או WebP, עד 10MB כל אחת');
  });

  it('shows a preview with an accessibly named remove button for each photo', () => {
    pick(file('a.jpg'), file('b.png', 'image/png'));
    expect(el().querySelectorAll('.preview img').length).toBe(2);
    const buttons = [...el().querySelectorAll('.preview button')].map((b) =>
      b.textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(buttons).toEqual(['הסרה של התמונה a.jpg', 'הסרה של התמונה b.png']);
    expect(emitted.at(-1)!.map((f) => f.name)).toEqual(['a.jpg', 'b.png']);
  });

  it('shows type and size errors in an always-rendered alert tied to the input, and uploads nothing wrong', () => {
    const alert = el().querySelector('[role="alert"]')!;
    expect(alert.textContent?.trim()).toBe('');
    pick(file('doc.pdf', 'application/pdf'));
    expect(alert.textContent?.trim()).toBe(photoBadTypeHe('doc.pdf'));
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(input().getAttribute('aria-describedby')).toContain(alert.id);
    expect(el().querySelectorAll('.preview').length).toBe(0);
    expect(emitted).toEqual([]);
  });

  it('refuses a sixth photo', () => {
    pick(...[1, 2, 3, 4, 5].map((n) => file(`p${n}.jpg`)));
    pick(file('six.jpg'));
    expect(el().querySelectorAll('.preview').length).toBe(5);
    expect(el().querySelector('[role="alert"]')!.textContent?.trim()).toBe(PHOTO_TOO_MANY_HE);
  });

  it('removing a photo revokes its preview, tells the form and returns focus to the input', () => {
    pick(file('a.jpg'), file('b.jpg'));
    el().querySelector<HTMLButtonElement>('.preview button')!.click();
    fixture.detectChanges();
    expect(revoked).toEqual(['blob:test/a.jpg']);
    expect(emitted.at(-1)!.map((f) => f.name)).toEqual(['b.jpg']);
    expect(document.activeElement).toBe(input());
  });

  it('revokes every preview when destroyed, and shows an error handed in by the form', () => {
    pick(file('a.jpg'), file('b.jpg'));
    fixture.componentRef.setInput('error', 'יש לצרף 1–5 תמונות');
    fixture.detectChanges();
    expect(el().querySelector('[role="alert"]')!.textContent).toContain('יש לצרף');
    fixture.destroy();
    expect(revoked.sort()).toEqual(['blob:test/a.jpg', 'blob:test/b.jpg']);
  });
});
