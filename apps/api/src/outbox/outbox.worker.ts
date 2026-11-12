import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxService } from './outbox.service.js';

export const DEFAULT_POLL_MS = 3000;

/** `OUTBOX_POLL_MS`: a whole number of milliseconds, at least 100; empty → 3000. Anything else stops the API. */
export function pollInterval(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_POLL_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 100) throw new Error(`OUTBOX_POLL_MS must be ≥ 100 ms, got "${raw}"`);
  return value;
}

/**
 * Runs due outbox jobs every `OUTBOX_POLL_MS` inside the API process (spec §5.1). `OUTBOX_WORKER=off` disables it
 * (the e2e tests call `OutboxService.runDue()` themselves; the CLI never runs jobs). One run at a time per process;
 * other API processes are safe through the claim's `SKIP LOCKED`.
 */
@Injectable()
export class OutboxWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxWorker.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(
    private readonly outbox: OutboxService,
    private readonly config: ConfigService,
  ) {}

  get running(): boolean {
    return this.timer !== null;
  }

  onModuleInit(): void {
    if (this.config.get<string>('OUTBOX_WORKER') === 'off') return;
    const ms = pollInterval(this.config.get<string>('OUTBOX_POLL_MS'));
    this.timer = setInterval(() => void this.tick(), ms);
    // Never keeps the process alive on its own.
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One poll; skipped while the previous one is still running. Errors are logged, the next poll tries again. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.outbox.runDue();
    } catch (error) {
      this.logger.error('Outbox poll failed', error);
    } finally {
      this.busy = false;
    }
  }
}
