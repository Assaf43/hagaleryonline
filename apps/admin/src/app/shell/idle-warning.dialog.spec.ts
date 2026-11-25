import { TestBed } from '@angular/core/testing';
import { MatDialogRef } from '@angular/material/dialog';
import { Router, provideRouter } from '@angular/router';
import { AuthService } from '../core/auth.service';
import { IdleWarningDialog } from './idle-warning.dialog';

describe('IdleWarningDialog', () => {
  const close = vi.fn();
  const load = vi.fn();
  const logout = vi.fn();
  const clear = vi.fn();
  let navigate: ReturnType<typeof vi.spyOn>;

  async function render() {
    const fixture = TestBed.createComponent(IdleWarningDialog);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  const button = (el: HTMLElement, label: string) =>
    [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(label)) as HTMLButtonElement;

  beforeEach(() => {
    close.mockReset();
    load.mockReset().mockResolvedValue({ id: 1 });
    logout.mockReset().mockResolvedValue(undefined);
    clear.mockReset();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: MatDialogRef, useValue: { close } },
        { provide: AuthService, useValue: { load, logout, clear } },
      ],
    });
    navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
  });

  it('says the connection ends in five minutes, with the number isolated', async () => {
    const el = await render();
    expect(el.querySelector('h2')?.textContent).toContain('החיבור עומד להסתיים');
    expect(el.querySelector('p')?.textContent).toContain('בעוד 5 דקות החיבור יסתיים.');
    expect(el.querySelector('p bdi')?.textContent).toBe('5');
  });

  it('"המשך עבודה" asks the server for the session (which touches it) and closes', async () => {
    const el = await render();
    button(el, 'המשך עבודה').click();
    await vi.waitFor(() => expect(close).toHaveBeenCalled());
    expect(load).toHaveBeenCalledWith(true);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('"המשך עבודה" with an already-ended session goes to the login page', async () => {
    load.mockResolvedValue(null);
    const el = await render();
    button(el, 'המשך עבודה').click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/login?reason=idle'));
  });

  it('"התנתקות" logs out and goes to the login page', async () => {
    const el = await render();
    button(el, 'התנתקות').click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/login'));
    expect(logout).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });
});
