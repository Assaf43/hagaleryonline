import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service.js';
import { ErrorEventsService, MAX_PENDING_GROUPS } from './error-events.service.js';
import { fingerprint } from './fingerprint.js';

const config = (env: Record<string, string> = {}) => ({ get: (key: string) => env[key] }) as unknown as ConfigService;

/** A number written in letters (messages are grouped without their digits). */
const letters = (n: number) => n.toString(26).replace(/\d/g, (d) => 'qrstuvwxyz'[Number(d)]);

/** The values of one tagged-template `$queryRaw` call (strings dropped). */
type Call = unknown[];

function fakePrisma(rows: (call: Call) => unknown[] = () => [{ inserted: true, reopened: false }]) {
  const calls: Call[] = [];
  const $queryRaw = vi.fn((_strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push(values);
    return Promise.resolve(rows(values));
  });
  const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
  const prisma = { $queryRaw, errorEvent: { deleteMany } } as unknown as PrismaService;
  return { prisma, calls, $queryRaw, deleteMany };
}

describe('ErrorEventsService', () => {
  afterEach(() => vi.restoreAllMocks());

  it('storm collapses into one group (10 000 captures, one upsert with count 10 000)', async () => {
    const { prisma, calls } = fakePrisma();
    const service = new ErrorEventsService(prisma, config());
    const error = new Error('Payment provider timeout after 3000 ms');
    for (let i = 0; i < 10_000; i++)
      service.capture({ kind: 'error', source: 'api', message: error.message, stack: error.stack, path: '/api/x' });
    await service.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(10_000);
    expect(calls[0]).toContain(
      fingerprint({ kind: 'error', source: 'api', message: error.message, stack: error.stack }),
    );
    // The batch is gone after a flush.
    await service.flush();
    expect(calls).toHaveLength(1);
  });

  it('groups by number-free message, stores the latest sample scrubbed', async () => {
    const { prisma, calls } = fakePrisma();
    const service = new ErrorEventsService(prisma, config());
    service.capture({ kind: 'warn', source: 'ssr', message: 'slow render 120 ms', path: '/a' });
    service.capture({ kind: 'warn', source: 'ssr', message: 'slow render 950 ms for sentinel.user@example.test' });
    await service.flush();
    expect(calls).toHaveLength(2);
    service.capture({ kind: 'warn', source: 'ssr', message: 'slow render 1 ms' });
    service.capture({ kind: 'warn', source: 'ssr', message: 'slow render 2 ms' });
    await service.flush();
    expect(calls).toHaveLength(3);
    expect(calls[2]).toContain(2);
    expect(calls[2]).toContain('slow render 2 ms');
    expect(JSON.stringify(calls)).not.toContain('@example.test');
  });

  it('caps the pending groups; extra new keys are counted under one overflow warn group', async () => {
    const { prisma, calls } = fakePrisma();
    const service = new ErrorEventsService(prisma, config());
    for (let i = 0; i < MAX_PENDING_GROUPS + 25; i++)
      service.capture({ kind: 'error', source: 'api', message: `distinct error ${letters(i)}` });
    // A known key still counts after the cap.
    service.capture({ kind: 'error', source: 'api', message: `distinct error ${letters(0)}` });
    await service.flush();
    expect(calls).toHaveLength(MAX_PENDING_GROUPS + 1);
    const overflow = calls.find((c) => c.includes('warn'));
    expect(overflow).toBeDefined();
    expect(overflow).toContain(25);
  });

  it('capture never throws', () => {
    const { prisma } = fakePrisma();
    const service = new ErrorEventsService(prisma, config());
    expect(() =>
      service.capture({
        kind: 'error',
        source: 'api',
        message: undefined as unknown as string,
        stack: 5 as unknown as string,
      }),
    ).not.toThrow();
  });

  it('db down does not recurse (one stderr line, no capture, the next flush works)', async () => {
    const { prisma, calls, $queryRaw } = fakePrisma();
    $queryRaw.mockImplementationOnce(() =>
      Promise.reject(new Error('connect ECONNREFUSED sentinel.user@example.test')),
    );
    const service = new ErrorEventsService(prisma, config());
    const capture = vi.spyOn(service, 'capture');
    const lines: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    const stdout = vi.spyOn(process.stdout, 'write');

    service.capture({ kind: 'error', source: 'api', message: 'secret batch content' });
    capture.mockClear();
    await expect(service.flush()).resolves.toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith('\n')).toBe(true);
    expect(lines[0]).not.toContain('secret batch content');
    expect(lines[0]).not.toContain('@example.test');
    expect(capture).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();

    // The failed batch is dropped; the next one is written.
    service.capture({ kind: 'error', source: 'api', message: 'after recovery' });
    await service.flush();
    stderr.mockRestore();
    expect(lines).toHaveLength(1);
    expect(calls.at(-1)).toContain('after recovery');
    expect(calls.flat()).not.toContain('secret batch content');
  });

  it('flush returns the new and reopened groups only', async () => {
    const answers = [
      {
        id: 1,
        fingerprint: 'a',
        kind: 'error',
        source: 'api',
        message: 'new',
        path: null,
        count: 1,
        inserted: true,
        reopened: false,
      },
      {
        id: 2,
        fingerprint: 'b',
        kind: 'error',
        source: 'api',
        message: 'old',
        path: '/x',
        count: 9,
        inserted: false,
        reopened: false,
      },
      {
        id: 3,
        fingerprint: 'c',
        kind: 'warn',
        source: 'ssr',
        message: 'back',
        path: '/y',
        count: 4,
        inserted: false,
        reopened: true,
      },
    ];
    let n = 0;
    const { prisma } = fakePrisma(() => [answers[n++]]);
    const service = new ErrorEventsService(prisma, config());
    for (const m of ['new', 'old', 'back']) service.capture({ kind: 'error', source: 'api', message: m });
    const changes = await service.flush();
    expect(changes).toEqual([
      {
        id: 1,
        fingerprint: 'a',
        kind: 'error',
        source: 'api',
        message: 'new',
        path: null,
        count: 1,
        isNew: true,
        reopened: false,
      },
      {
        id: 3,
        fingerprint: 'c',
        kind: 'warn',
        source: 'ssr',
        message: 'back',
        path: '/y',
        count: 4,
        isNew: false,
        reopened: true,
      },
    ]);
  });

  it('cleanup deletes groups last seen more than 30 days ago', async () => {
    const { prisma, deleteMany } = fakePrisma();
    deleteMany.mockResolvedValue({ count: 3 });
    const service = new ErrorEventsService(prisma, config());
    const now = new Date('2026-11-26T10:00:00Z');
    await expect(service.cleanup(now)).resolves.toBe(3);
    expect(deleteMany).toHaveBeenCalledWith({ where: { lastSeen: { lt: new Date('2026-10-27T10:00:00Z') } } });
  });

  it('flushes every 5 s, cleans up daily, flushes on destroy; ERROR_EVENTS_WORKER=off keeps the timers off', async () => {
    vi.useFakeTimers();
    try {
      const { prisma, calls, deleteMany } = fakePrisma();
      const service = new ErrorEventsService(prisma, config());
      service.onModuleInit();
      await vi.advanceTimersByTimeAsync(0);
      expect(deleteMany).toHaveBeenCalledTimes(1);
      service.capture({ kind: 'error', source: 'api', message: 'one' });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls).toHaveLength(1);
      service.capture({ kind: 'error', source: 'api', message: 'two' });
      await service.onModuleDestroy();
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(deleteMany).toHaveBeenCalledTimes(1);

      const off = fakePrisma();
      const idle = new ErrorEventsService(off.prisma, config({ ERROR_EVENTS_WORKER: 'off' }));
      idle.onModuleInit();
      idle.capture({ kind: 'error', source: 'api', message: 'three' });
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(off.calls).toHaveLength(0);
      expect(off.deleteMany).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
