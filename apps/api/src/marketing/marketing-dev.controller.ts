import { randomBytes } from 'node:crypto';
import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminAuthGuard, RequirePermission, SameOriginGuard } from '../auth/guards.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { MARKETING_PROVIDER, type MarketingProvider, type SyncedContact } from './marketing-provider.js';
import { MOCK_MARKETING_CODE, MockMarketingProvider } from './mock-marketing.provider.js';

const EMAIL_MAX = 254;
const TIMEOUT_MS = 10_000;

/**
 * Dev view of the e-mail tool (spec §5.4): the mock's synced list, and an "unsubscribe" that signs a webhook as the
 * tool would and posts it to our own `/api/marketing/webhook` (`API_INTERNAL_URL`, default http://localhost:3000), so
 * it goes through the real path. 404 unless the marketing provider and both notification providers are mock, like
 * the dev message viewer.
 */
@Controller('admin/dev')
@UseGuards(SameOriginGuard, AdminAuthGuard)
export class MarketingDevController {
  constructor(
    @Inject(MARKETING_PROVIDER) private readonly provider: MarketingProvider,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  @Get('marketing')
  @RequirePermission('orders.manage')
  @Header('Cache-Control', 'no-store')
  list(): SyncedContact[] {
    return this.mock().list();
  }

  @Post('marketing/unsubscribe')
  @RequirePermission('orders.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unsubscribe(@Body() body: unknown): Promise<void> {
    const mock = this.mock();
    const email = (body as { email?: unknown } | null)?.email;
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(email.trim()) || email.length > EMAIL_MAX)
      throw new BadRequestException({ statusCode: 400, code: 'invalid', field: 'email' });
    const { body: payload, headers } = mock.signedWebhook([
      { id: `mock_evt_${randomBytes(12).toString('hex')}`, type: 'unsubscribed', email: email.trim() },
    ]);
    // Read on every call: the e2e tests learn their port only after the app listens.
    const base = (this.config.get<string>('API_INTERNAL_URL') || 'http://localhost:3000').replace(/\/+$/, '');
    const res = await fetch(`${base}/api/marketing/webhook`, {
      method: 'POST',
      headers,
      body: payload,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await res.body?.cancel();
    if (res.status !== HttpStatus.NO_CONTENT)
      throw new BadGatewayException({ statusCode: 502, code: 'webhook_failed', status: res.status });
  }

  private mock(): MockMarketingProvider {
    if (
      !(this.provider instanceof MockMarketingProvider) ||
      this.provider.code !== MOCK_MARKETING_CODE ||
      !this.notifications.devViewerEnabled()
    )
      throw new NotFoundException({ statusCode: 404, code: 'not_found' });
    return this.provider;
  }
}
