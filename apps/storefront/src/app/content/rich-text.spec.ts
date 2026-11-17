import { TestBed } from '@angular/core/testing';
import { RichText } from './rich-text';

describe('RichText', () => {
  it('renders HTML and the Angular sanitizer still removes scripts', () => {
    const fixture = TestBed.createComponent(RichText);
    fixture.componentRef.setInput('html', '<p>שלום <strong>עולם</strong></p><script>window.x=1</script>');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('p strong')?.textContent).toBe('עולם');
    expect(el.querySelector('script')).toBeNull();
  });
});
