import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import type { AdminUserInput, AdminUserRow, AuditPage, OneTimeLink } from '@hg/models';
import { AuditService } from '../audit/audit.service.js';
import { AdminUsersService, type AdminUserPatch } from './admin-users.service.js';
import type { RequestMeta } from './auth.service.js';
import { id } from './body.js';
import {
  Admin,
  AdminAuthGuard,
  ClientMeta,
  RequirePermission,
  SameOriginGuard,
  SuperAdminOnly,
  type AdminContext,
} from './guards.js';

/** Users and permissions — the Super Admin's alone (decisions 48–52). */
@Controller('admin/users')
@UseGuards(SameOriginGuard, AdminAuthGuard)
@SuperAdminOnly()
export class UsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  list(): Promise<AdminUserRow[]> {
    return this.users.list();
  }

  @Post()
  create(@Body() body: AdminUserInput, @Admin() admin: AdminContext, @ClientMeta() meta: RequestMeta) {
    return this.users.create(body ?? ({} as AdminUserInput), admin.user.id, meta.ip);
  }

  @Patch(':id')
  update(
    @Param('id') userId: string,
    @Body() body: AdminUserPatch,
    @Admin() admin: AdminContext,
    @ClientMeta() meta: RequestMeta,
  ) {
    return this.users.update(id(userId), body ?? {}, admin.user.id, meta.ip);
  }

  @Post(':id/invite-link')
  @HttpCode(200)
  inviteLink(
    @Param('id') userId: string,
    @Admin() admin: AdminContext,
    @ClientMeta() meta: RequestMeta,
  ): Promise<OneTimeLink> {
    return this.users.inviteLink(id(userId), admin.user.id, meta.ip);
  }

  @Post(':id/reset-password')
  @HttpCode(200)
  resetPassword(
    @Param('id') userId: string,
    @Admin() admin: AdminContext,
    @ClientMeta() meta: RequestMeta,
  ): Promise<OneTimeLink> {
    return this.users.passwordResetLink(id(userId), admin.user.id, meta.ip);
  }

  @Post(':id/reset-2fa')
  @HttpCode(204)
  async resetTwoFactor(@Param('id') userId: string, @Admin() admin: AdminContext, @ClientMeta() meta: RequestMeta) {
    await this.users.resetTwoFactor(id(userId), admin.user.id, meta.ip);
  }

  @Post(':id/revoke-sessions')
  @HttpCode(204)
  async revokeSessions(@Param('id') userId: string, @Admin() admin: AdminContext, @ClientMeta() meta: RequestMeta) {
    await this.users.revokeSessions(id(userId), admin.user.id, meta.ip);
  }
}

/** The change log (ADM-11). */
@Controller('admin/audit')
@UseGuards(SameOriginGuard, AdminAuthGuard)
@RequirePermission('audit.view')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('page') page?: string,
  ): Promise<AuditPage> {
    const pageNumber = Math.max(1, Number.parseInt(page ?? '1', 10) || 1);
    return this.audit.list({ entityType: entityType || undefined, entityId: entityId || undefined, page: pageNumber });
  }
}
