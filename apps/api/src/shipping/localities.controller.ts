import { Controller, Get, Query } from '@nestjs/common';
import type { LocalityOption } from '@hg/models';
import { LocalitiesService } from './localities.service.js';

@Controller()
export class LocalitiesController {
  constructor(private readonly localities: LocalitiesService) {}

  @Get('localities')
  search(@Query('q') q: unknown): Promise<LocalityOption[]> {
    return this.localities.search(typeof q === 'string' ? q.slice(0, 100) : '');
  }
}
