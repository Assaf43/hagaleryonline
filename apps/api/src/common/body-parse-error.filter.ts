import { ArgumentsHost, BadRequestException, Catch } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Request } from 'express';

/**
 * A body the JSON parser rejects. Nest turns the parser's SyntaxError into a 400 carrying the parser's own message,
 * which quotes the start of the input (`Unexpected token 'S', "{"a": S…" is not valid JSON`), so it is replaced with a
 * fixed one (NFR-07). Such an error comes from the parser middleware, before any route matched (`req.route` unset);
 * a 400 thrown by a handler is left alone, as is every other error.
 */
@Catch(BadRequestException)
export class BodyParseErrorFilter extends BaseExceptionFilter {
  override catch(error: BadRequestException, host: ArgumentsHost): void {
    const req = host.switchToHttp().getRequest<Request>();
    super.catch(req.route ? error : new BadRequestException('Invalid JSON body'), host);
  }
}
