import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { resolve } from 'node:path';
import { LocalDiskStorage } from './local-disk-storage.js';
import { StorageProvider } from './storage.js';

/**
 * Where uploaded files go. MEDIA_DIR is relative to the API's working directory (apps/api), so the
 * default is `storage/` at the repo root; MEDIA_URL is where the site reads public files.
 */
@Global()
@Module({
  providers: [
    {
      provide: StorageProvider,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new LocalDiskStorage(
          resolve(config.get<string>('MEDIA_DIR') || '../../storage'),
          (config.get<string>('MEDIA_URL') || '/media').replace(/\/$/, ''),
        ),
    },
  ],
  exports: [StorageProvider],
})
export class MediaModule {}
