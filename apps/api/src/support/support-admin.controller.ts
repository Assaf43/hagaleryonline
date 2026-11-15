import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { AdminTicketDetail, AdminTicketNewCount, AdminTicketPage, StoreSettingsView } from '@hg/models';
import type { RequestMeta } from '../auth/auth.service.js';
import {
  Admin,
  AdminAuthGuard,
  ClientMeta,
  RequirePermission,
  SameOriginGuard,
  type AdminContext,
} from '../auth/guards.js';
import {
  parseNoteInput,
  parseStatusInput,
  parseStoreSettingsInput,
  parseTicketFilter,
  SupportAdminService,
} from './support-admin.service.js';

/** A photo is a customer's private file: shown inline, never cached, never sniffed, nothing else loads. */
const PHOTO_CSP = "default-src 'none'; img-src 'self'";

/**
 * The admin support inbox (spec §7.2, permission `support.manage`): `GET /api/admin/support?type=&status=&page=`,
 * `count-new`, `:number`, `POST :number/status`, `POST :number/notes` and the private photos
 * `GET :number/attachments/:id`. Every change is in the audit log.
 */
@Controller('admin/support')
@UseGuards(SameOriginGuard, AdminAuthGuard)
@RequirePermission('support.manage')
export class SupportAdminController {
  constructor(private readonly support: SupportAdminService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @Query('type') type: unknown,
    @Query('status') status: unknown,
    @Query('page') page: unknown,
  ): Promise<AdminTicketPage> {
    return this.support.list(parseTicketFilter({ type, status, page }));
  }

  /** The menu badge: tickets in status `new`. */
  @Get('count-new')
  @Header('Cache-Control', 'no-store')
  countNew(): Promise<AdminTicketNewCount> {
    return this.support.countNew();
  }

  @Get(':number')
  @Header('Cache-Control', 'no-store')
  detail(@Param('number') number: string): Promise<AdminTicketDetail> {
    return this.support.detail(number);
  }

  @Post(':number/status')
  @HttpCode(HttpStatus.OK)
  status(
    @Param('number') number: string,
    @Body() body: unknown,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<AdminTicketDetail> {
    return this.support.setStatus(number, parseStatusInput(body), { actorId: admin.user.id, ip: client.ip });
  }

  @Post(':number/notes')
  note(
    @Param('number') number: string,
    @Body() body: unknown,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<AdminTicketDetail> {
    return this.support.addNote(number, parseNoteInput(body), { actorId: admin.user.id, ip: client.ip });
  }

  @Get(':number/attachments/:id')
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('X-Robots-Tag', 'noindex')
  @Header('Content-Security-Policy', PHOTO_CSP)
  async attachment(@Param('number') number: string, @Param('id') id: string): Promise<StreamableFile> {
    const photo = await this.support.photo(number, id);
    return new StreamableFile(photo.content, {
      type: photo.contentType,
      disposition: 'inline',
      length: photo.content.length,
    });
  }
}

/**
 * Store settings (spec §3): the return window "ימי החזרה", 1–60 days. The Super Admin holds every permission that
 * is not opt-in, so `orders.manage` covers both (as the providers page does).
 */
@Controller('admin/settings/store')
@UseGuards(SameOriginGuard, AdminAuthGuard)
@RequirePermission('orders.manage')
export class StoreSettingsAdminController {
  constructor(private readonly support: SupportAdminService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  get(): Promise<StoreSettingsView> {
    return this.support.storeSettings();
  }

  @Put()
  save(
    @Body() body: unknown,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<StoreSettingsView> {
    return this.support.saveStoreSettings(parseStoreSettingsInput(body), { actorId: admin.user.id, ip: client.ip });
  }
}
