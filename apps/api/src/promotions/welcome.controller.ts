import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PromotionsService } from './promotions.service.js';

/**
 * `GET /api/promotions/welcome` (public, spec §6.4): `{ labelHe }` of the active welcome promotion, or JSON `null`.
 * The checkout's sign-in banner reads it in the browser; no session is needed and nothing personal is answered.
 */
@Controller('promotions')
export class WelcomeController {
  constructor(private readonly promotions: PromotionsService) {}

  @Get('welcome')
  async welcome(@Res() res: Response): Promise<void> {
    const benefit = await this.promotions.welcomeBenefit();
    // Sent explicitly: JSON `null` when there is none (Nest would send an empty body). Not cached, so a change in
    // the admin shows at once.
    res.status(HttpStatus.OK).setHeader('Cache-Control', 'no-store').json(benefit);
  }
}
