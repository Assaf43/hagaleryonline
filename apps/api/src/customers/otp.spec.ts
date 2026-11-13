import { HttpException } from '@nestjs/common';
import { MemoryOtpStore } from './otp-store.memory.js';
import {
  OTP_MAX_ATTEMPTS,
  OTP_TTL_MS,
  OtpService,
  SIGN_UP_TICKET_TTL_MS,
  hashOtp,
  resolveOtpPepper,
} from './otp.service.js';

const MINUTE = 60_000;
const PHONE = '0501234567';

describe('resolveOtpPepper', () => {
  it('has a fixed default outside production', () => {
    expect(resolveOtpPepper(undefined, 'development')).toBeTruthy();
    expect(resolveOtpPepper('mine', 'test')).toBe('mine');
  });

  it('is required in production, at least 32 characters', () => {
    expect(() => resolveOtpPepper(undefined, 'production')).toThrow(/OTP_PEPPER/);
    expect(() => resolveOtpPepper('short', 'production')).toThrow(/OTP_PEPPER/);
    expect(resolveOtpPepper('x'.repeat(32), 'production')).toBe('x'.repeat(32));
  });
});

describe('OtpService (spec §6.2, NFR-12)', () => {
  let now: number;
  let store: MemoryOtpStore;
  let sent: { channel: string; target: string; code: string }[];
  let ipAllowed: boolean;
  let otp: OtpService;

  const lastCode = () => sent.at(-1)!.code;
  const wrongOf = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

  beforeEach(() => {
    now = Date.UTC(2026, 10, 13, 9, 0, 0);
    store = new MemoryOtpStore(() => now);
    sent = [];
    ipAllowed = true;
    otp = new OtpService(
      store,
      { send: (channel, target, code) => (sent.push({ channel, target, code }), Promise.resolve()) },
      { allow: () => ipAllowed },
      'test-pepper',
      () => now,
    );
  });

  it('sends a 6-digit code and stores only its hash', async () => {
    await otp.request(PHONE, 'sms', 'sign_in', '1.2.3.4');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel: 'sms', target: PHONE });
    expect(lastCode()).toMatch(/^\d{6}$/);
    const [row] = store.rows;
    expect(row.codeHash).not.toContain(lastCode());
    expect(row.codeHash).toBe(hashOtp('test-pepper', lastCode(), PHONE, 'sign_in'));
    expect(row.expiresAt.getTime()).toBe(now + OTP_TTL_MS);
  });

  it('accepts the right code once', async () => {
    await otp.request(PHONE, 'sms', 'sign_in', 'ip');
    const code = lastCode();
    expect(await otp.verify(PHONE, 'sign_in', code)).toBe(true);
    expect(await otp.verify(PHONE, 'sign_in', code)).toBe(false);
  });

  it('binds the code to its target and purpose', async () => {
    await otp.request(PHONE, 'sms', 'sign_in', 'ip');
    expect(await otp.verify('0507654321', 'sign_in', lastCode())).toBe(false);
    expect(await otp.verify(PHONE, 'reset_password', lastCode())).toBe(false);
    expect(await otp.verify(PHONE, 'sign_in', lastCode())).toBe(true);
  });

  it('expires after 10 minutes', async () => {
    await otp.request(PHONE, 'sms', 'sign_in', 'ip');
    now += OTP_TTL_MS;
    expect(await otp.verify(PHONE, 'sign_in', lastCode())).toBe(false);
  });

  it('is still valid just before 10 minutes', async () => {
    await otp.request(PHONE, 'sms', 'sign_in', 'ip');
    now += OTP_TTL_MS - 1;
    expect(await otp.verify(PHONE, 'sign_in', lastCode())).toBe(true);
  });

  it('dies after 5 wrong attempts: the right code no longer works', async () => {
    await otp.request(PHONE, 'sms', 'sign_in', 'ip');
    const code = lastCode();
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) expect(await otp.verify(PHONE, 'sign_in', wrongOf(code))).toBe(false);
    expect(await otp.verify(PHONE, 'sign_in', code)).toBe(false);
  });

  it('still accepts the right code after 4 wrong attempts', async () => {
    await otp.request(PHONE, 'sms', 'sign_in', 'ip');
    const code = lastCode();
    for (let i = 0; i < OTP_MAX_ATTEMPTS - 1; i++) await otp.verify(PHONE, 'sign_in', wrongOf(code));
    expect(await otp.verify(PHONE, 'sign_in', code)).toBe(true);
  });

  it('a new code invalidates the earlier one of the same target and purpose', async () => {
    await otp.request(PHONE, 'sms', 'sign_in', 'ip');
    const first = lastCode();
    await otp.request(PHONE, 'sms', 'sign_in', 'ip');
    const second = lastCode();
    if (first !== second) expect(await otp.verify(PHONE, 'sign_in', first)).toBe(false);
    expect(await otp.verify(PHONE, 'sign_in', second)).toBe(true);
  });

  it('a code of another purpose does not invalidate it', async () => {
    await otp.request(PHONE, 'sms', 'sign_in', 'ip');
    const signIn = lastCode();
    await otp.request(PHONE, 'sms', 'sign_up', 'ip');
    expect(await otp.verify(PHONE, 'sign_in', signIn)).toBe(true);
  });

  it('refuses malformed codes without spending an attempt', async () => {
    await otp.request(PHONE, 'sms', 'sign_in', 'ip');
    for (const bad of ['', '12345', '1234567', 'abcdef']) expect(await otp.verify(PHONE, 'sign_in', bad)).toBe(false);
    expect(store.rows[0].attempts).toBe(0);
  });

  it('sends at most 3 codes per target per 10 minutes; the 4th is silently dropped', async () => {
    for (let i = 0; i < 4; i++) await otp.request(PHONE, 'sms', 'sign_in', 'ip');
    expect(sent).toHaveLength(3);
    expect(store.rows).toHaveLength(3);
    // The last code sent is still the live one.
    expect(await otp.verify(PHONE, 'sign_in', lastCode())).toBe(true);
    now += 10 * MINUTE;
    await otp.request(PHONE, 'sms', 'sign_in', 'ip');
    expect(sent).toHaveLength(4);
  });

  it('throws 429 when the IP is over its limit, and sends nothing', async () => {
    ipAllowed = false;
    const error = await otp.request(PHONE, 'sms', 'sign_in', 'ip').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(429);
    expect(sent).toHaveLength(0);
  });

  it('a sign-up ticket is single use, bound to its target and lives 30 minutes', async () => {
    await otp.request(PHONE, 'sms', 'sign_in', 'ip');
    const row = await otp.check(PHONE, 'sign_in', lastCode());
    expect(row).not.toBeNull();
    const token = await otp.issueSignUpTicket(row!.id);
    expect(store.rows[0].signUpTokenHash).not.toBe(token);
    expect(await otp.peekSignUpTicket(token)).toEqual({ target: PHONE, channel: 'sms' });
    expect(await otp.takeSignUpTicket(token)).toEqual({ target: PHONE, channel: 'sms' });
    expect(await otp.takeSignUpTicket(token)).toBeNull();

    await otp.request('dana@example.test', 'email', 'sign_in', 'ip');
    const other = await otp.issueSignUpTicket((await otp.check('dana@example.test', 'sign_in', lastCode()))!.id);
    now += SIGN_UP_TICKET_TTL_MS;
    expect(await otp.takeSignUpTicket(other)).toBeNull();
  });

  it('finds the pending contact code of a customer', async () => {
    await otp.request('0509999999', 'sms', 'verify_contact', 'ip', { customerId: 'c1' });
    const code = lastCode();
    expect(await otp.checkForCustomer('c2', 'sms', code)).toBeNull();
    expect(await otp.checkForCustomer('c1', 'email', code)).toBeNull();
    expect((await otp.checkForCustomer('c1', 'sms', code))?.target).toBe('0509999999');
  });
});
