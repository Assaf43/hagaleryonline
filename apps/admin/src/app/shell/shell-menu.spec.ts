import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from '../core/auth.service';
import { Shell } from './shell';

describe('Shell menu: תקלות ומצב המערכת', () => {
  const mount = (permissions: string[]) => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: AuthService,
          useValue: {
            me: signal({ permissions, isSuperAdmin: false, idleTimeoutMs: null }),
            isSuperAdmin: signal(false),
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(Shell);
    fixture.detectChanges();
    TestBed.inject(HttpTestingController).match(() => true);
    return fixture.nativeElement as HTMLElement;
  };
  const link = (el: HTMLElement) => el.querySelector('a[href="/system"]');

  it('shows the item with system.view', () => {
    expect(link(mount(['system.view']))?.textContent).toContain('תקלות ומצב המערכת');
  });

  it('hides the item without system.view', () => {
    expect(link(mount(['orders.manage']))).toBeNull();
  });
});
