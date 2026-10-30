import { BadRequestException } from '@nestjs/common';

/** Minimal request-body checks for the admin auth endpoints. */
export function str(body: unknown, key: string, max = 256): string {
  const value = (body as Record<string, unknown> | undefined)?.[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > max)
    throw new BadRequestException(`${key} is required`);
  return value;
}

export function optionalStr(body: unknown, key: string, max = 256): string | undefined {
  const value = (body as Record<string, unknown> | undefined)?.[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max) throw new BadRequestException(`invalid ${key}`);
  return value;
}

export function bool(body: unknown, key: string): boolean {
  return (body as Record<string, unknown> | undefined)?.[key] === true;
}

export function id(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new BadRequestException('invalid id');
  return n;
}
