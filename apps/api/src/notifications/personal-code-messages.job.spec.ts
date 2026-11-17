import { vi } from 'vitest';
import type { OutboxService } from '../outbox/outbox.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { NotificationsService } from './notifications.service.js';
import { PersonalCodeMessagesJob } from './personal-code-messages.job.js';

const NOW = new Date('2026-11-17T10:00:00Z');
const DAY = 24 * 60 * 60_000;

describe('PersonalCodeMessagesJob (decisions 93–94)', () => {
  const setup = (row: Record<string, unknown> | null) => {
    const sms = vi.fn(() => Promise.resolve());
    const email = vi.fn(() => Promise.resolve());
    const prisma = { personalCode: { findUnique: () => Promise.resolve(row) } } as unknown as PrismaService;
    const notifications = { sms, email, siteUrl: () => 'https://shop.test' } as unknown as NotificationsService;
    const job = new PersonalCodeMessagesJob({} as OutboxService, prisma, notifications);
    return { job, sms, email };
  };
  const code = (patch: Record<string, unknown> = {}) => ({
    id: 1,
    code: 'NST-AB23CD45',
    orderId: null,
    expiresAt: new Date(NOW.getTime() + DAY),
    promotion: { name: '10% הנחה', active: true, endsAt: null },
    customer: { fullName: 'נועה', phone: '0501234567', email: 'n@example.test', emailVerifiedAt: NOW },
    ...patch,
  });

  beforeEach(() => vi.useFakeTimers({ now: NOW }));
  afterEach(() => vi.useRealTimers());

  it('sends a live code', async () => {
    const { job, sms } = setup(code());
    await job.send({ personalCodeId: 1 }, 'sms', 'welcome_code');
    expect(sms).toHaveBeenCalledTimes(1);
  });

  it('links to the benefits page (the code is listed there)', async () => {
    const { job, sms } = setup(code());
    await job.send({ personalCodeId: 1 }, 'sms', 'welcome_code');
    expect(sms.mock.calls[0][2]).toMatchObject({ link: 'https://shop.test/account/benefits' });
  });

  it('skips a code that is gone, used, void or expired (also by its template end)', async () => {
    for (const row of [
      null,
      code({ orderId: 'order-1' }),
      code({ promotion: { name: 'x', active: false, endsAt: null } }),
      code({ expiresAt: new Date(NOW.getTime() - 1) }),
      code({ promotion: { name: 'x', active: true, endsAt: new Date(NOW.getTime() - 1) } }),
    ]) {
      const { job, sms, email } = setup(row);
      await job.send({ personalCodeId: 1 }, 'sms', 'personal_code');
      await job.send({ personalCodeId: 1 }, 'email', 'personal_code');
      expect(sms).not.toHaveBeenCalled();
      expect(email).not.toHaveBeenCalled();
    }
  });
});
