import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import type { IssuedPersonalCode } from '@hg/models';
import type { RequestMeta } from '../auth/auth.service.js';
import {
  Admin,
  AdminAuthGuard,
  ClientMeta,
  RequirePermission,
  SameOriginGuard,
  type AdminContext,
} from '../auth/guards.js';
import { parseIssueInput, PersonalCodesService } from './personal-codes.service.js';

/**
 * "הנפקת קופון אישי" (spec §4.5, decision 94): staff issue a personal code from a template to one customer, optionally
 * sent by e-mail or SMS. Needs `club.manage`; audited without the code.
 */
@Controller('admin/customers')
@UseGuards(SameOriginGuard, AdminAuthGuard)
@RequirePermission('club.manage')
export class PersonalCodesAdminController {
  constructor(private readonly codes: PersonalCodesService) {}

  @Post(':id/codes')
  issue(
    @Param('id') customerId: string,
    @Body() body: unknown,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<IssuedPersonalCode> {
    return this.codes.issueByStaff(customerId, parseIssueInput(body), { actorId: admin.user.id, ip: client.ip });
  }
}
