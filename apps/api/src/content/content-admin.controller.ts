import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';
import type { AdminAnnouncement, AdminFaqGroup, AdminInfoPage, AdminSiteContent } from '@hg/models';
import type { RequestMeta } from '../auth/auth.service.js';
import { id } from '../auth/body.js';
import {
  Admin,
  AdminAuthGuard,
  ClientMeta,
  RequirePermission,
  SameOriginGuard,
  type AdminContext,
} from '../auth/guards.js';
import {
  expectedUpdatedAt,
  parseAnnouncementInput,
  parseFaqGroupInput,
  parseInfoPageInput,
  parseSiteContentInput,
} from './content-admin-input.js';
import { ContentAdminService } from './content-admin.service.js';

const meta = (admin: AdminContext, client: RequestMeta) => ({ actorId: admin.user.id, ip: client.ip });

/**
 * "תוכן" in the admin, 8a (Phase 8 §5, ADM-06): site details, announcements, info pages and FAQ groups. Everything
 * needs content.manage; every update sends `expectedUpdatedAt` (409 `conflict` when the row is newer).
 */
@Controller('admin/content')
@UseGuards(SameOriginGuard, AdminAuthGuard)
@RequirePermission('content.manage')
export class ContentAdminController {
  constructor(private readonly content: ContentAdminService) {}

  // ---- Site details ----

  @Get('site')
  site(): Promise<AdminSiteContent> {
    return this.content.site();
  }

  @Put('site')
  updateSite(
    @Body() body: unknown,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<AdminSiteContent> {
    const input = parseSiteContentInput(body);
    return this.content.updateSite(input, expectedUpdatedAt(body), meta(admin, client));
  }

  // ---- Announcements ----

  @Get('announcements')
  announcements(): Promise<AdminAnnouncement[]> {
    return this.content.announcements();
  }

  @Get('announcements/:id')
  announcement(@Param('id') announcementId: string): Promise<AdminAnnouncement> {
    return this.content.announcement(id(announcementId));
  }

  @Post('announcements')
  createAnnouncement(
    @Body() body: unknown,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<AdminAnnouncement> {
    return this.content.createAnnouncement(parseAnnouncementInput(body), meta(admin, client));
  }

  @Put('announcements/:id')
  updateAnnouncement(
    @Param('id') announcementId: string,
    @Body() body: unknown,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<AdminAnnouncement> {
    const input = parseAnnouncementInput(body);
    return this.content.updateAnnouncement(id(announcementId), input, expectedUpdatedAt(body), meta(admin, client));
  }

  @Delete('announcements/:id')
  @HttpCode(204)
  deleteAnnouncement(
    @Param('id') announcementId: string,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<void> {
    return this.content.deleteAnnouncement(id(announcementId), meta(admin, client));
  }

  // ---- Info pages ----

  @Get('pages')
  pages(): Promise<AdminInfoPage[]> {
    return this.content.pages();
  }

  @Get('pages/:id')
  page(@Param('id') pageId: string): Promise<AdminInfoPage> {
    return this.content.page(id(pageId));
  }

  @Post('pages')
  createPage(
    @Body() body: unknown,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<AdminInfoPage> {
    return this.content.createPage(parseInfoPageInput(body), meta(admin, client));
  }

  @Put('pages/:id')
  updatePage(
    @Param('id') pageId: string,
    @Body() body: unknown,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<AdminInfoPage> {
    const input = parseInfoPageInput(body);
    return this.content.updatePage(id(pageId), input, expectedUpdatedAt(body), meta(admin, client));
  }

  @Delete('pages/:id')
  @HttpCode(204)
  deletePage(
    @Param('id') pageId: string,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<void> {
    return this.content.deletePage(id(pageId), meta(admin, client));
  }

  // ---- FAQ ----

  @Get('faq')
  faq(): Promise<AdminFaqGroup[]> {
    return this.content.faqGroups();
  }

  @Get('faq/:id')
  faqGroup(@Param('id') groupId: string): Promise<AdminFaqGroup> {
    return this.content.faqGroup(id(groupId));
  }

  @Post('faq')
  createFaqGroup(
    @Body() body: unknown,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<AdminFaqGroup> {
    return this.content.createFaqGroup(parseFaqGroupInput(body), meta(admin, client));
  }

  @Put('faq/:id')
  updateFaqGroup(
    @Param('id') groupId: string,
    @Body() body: unknown,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<AdminFaqGroup> {
    const input = parseFaqGroupInput(body);
    return this.content.updateFaqGroup(id(groupId), input, expectedUpdatedAt(body), meta(admin, client));
  }

  @Delete('faq/:id')
  @HttpCode(204)
  deleteFaqGroup(
    @Param('id') groupId: string,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<void> {
    return this.content.deleteFaqGroup(id(groupId), meta(admin, client));
  }
}
