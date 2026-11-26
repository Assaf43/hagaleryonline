import type { ConfigService } from '@nestjs/config';
import { topFrames } from '../system/error-events.service.js';
import { fingerprint } from '../system/fingerprint.js';
import { scrub } from '../system/scrub.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from './prisma.service.js';

/** Nothing listens here: a validation error is raised before any connection is made. */
const config = { getOrThrow: () => 'postgresql://nobody:nothing@127.0.0.1:1/none' } as unknown as ConfigService;

/** A create with a missing relation and a wrong type: Prisma rejects it while building the query. */
async function validationError(prisma: PrismaService, street: string, name: string): Promise<Error> {
  try {
    await prisma.customerAddress.create({
      data: { street, houseNumber: '5', floor: 'שלישית', hasElevator: true, notes: name },
    } as unknown as Prisma.CustomerAddressCreateArgs);
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a validation error');
}

describe('PrismaService', () => {
  it('validation errors reach logs and error_events without argument values (NFR-11)', async () => {
    const prisma = new PrismaService(config);
    try {
      const error = await validationError(prisma, 'הרצל 5', 'ישראל ישראלי');
      expect(error).toBeInstanceOf(Prisma.PrismaClientValidationError);
      // errorFormat 'minimal': no source code frame or file path from the call site.
      expect(error.message).not.toContain('prisma.service.spec');
      // What AppLogger and ErrorEventsService store and print: the message and the stack's top lines, scrubbed.
      for (const text of [scrub(error.message), scrub(topFrames(error.stack ?? ''))]) {
        expect(text).toContain('Invalid `prisma.customerAddress.create()` invocation');
        expect(text).toContain('[arguments]');
        expect(text).toContain('Argument `customer` is missing.');
        for (const value of ['הרצל', 'ישראל', 'שלישית', 'street:']) expect(text).not.toContain(value);
      }
      // Other values give the same group (one alert, not one per customer).
      const other = await validationError(prisma, 'ויצמן 12', 'דנה כהן');
      const key = (e: Error) => fingerprint({ kind: 'error', source: 'api', message: e.message, stack: e.stack });
      expect(key(other)).toBe(key(error));
    } finally {
      await prisma.$disconnect();
    }
  });
});
