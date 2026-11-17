import { Controller, Get, UseFilters, UseGuards, UseInterceptors } from '@nestjs/common';
import type { AccountBenefit } from '@hg/models';
import { StorefrontOriginGuard } from '../auth/guards.js';
import { NoStoreInterceptor } from '../common/no-store.interceptor.js';
import { PersonalCodesService } from '../promotions/personal-codes.service.js';
import { AccountErrorFilter } from './customer-auth.controller.js';
import type { ResolvedCustomer } from './customer-session.service.js';
import { CurrentCustomer, CustomerSessionGuard } from './customer-session.guard.js';

/**
 * "ההטבות שלי" (spec §4.3, decisions 93–94): `GET /api/account/benefits`, the signed-in account's own personal codes
 * (the welcome code and codes from staff) with their status. Needs a session (401 `not_authenticated`); never cached.
 */
@Controller('account')
@UseGuards(StorefrontOriginGuard, CustomerSessionGuard)
@UseInterceptors(NoStoreInterceptor)
@UseFilters(AccountErrorFilter)
export class BenefitsController {
  constructor(private readonly codes: PersonalCodesService) {}

  @Get('benefits')
  benefits(@CurrentCustomer() current: ResolvedCustomer): Promise<AccountBenefit[]> {
    return this.codes.benefits(current.customer.id);
  }
}
