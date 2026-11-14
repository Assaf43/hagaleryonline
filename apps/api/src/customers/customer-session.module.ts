import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CustomerSessionService } from './customer-session.service.js';
import { CustomerCookie, CustomerSessionGuard, OptionalCustomerGuard } from './customer-session.guard.js';

/**
 * The customer session and its guards on their own, so the cart and checkout can read the signed-in customer
 * without importing `CustomersModule` (which itself imports the cart and orders modules for the account API).
 */
@Module({
  imports: [AuthModule],
  providers: [CustomerSessionService, CustomerCookie, CustomerSessionGuard, OptionalCustomerGuard],
  exports: [CustomerSessionService, CustomerCookie, CustomerSessionGuard, OptionalCustomerGuard],
})
export class CustomerSessionModule {}
