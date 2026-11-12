import type { ConfigService } from '@nestjs/config';
import type { OutboxService } from './outbox.service.js';
import { OutboxWorker, pollInterval } from './outbox.worker.js';

const config = (env: Record<string, string>) => ({ get: (key: string) => env[key] }) as unknown as ConfigService;

describe('OutboxWorker', () => {
  afterEach(() => vi.useRealTimers());

  it('polls every OUTBOX_POLL_MS (default 3000) and stops on module destroy', async () => {
    vi.useFakeTimers();
    const runDue = vi.fn().mockResolvedValue(0);
    const worker = new OutboxWorker({ runDue } as unknown as OutboxService, config({}));
    worker.onModuleInit();
    expect(worker.running).toBe(true);
    await vi.advanceTimersByTimeAsync(2999);
    expect(runDue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runDue).toHaveBeenCalledTimes(1);
    worker.onModuleDestroy();
    expect(worker.running).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runDue).toHaveBeenCalledTimes(1);
  });

  it('is off with OUTBOX_WORKER=off', async () => {
    vi.useFakeTimers();
    const runDue = vi.fn().mockResolvedValue(0);
    const worker = new OutboxWorker({ runDue } as unknown as OutboxService, config({ OUTBOX_WORKER: 'off' }));
    worker.onModuleInit();
    expect(worker.running).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runDue).not.toHaveBeenCalled();
  });

  it('skips a poll while the previous one runs, and survives a failing poll', async () => {
    let release!: () => void;
    const runDue = vi
      .fn()
      .mockImplementationOnce(() => new Promise<number>((resolve) => (release = () => resolve(0))))
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue(0);
    const worker = new OutboxWorker({ runDue } as unknown as OutboxService, config({}));
    const first = worker.tick();
    await worker.tick();
    expect(runDue).toHaveBeenCalledTimes(1);
    release();
    await first;
    await expect(worker.tick()).resolves.toBeUndefined();
    await worker.tick();
    expect(runDue).toHaveBeenCalledTimes(3);
  });

  it('reads OUTBOX_POLL_MS', () => {
    expect(pollInterval(undefined)).toBe(3000);
    expect(pollInterval('')).toBe(3000);
    expect(pollInterval('500')).toBe(500);
    expect(() => pollInterval('fast')).toThrow();
    expect(() => pollInterval('10')).toThrow();
  });
});
