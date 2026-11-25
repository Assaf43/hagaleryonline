import { TestBed } from '@angular/core/testing';
import { AuthService } from '../core/auth.service';
import { HomePage } from './home.page';

describe('HomePage', () => {
  it('has no leftover "next step" line', () => {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: AuthService,
          useValue: { me: () => ({ name: 'בעלת העסק', permissions: [] }), isSuperAdmin: () => false },
        },
      ],
    });
    const fixture = TestBed.createComponent(HomePage);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('בשלב הבא');
  });
});
