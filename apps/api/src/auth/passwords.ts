import { hash, verify } from '@node-rs/argon2';
import { ZxcvbnFactory } from '@zxcvbn-ts/core';
import * as common from '@zxcvbn-ts/language-common';
import { CUSTOMER_PASSWORD_MAX, CUSTOMER_PASSWORD_MIN } from '@hg/models';

/** Password rules (decision 59): length over complexity, and no common or guessable passwords. */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;
/** zxcvbn score 0–4; 3 = "safely unguessable", rejects common, breached-list and keyboard patterns. */
const MIN_STRENGTH = 3;

const zxcvbn = new ZxcvbnFactory({ dictionary: common.dictionary, graphs: common.adjacencyGraphs });

export type PasswordProblem = 'too_short' | 'too_long' | 'too_common' | 'too_personal';

/**
 * Checks a new password. `related` are words the user would be tempted to use
 * (their e-mail, name, the store name) — they make a password weaker.
 */
export function checkPassword(password: string, related: string[] = []): PasswordProblem | null {
  if (password.length < MIN_PASSWORD_LENGTH) return 'too_short';
  if (password.length > MAX_PASSWORD_LENGTH) return 'too_long';
  const words = related.flatMap((r) => r.toLowerCase().split(/[@.\s_-]+/)).filter((w) => w.length >= 3);
  const lower = password.toLowerCase();
  if (words.some((w) => lower.includes(w))) return 'too_personal';
  return zxcvbn.check(password, [...words, 'hagalery', 'galery', 'הגלריה']).score < MIN_STRENGTH ? 'too_common' : null;
}

/**
 * A customer's password (Phase 5c): only its length, 8–128 characters. Customers sign in mostly by code; the admin's
 * strength rules above are for staff accounts.
 */
export function checkCustomerPassword(password: string): 'too_short' | 'too_long' | null {
  if (password.length < CUSTOMER_PASSWORD_MIN) return 'too_short';
  if (password.length > CUSTOMER_PASSWORD_MAX) return 'too_long';
  return null;
}

/** argon2id with the library's OWASP-aligned defaults. */
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** Same cost as a real check, for unknown e-mails, so response time does not reveal which accounts exist. */
let dummyHash: Promise<string> | undefined;
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hash('dummy-password-for-timing');
  await verifyPassword(await dummyHash, password);
  return false;
}
