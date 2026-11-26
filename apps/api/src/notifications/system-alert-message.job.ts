import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxService } from '../outbox/outbox.service.js';
import { NotificationsService } from './notifications.service.js';
import type { SystemAlertReason } from './templates/index.js';

interface AlertJob {
  reason: SystemAlertReason;
  summary: string;
  /** ISO time of the event. */
  at: string;
}

/** `dd.mm.yyyy hh:mm` in Israel time. */
export function israelDateTime(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const p = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${p('day')}.${p('month')}.${p('year')} ${p('hour')}:${p('minute')}`;
}

/**
 * The outbox job `email.system_alert` (spec 9b.6). The payload holds no address: `ALERT_EMAIL` is read here, when the
 * message is sent, and a job that finds it unset completes without sending.
 */
@Injectable()
export class SystemAlertMessageJob implements OnModuleInit {
  constructor(
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.outbox.register<AlertJob>('email.system_alert', (payload) => this.send(payload));
  }

  async send({ reason, summary, at }: AlertJob): Promise<void> {
    const to = this.config.get<string>('ALERT_EMAIL')?.trim();
    if (!to) return;
    const admin = this.config.get<string>('ADMIN_URL', 'http://localhost:4300').replace(/\/$/, '');
    await this.notifications.email('system_alert', to, {
      reason,
      summary,
      at: israelDateTime(at),
      link: `${admin}/system`,
    });
  }
}
