import { Module } from '@nestjs/common';
import { LocalitiesController } from './localities.controller.js';
import { LocalitiesService } from './localities.service.js';

@Module({
  controllers: [LocalitiesController],
  providers: [LocalitiesService],
  exports: [LocalitiesService],
})
export class ShippingModule {}
