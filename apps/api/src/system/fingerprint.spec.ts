import { firstFrame, fingerprint, normalizeMessage } from './fingerprint.js';

const stack = (frame: string) => `Error: boom\n    at ${frame}\n    at next (node:internal/x:1:1)`;

describe('fingerprint', () => {
  it('is a SHA-256 hex', () => {
    expect(fingerprint({ kind: 'error', source: 'api', message: 'x' })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('same error, different numbers, same fingerprint', () => {
    const a = fingerprint({ kind: 'error', source: 'api', message: 'Order 100013 not found' });
    const b = fingerprint({ kind: 'error', source: 'api', message: 'Order  200457   not found' });
    expect(a).toBe(b);
    const c = fingerprint({ kind: 'error', source: 'api', message: 'SMS to 054-1234567 failed' });
    const d = fingerprint({ kind: 'error', source: 'api', message: 'SMS to +972 52 765 4321 failed' });
    expect(c).toBe(d);
  });

  it('kind and source are part of the group', () => {
    const base = { message: 'x' } as const;
    const all = new Set([
      fingerprint({ ...base, kind: 'error', source: 'api' }),
      fingerprint({ ...base, kind: 'warn', source: 'api' }),
      fingerprint({ ...base, kind: 'error', source: 'ssr' }),
    ]);
    expect(all.size).toBe(3);
  });

  it('different first frame, different fingerprint', () => {
    const msg = { kind: 'error', source: 'api', message: 'boom' } as const;
    const a = fingerprint({
      ...msg,
      stack: stack('OrdersService.place (/srv/app/dist/src/orders/orders.service.js:10:5)'),
    });
    const b = fingerprint({ ...msg, stack: stack('CartService.add (/srv/app/dist/src/cart/cart.service.js:10:5)') });
    expect(a).not.toBe(b);
  });

  it('line numbers ignored', () => {
    const msg = { kind: 'error', source: 'api', message: 'boom' } as const;
    const a = fingerprint({
      ...msg,
      stack: stack('OrdersService.place (/srv/app/dist/src/orders/orders.service.js:10:5)'),
    });
    const b = fingerprint({
      ...msg,
      stack: stack('OrdersService.place (/srv/app/dist/src/orders/orders.service.js:212:17)'),
    });
    expect(a).toBe(b);
  });

  it('absolute path prefixes ignored', () => {
    const msg = { kind: 'error', source: 'api', message: 'boom' } as const;
    const a = fingerprint({
      ...msg,
      stack: stack('OrdersService.place (/srv/app/dist/src/orders/orders.service.js:10:5)'),
    });
    const b = fingerprint({
      ...msg,
      stack: stack('OrdersService.place (C:\\work\\shop\\dist\\src\\orders\\orders.service.js:11:5)'),
    });
    const c = fingerprint({
      ...msg,
      stack: stack('OrdersService.place (file:///home/ci/build/dist/src/orders/orders.service.js:9:1)'),
    });
    expect(a).toBe(b);
    expect(a).toBe(c);
  });
});

describe('normalizeMessage', () => {
  it('scrubs, turns digits into # and collapses whitespace', () => {
    expect(normalizeMessage('  Order 100013\n not   found ')).toBe('Order ###### not found');
    expect(normalizeMessage('to sentinel.user@example.test')).toBe('to [email]');
  });
});

describe('firstFrame', () => {
  it('takes the first at-line without line, column or absolute path', () => {
    expect(firstFrame(stack('OrdersService.place (/srv/app/dist/src/orders/orders.service.js:10:5)'))).toBe(
      'at OrdersService.place (dist/src/orders/orders.service.js)',
    );
    expect(firstFrame('Error: x\n    at /srv/app/node_modules/pkg/index.js:3:9')).toBe('at node_modules/pkg/index.js');
    expect(
      firstFrame('Error: x\n    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)'),
    ).toBe('at process.processTicksAndRejections (node:internal/process/task_queues)');
  });

  it('is empty without a stack or an at-line', () => {
    expect(firstFrame(undefined)).toBe('');
    expect(firstFrame('Error: no frames')).toBe('');
  });
});
