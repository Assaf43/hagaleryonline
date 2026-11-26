import { configureReporting } from './server-log';
import { serverErrorHandler } from './server-error';

function fakeRes(headersSent = false) {
  return {
    headersSent,
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    send(body: string) {
      this.body = body;
      return this;
    },
  };
}

describe('serverErrorHandler', () => {
  afterEach(() => {
    configureReporting({ apiUrl: '', internalToken: '' });
    vi.restoreAllMocks();
  });

  it('logs, reports with the path and answers a generic 500 without the stack', () => {
    configureReporting({ apiUrl: 'http://api.test', internalToken: 'tok-for-test' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const res = fakeRes();
    const next = vi.fn();
    const error = new Error('render exploded');
    serverErrorHandler(error, { originalUrl: '/product/alba?preview=abc' } as never, res as never, next);
    expect(res.statusCode).toBe(500);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.body).toContain('אירעה שגיאה');
    expect(res.body).not.toContain('render exploded');
    expect(res.body).not.toContain(' at ');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)) as Record<string, string>;
    expect(body['path']).toBe('/product/alba');
    expect(body['message']).toBe('render exploded');
    expect(next).not.toHaveBeenCalled();
  });

  it('hands over to Express when the headers are already sent', () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const next = vi.fn();
    const error = new Error('late');
    serverErrorHandler(error, { originalUrl: '/' } as never, fakeRes(true) as never, next);
    expect(next).toHaveBeenCalledWith(error);
  });
});
