import { CSP_NONCE, DOCUMENT, REQUEST_CONTEXT } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { applyCspNonce, provideCspNonce } from './csp-nonce';

describe('provideCspNonce', () => {
  function nonceFor(context: unknown) {
    TestBed.configureTestingModule({ providers: [{ provide: REQUEST_CONTEXT, useValue: context }, provideCspNonce()] });
    return TestBed.inject(CSP_NONCE);
  }

  it('reads the nonce from the request context', () => expect(nonceFor({ cspNonce: 'abc==' })).toBe('abc=='));

  it('is null without a context or a string nonce', () => {
    expect(nonceFor(null)).toBeNull();
    TestBed.resetTestingModule();
    expect(nonceFor({ cspNonce: 42 })).toBeNull();
  });
});

describe('applyCspNonce', () => {
  afterEach(() => {
    document.getElementById('ng-event-dispatch-contract')?.remove();
    document.querySelector('hg-root')?.remove();
  });

  function run(nonce: string | null) {
    const script = document.createElement('script');
    script.id = 'ng-event-dispatch-contract';
    document.body.append(script, document.createElement('hg-root'));
    TestBed.configureTestingModule({ providers: [{ provide: CSP_NONCE, useValue: nonce }] });
    TestBed.runInInjectionContext(() => applyCspNonce());
    const doc = TestBed.inject(DOCUMENT);
    return { script: doc.getElementById('ng-event-dispatch-contract')!, root: doc.querySelector('hg-root')! };
  }

  it('puts the nonce on the event-dispatch script the build inlines into index.html', () => {
    expect(run('abc==').script.getAttribute('nonce')).toBe('abc==');
  });

  it('marks the app root with ngCspNonce for the browser', () => {
    expect(run('abc==').root.getAttribute('ngCspNonce')).toBe('abc==');
  });

  it('changes nothing without a nonce', () => {
    const { script, root } = run(null);
    expect(script.hasAttribute('nonce')).toBe(false);
    expect(root.hasAttribute('ngCspNonce')).toBe(false);
  });
});
