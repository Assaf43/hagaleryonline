import { ConsoleLogger, InternalServerErrorException, Logger } from '@nestjs/common';
import { AppLogger } from './app-logger.js';
import type { CapturedEvent, ErrorEventsService } from './error-events.service.js';
import { RequestContext } from './request-context.js';

const EMAIL = 'sentinel.user@example.test';

/** Collects what one stream receives while `fn` runs. */
function captureStream(stream: 'stdout' | 'stderr', fn: () => void): string {
  const chunks: string[] = [];
  const spy = vi.spyOn(process[stream], 'write').mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return chunks.join('');
}

function fakeEvents() {
  const captured: CapturedEvent[] = [];
  const events = { capture: vi.fn((e: CapturedEvent) => captured.push(e)) } as unknown as ErrorEventsService;
  return { events, captured };
}

describe('AppLogger', () => {
  const env = { ...process.env };
  /** Nest's default logger instance, put back after the test that replaces it. */
  const nestLogger = (Logger as unknown as { staticInstanceRef: ConsoleLogger }).staticInstanceRef;
  afterEach(() => {
    process.env = { ...env };
    Logger.overrideLogger(nestLogger);
  });

  it('stdout line is scrubbed (JSON mode, an e-mail in the message)', () => {
    process.env.LOG_FORMAT = 'json';
    const logger = new AppLogger();
    const out = captureStream('stdout', () =>
      logger.log(`Order mail to ${EMAIL} with ?t=abc123 and {"password":"hunter2"}`, { otp: '123456', note: EMAIL }),
    );
    const lines = out.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(out).not.toContain('@example.test');
    expect(out).not.toContain('abc123');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('123456');
    const record = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(record.level).toBe('log');
    expect(record.message).toContain('[email]');
    expect(record.params).toEqual({ otp: '[redacted]', note: '[email]' });
  });

  it('JSON mode scrubs a phone logged as a number or bigint, under a key, in an array and at the top level', () => {
    process.env.LOG_FORMAT = 'json';
    const logger = new AppLogger();
    const out = captureStream('stdout', () =>
      logger.log('x', { phone: 972501234567, list: [972501234567], big: 972501234567n, otp: 123456n, count: 3 }),
    );
    expect(out).not.toContain('972501234567');
    expect(out).not.toContain('123456');
    const record = JSON.parse(out.trim()) as { params: unknown };
    expect(record.params).toEqual({ phone: '[phone]', list: ['[phone]'], big: '[phone]', otp: '[redacted]', count: 3 });
    const top = captureStream('stdout', () => logger.log(972501234567));
    expect((JSON.parse(top.trim()) as { message: unknown }).message).toBe('[phone]');
  });

  it('JSON mode keeps a message that mentions a cookie readable, and the line valid', () => {
    process.env.LOG_FORMAT = 'json';
    const logger = new AppLogger();
    const out = captureStream('stdout', () =>
      logger.log('Cookie: hg_cart=abc; hg_customer=def', { password: 'x y z' }),
    );
    const record = JSON.parse(out.trim()) as { message: string; params: unknown };
    expect(record.message).toBe('Cookie: [redacted]');
    expect(record.params).toEqual({ password: '[redacted]' });
  });

  it('JSON mode under NODE_ENV=production; the error record and its stack are scrubbed', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.LOG_FORMAT;
    const logger = new AppLogger();
    const error = new Error(`no customer ${EMAIL}`);
    const err = captureStream('stderr', () => logger.error(error, undefined, 'ExceptionsHandler'));
    expect(err).not.toContain('@example.test');
    const record = JSON.parse(err.trim()) as { level: string; context: string; error: { stack: string } };
    expect(record.level).toBe('error');
    expect(record.context).toBe('ExceptionsHandler');
    expect(record.error.stack).toContain('[email]');
  });

  it('text mode scrubs the line and the printed stack', () => {
    delete process.env.LOG_FORMAT;
    process.env.NODE_ENV = 'test';
    const logger = new AppLogger();
    const stack = `Error: x ${EMAIL}\n    at f (/srv/app/dist/a.js:1:2)`;
    const err = captureStream('stderr', () => logger.error(`failed for ${EMAIL}`, stack, 'Ctx'));
    expect(err).toContain('[email]');
    expect(err).not.toContain('@example.test');
    expect(() => JSON.parse(err.split('\n')[0])).toThrow();
  });

  it('text mode keeps long names next to a color code', () => {
    delete process.env.LOG_FORMAT;
    delete process.env.NO_COLOR;
    process.env.NODE_ENV = 'test';
    const logger = new AppLogger();
    const out = captureStream('stdout', () =>
      logger.log('StoreOrdersAdminController {/api/admin/store-orders}:', 'Routes'),
    );
    expect(out).toContain('StoreOrdersAdminController');
    expect(out).not.toContain('[secret]');
  });

  it('error() and warn() capture with the request path; log() does not', () => {
    process.env.LOG_FORMAT = 'json';
    const { events, captured } = fakeEvents();
    const logger = new AppLogger(events);
    captureStream('stderr', () =>
      captureStream('stdout', () => {
        RequestContext.run({ method: 'GET', path: '/api/x' }, () => logger.error(new Error(`boom ${EMAIL}`)));
        logger.warn('slow 123 ms', 'Ctx');
        logger.log('fine');
      }),
    );
    expect(captured).toHaveLength(2);
    expect(captured[0]).toMatchObject({ kind: 'error', source: 'api', path: '/api/x' });
    expect(captured[0].message).toBe(`boom ${EMAIL}`);
    expect(captured[0].stack).toMatch(/^Error: boom/);
    expect(captured[1]).toEqual({
      kind: 'warn',
      source: 'api',
      message: 'slow 123 ms',
      stack: undefined,
      path: undefined,
    });
  });

  it('keeps the top 10 frames of a stack', () => {
    process.env.LOG_FORMAT = 'json';
    const { events, captured } = fakeEvents();
    const logger = new AppLogger(events);
    const frames = Array.from({ length: 30 }, (_, i) => `    at f${i} (/srv/a.js:${i}:1)`).join('\n');
    captureStream('stderr', () => logger.error('failed', `Error: failed\n${frames}`, 'Ctx'));
    const stack = captured[0].stack ?? '';
    expect(stack.split('\n').filter((l) => l.trim().startsWith('at '))).toHaveLength(10);
    expect(stack).toContain('f9 ');
    expect(stack).not.toContain('f10 ');
  });

  it('a message with an Error parameter keeps both texts and the error stack', () => {
    process.env.LOG_FORMAT = 'json';
    const { events, captured } = fakeEvents();
    const logger = new AppLogger(events);
    captureStream('stderr', () => logger.error('Cleanup failed', new Error('connection refused')));
    expect(captured[0].message).toBe('Cleanup failed: connection refused');
    expect(captured[0].stack).toMatch(/^Error: connection refused/);
  });

  it('Nest exception filter path: a 5xx through the static Logger is captured; nothing recurses', () => {
    process.env.LOG_FORMAT = 'json';
    const captured: CapturedEvent[] = [];
    // A capture that logs again must not loop (the guard), and a capture that throws must not break logging.
    let logger!: AppLogger;
    const capture = vi.fn((e: CapturedEvent) => {
      captured.push(e);
      logger.error('from inside capture');
      throw new Error('capture broke');
    });
    const events = { capture } as unknown as ErrorEventsService;
    logger = new AppLogger(events);
    Logger.overrideLogger(logger);
    const err = captureStream('stderr', () =>
      RequestContext.run({ method: 'POST', path: '/api/checkout' }, () =>
        new Logger('ExceptionsHandler').error(new InternalServerErrorException('db down')),
      ),
    );
    expect(capture).toHaveBeenCalledTimes(1);
    expect(captured[0]).toMatchObject({ kind: 'error', path: '/api/checkout' });
    expect(captured[0].message).toContain('db down');
    // Both lines are still printed: the nested one only skips the capture.
    expect(err).toContain('db down');
    expect(err).toContain('from inside capture');
  });

  it('prints without an ErrorEventsService', () => {
    process.env.LOG_FORMAT = 'json';
    const logger = new AppLogger();
    const err = captureStream('stderr', () => logger.error('alone'));
    expect((JSON.parse(err.trim()) as { message: string }).message).toBe('alone');
  });
});
