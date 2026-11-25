import { CSP_NONCE, DOCUMENT, Provider, REQUEST_CONTEXT, inject } from '@angular/core';

/**
 * NFR-07: the per-request nonce from security-headers.ts, which server.ts passes as the request context. Angular
 * puts it on the <style> tags and the event-replay script it renders on the server.
 */
export function provideCspNonce(): Provider {
  return {
    provide: CSP_NONCE,
    useFactory: () => {
      const nonce = (inject(REQUEST_CONTEXT, { optional: true }) as { cspNonce?: unknown } | null)?.cspNonce;
      return typeof nonce === 'string' ? nonce : null;
    },
  };
}

/**
 * Runs at server bootstrap with the request's nonce:
 * - the build inlines the event-dispatch contract script into index.html without a nonce and Angular does not add
 *   one, so the policy would block it (and event replay before hydration with it);
 * - `ngCspNonce` on the app root is where Angular in the browser reads its CSP_NONCE, so the <style> tags it adds
 *   for components loaded after hydration carry the nonce too.
 */
export function applyCspNonce(): void {
  const nonce = inject(CSP_NONCE, { optional: true });
  if (!nonce) return;
  const doc = inject(DOCUMENT);
  doc.getElementById('ng-event-dispatch-contract')?.setAttribute('nonce', nonce);
  doc.querySelector('hg-root')?.setAttribute('ngCspNonce', nonce);
}
