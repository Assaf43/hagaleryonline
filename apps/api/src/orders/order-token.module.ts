import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderTokens, orderTokenKey } from './order-token.js';

/**
 * `OrderTokens` with ORDER_TOKEN_KEY (spec 9a.7). Its own module so that the order e-mails and the invoices can
 * use it too: they cannot import `OrdersModule`, which imports them through `SupportModule` → `NotificationsModule`.
 * `OrdersModule` re-exports it.
 */
@Module({
  providers: [
    {
      provide: OrderTokens,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new OrderTokens(orderTokenKey(config.get<string>('NODE_ENV'), config.get<string>('ORDER_TOKEN_KEY'))),
    },
  ],
  exports: [OrderTokens],
})
export class OrderTokensModule {}
