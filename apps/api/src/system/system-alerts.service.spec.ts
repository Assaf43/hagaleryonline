import type { ConfigService } from '@nestjs/config';
import type { OutboxService } from '../outbox/outbox.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ErrorEventsService, ErrorGroupChange } from './error-events.service.js';
import { SystemAlertsService } from './system-alerts.service.js';

const config = (env: Record<string, string> = {}) => ({ get: (key: string) => env[key] }) as unknown as ConfigService;

const group = (over: Partial<ErrorGroupChange> = {}): ErrorGroupChange => ({
  id: 1,
  fingerprint: 'fp-1',
  kind: 'error',
  source: 'api',
  message: 'Boom for sentinel.user@example.test',
  path: '/api/x',
  count: 3,
  isNew: true,
  reopened: false,
  ...over,
});

interface Job {
  type: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
}

/** Fakes the outbox's dedupe (a second key is kept as it is) and the rows the service reads and updates. */
function setup(env: Record<string, string>, backupRuns: { id: number; kind: string }[] = []) {
  const jobs = new Map<string, Job>();
  const alerted: number[] = [];
  const alertedRuns: number[] = [];
  const outbox = {
    enqueue: vi.fn((_tx: unknown, job: Job) => {
      if (!jobs.has(job.dedupeKey)) jobs.set(job.dedupeKey, job);
      return Promise.resolve();
    }),
  } as unknown as OutboxService;
  let lastOkDb: { finishedAt: Date } | null = null;
  const unalerted = [...backupRuns];
  const tx = {
    errorEvent: {
      update: vi.fn(({ where }: { where: { id: number } }) => {
        alerted.push(where.id);
        return Promise.resolve({});
      }),
    },
    backupRun: {
      update: vi.fn(({ where }: { where: { id: number } }) => {
        alertedRuns.push(where.id);
        return Promise.resolve({});
      }),
    },
  };
  const prisma = {
    $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    backupRun: {
      findMany: vi.fn(() => Promise.resolve(unalerted)),
      findFirst: vi.fn(() => Promise.resolve(lastOkDb)),
    },
  } as unknown as PrismaService;
  const service = new SystemAlertsService(prisma, outbox, config(env), {
    onFlush: () => undefined,
  } as unknown as ErrorEventsService);
  const now = new Date('2026-11-26T10:20:00.000Z');
  service.now = () => now;
  service.startedAt = new Date('2026-11-24T10:20:00.000Z');
  return { service, jobs, alerted, alertedRuns, setLastOk: (d: Date | null) => (lastOkDb = d && { finishedAt: d }) };
}

const ON = { ALERT_EMAIL: 'alerts@example.test' };

describe('SystemAlertsService', () => {
  afterEach(() => vi.restoreAllMocks());

  it('one alert per group per hour (two flushes in the same hour give one job)', async () => {
    const { service, jobs, alerted } = setup(ON);
    await service.afterFlush([group()]);
    await service.afterFlush([group({ reopened: true, isNew: false })]);
    expect(jobs.size).toBe(1);
    const [job] = [...jobs.values()];
    expect(job.dedupeKey).toBe('system_alert:fp-1:2026-11-26T10');
    expect(job.type).toBe('email.system_alert');
    expect(alerted).toEqual([1, 1]);
  });

  it('the next hour alerts again', async () => {
    const { service, jobs } = setup(ON);
    await service.afterFlush([group()]);
    service.now = () => new Date('2026-11-26T11:00:00.000Z');
    await service.afterFlush([group({ isNew: false, reopened: true })]);
    expect(jobs.size).toBe(2);
  });

  it('the payload is scrubbed, short, with the reason, and holds no address', async () => {
    const { service, jobs } = setup(ON);
    await service.afterFlush([group({ message: `x ${'y'.repeat(900)} sentinel.user@example.test` })]);
    const [{ payload }] = [...jobs.values()];
    expect(payload.reason).toBe('new_error');
    expect((payload.summary as string).length).toBeLessThanOrEqual(300);
    expect(JSON.stringify(payload)).not.toContain('@');
    await service.afterFlush([group({ fingerprint: 'fp-2', message: 'mail sentinel.user@example.test' })]);
    expect(JSON.stringify([...jobs.values()])).not.toContain('example.test');
    expect([...jobs.values()][1].payload.summary).toBe('mail [email]');
  });

  it('a storm of 50 distinct groups gives at most 5 alerts plus one storm summary, skipped groups stay unalerted', async () => {
    const { service, jobs, alerted } = setup(ON);
    const groups = Array.from({ length: 50 }, (_, i) => group({ id: i + 1, fingerprint: `fp-${i}` }));
    await service.afterFlush(groups);
    expect(jobs.size).toBe(6);
    expect(alerted).toHaveLength(5);
    expect(jobs.get('system_alert:storm:2026-11-26T10')?.payload).toMatchObject({
      reason: 'error_storm',
      summary: '45',
    });
    // The next flush in the same hour: 5 more, then the hourly 20 are used; the storm key stays one job.
    for (let i = 0; i < 5; i++)
      await service.afterFlush(
        Array.from({ length: 50 }, (_, j) => group({ id: 100 + i * 50 + j, fingerprint: `fp-${i}-${j}` })),
      );
    expect(alerted).toHaveLength(20);
    expect([...jobs.keys()].filter((k) => k.startsWith('system_alert:storm:'))).toHaveLength(1);
    expect(jobs.size).toBe(21);
    // A new hour starts a new budget.
    service.now = () => new Date('2026-11-26T11:00:00.000Z');
    await service.afterFlush([group({ id: 900, fingerprint: 'fp-late' })]);
    expect(jobs.size).toBe(22);
  });

  it('a reopened group says so', async () => {
    const { service, jobs } = setup(ON);
    await service.afterFlush([group({ isNew: false, reopened: true })]);
    expect([...jobs.values()][0].payload.reason).toBe('reopened_error');
  });

  it('warn groups never alert', async () => {
    const { service, jobs, alerted } = setup(ON);
    await service.afterFlush([group({ kind: 'warn' })]);
    expect(jobs.size).toBe(0);
    expect(alerted).toEqual([]);
  });

  it('no ALERT_EMAIL, no job (and nothing marked alerted)', async () => {
    const { service, jobs, alerted, alertedRuns } = setup({}, [{ id: 7, kind: 'DB' }]);
    await service.afterFlush([group()]);
    await service.checkBackups();
    expect(jobs.size).toBe(0);
    expect(alerted).toEqual([]);
    expect(alertedRuns).toEqual([]);
  });

  it('failed backup alerts once', async () => {
    const { service, jobs, alertedRuns } = setup(ON, [{ id: 7, kind: 'DB' }]);
    await service.checkBackups();
    await service.checkBackups();
    expect([...jobs.keys()]).toEqual(['system_alert:backup_failed:7']);
    expect([...jobs.values()][0].payload).toMatchObject({ reason: 'backup_failed', summary: 'db' });
    expect(alertedRuns).toContain(7);
  });

  it('missing backup alerts once a day, and nothing without BACKUP_EXPECTED', async () => {
    const off = setup(ON);
    await off.service.checkBackups();
    expect(off.jobs.size).toBe(0);

    const on = setup({ ...ON, BACKUP_EXPECTED: 'true' });
    on.setLastOk(new Date('2026-11-25T07:00:00.000Z')); // 27 h old
    await on.service.checkBackups();
    await on.service.checkBackups();
    expect([...on.jobs.keys()]).toEqual(['system_alert:backup_missing:2026-11-26']);
    expect([...on.jobs.values()][0].payload).toMatchObject({ reason: 'backup_missing', summary: 'db' });
  });

  it('a failure prints one plain stderr line and never rejects', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { service } = setup(ON);
    (service as unknown as { prisma: { $transaction: () => never } }).prisma.$transaction = () => {
      throw new Error('db down sentinel.user@example.test');
    };
    await expect(service.afterFlush([group()])).resolves.toBeUndefined();
    await expect(service.checkBackups()).resolves.toBeUndefined();
    expect(write).toHaveBeenCalled();
    expect(String(write.mock.calls[0][0])).not.toContain('@');
  });
});
