import { ErrorHandler, REQUEST } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { configureReporting } from './server-log';
import { ServerErrorHandler } from './ssr-error-handler';

function setUp(request: Request | null) {
  TestBed.configureTestingModule({
    providers: [
      { provide: ErrorHandler, useClass: ServerErrorHandler },
      { provide: REQUEST, useValue: request },
    ],
  });
  return TestBed.inject(ErrorHandler);
}

describe('ServerErrorHandler', () => {
  let lines: string[];
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    lines = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchSpy);
    configureReporting({ apiUrl: 'http://api.test', internalToken: 'tok-for-test' });
  });

  afterEach(() => {
    configureReporting({ apiUrl: '', internalToken: '' });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('logs one scrubbed JSON line and reports the render error with the path only, never rethrowing', () => {
    const handler = setUp(new Request('https://shop.test/product/alba?t=sentinelOrderTok&q=1'));
    expect(() => handler.handleError(new Error('render failed for sentinel.user@example.test'))).not.toThrow();

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(record).toMatchObject({ level: 'error', msg: 'render failed for [email]', path: '/product/alba' });
    expect(lines[0]).not.toContain('sentinelOrderTok');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api.test/api/internal/error-events');
    const body = JSON.parse(String(init.body)) as Record<string, string>;
    expect(body).toMatchObject({ kind: 'error', path: '/product/alba', message: 'render failed for [email]' });
    expect(String(init.body)).not.toContain('sentinelOrderTok');
  });

  it('names an HttpErrorResponse-like value by its name and message', () => {
    const handler = setUp(new Request('https://shop.test/category/sofas'));
    handler.handleError({ name: 'HttpErrorResponse', message: 'Http failure response: 500 Internal Server Error' });
    expect(JSON.parse(lines[0])).toMatchObject({
      msg: 'HttpErrorResponse: Http failure response: 500 Internal Server Error',
      path: '/category/sofas',
    });
    const body = JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body)) as Record<
      string,
      string
    >;
    expect(body['message']).toBe('HttpErrorResponse: Http failure response: 500 Internal Server Error');
  });

  it('falls back to "/" without a request, and survives a value that is not an Error', () => {
    const handler = setUp(null);
    expect(() => handler.handleError('plain text failure')).not.toThrow();
    expect(JSON.parse(lines[0])).toMatchObject({ msg: 'plain text failure', path: '/' });
    const body = JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body)) as Record<
      string,
      string
    >;
    expect(body['path']).toBe('/');
  });
});
