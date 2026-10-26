import { Global, Module } from '@nestjs/common';
import { CacheStore, InMemoryCacheStore } from './cache-store.js';

@Global()
@Module({
  providers: [{ provide: CacheStore, useFactory: () => new InMemoryCacheStore() }],
  exports: [CacheStore],
})
export class CacheModule {}
