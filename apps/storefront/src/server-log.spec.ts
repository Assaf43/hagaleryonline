import { configureReporting, logJson, reportServerError } from './server-log';

function captureStdout() {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
}

describe('logJson', () => {
  it('writes one JSON line with level, time and message', () => {
    const out = captureStdout();
    try {
      logJson('info', 'listening', { port: 4000 });
    } finally {
      out.restore();
    }
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0].endsWith('\n')).toBe(true);
    const record = JSON.parse(out.lines[0]) as Record<string, unknown>;
    expect(record).toMatchObject({ level: 'info', msg: 'listening', port: 4000 });
    expect(typeof record['time']).toBe('string');
  });

  it('scrubs the message and every field', () => {
    const out = captureStdout();
    try {
      logJson('error', 'failed for sentinel.user@example.test', {
        path: '/order/5001?t=abcdefabcdefabcdefabcdef12345678',
        password: 'hunter2',
        phone: '054-1234567',
      });
    } finally {
      out.restore();
    }
    const line = out.lines[0];
    for (const bad of ['sentinel.user', '@example', 'abcdefabcdef', 'hunter2', '1234567']) {
      expect(line).not.toContain(bad);
    }
  });
});

describe('reportServerError', () => {
  afterEach(() => {
    configureReporting({ apiUrl: '', internalToken: '' });
    vi.restoreAllMocks();
  });

  it('does nothing without a token', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    configureReporting({ apiUrl: 'http://api.test', internalToken: '' });
    reportServerError(new Error('x'), '/a');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts the scrubbed error with the token, a timeout and the path without its query', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    configureReporting({ apiUrl: 'http://api.test', internalToken: 'tok-for-test' });
    reportServerError(
      new Error('boom for sentinel.user@example.test'),
      '/order/5001?t=abcdefabcdefabcdefabcdef12345678',
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api.test/api/internal/error-events');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Internal-Token']).toBe('tok-for-test');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(init.body)) as Record<string, string>;
    expect(body['kind']).toBe('error');
    expect(body['path']).toBe('/order/5001');
    expect(JSON.stringify(body)).not.toContain('sentinel.user');
    expect(body['stack']).toContain('Error');
  });

  it('never throws, even when fetch fails or throws', async () => {
    configureReporting({ apiUrl: 'http://api.test', internalToken: 'tok-for-test' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    expect(() => reportServerError('plain string', '/a')).not.toThrow();
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('sync');
    });
    expect(() => reportServerError(new Error('x'), '/a')).not.toThrow();
    await Promise.resolve();
  });
});
