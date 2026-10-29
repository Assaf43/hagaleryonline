import { BadRequestException, Injectable } from '@nestjs/common';
import type { AdminMe, LoginStep, OneTimeLink, RecoveryCodes, TotpSetup } from '@hg/models';
import { effectivePermissions } from '@hg/models';
import { AdminTokenType, AdminUserStatus, type AdminUser } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuthConfig, INVITE_TTL_MS, RESET_TTL_MS } from './auth.config.js';
import { invalidCode, invalidCredentials, invalidLink, tooManyAttempts, weakPassword } from './auth-errors.js';
import { hashToken, randomToken } from './crypto.js';
import { IpThrottle, accountDelayMs } from './login-throttle.js';
import { checkPassword, hashPassword, verifyAgainstDummy, verifyPassword } from './passwords.js';
import { SessionService, type ResolvedSession } from './session.service.js';
import { newRecoveryCodes, newTotpSecret, normalizeRecoveryCode, totpSetupFor, verifyTotp } from './totp.js';

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

/**
 * Admin login (decisions 51–53, 59): password → 2FA (set up on first login) → session.
 * Wrong passwords and codes share one progressive delay per account and one limit per IP.
 */
@Injectable()
export class AuthService {
  private readonly ipThrottle: IpThrottle;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly config: AuthConfig,
  ) {
    this.ipThrottle = new IpThrottle(config.ipAttemptLimit);
  }

  async login(email: string, password: string, remember: boolean, meta: RequestMeta) {
    this.throttleIp(meta.ip);
    const user = await this.prisma.adminUser.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!user || user.status !== AdminUserStatus.ACTIVE || !user.passwordHash) {
      await verifyAgainstDummy(password);
      throw invalidCredentials();
    }
    this.assertNotBlocked(user);
    if (!(await verifyPassword(user.passwordHash, password))) {
      await this.registerFailure(user);
      throw invalidCredentials();
    }

    const token = await this.sessions.start(user.id, { mfaVerified: false, trusted: remember, ...meta });
    const step: LoginStep = user.totpEnabledAt ? 'verify-2fa' : 'setup-2fa';
    return { token, step };
  }

  /** First login: a fresh secret to scan. Not active until a code from it is confirmed. */
  async setupTotp({ user, session }: ResolvedSession): Promise<TotpSetup> {
    if (session.mfaVerified || user.totpEnabledAt) throw new BadRequestException('2FA is already set up');
    const secret = newTotpSecret();
    await this.prisma.adminUser.update({
      where: { id: user.id },
      data: { totpSecretEnc: this.config.secretBox.encrypt(secret) },
    });
    return totpSetupFor(secret, user.email);
  }

  async enableTotp({ user, session }: ResolvedSession, code: string, meta: RequestMeta): Promise<RecoveryCodes> {
    if (session.mfaVerified || user.totpEnabledAt || !user.totpSecretEnc)
      throw new BadRequestException('Start 2FA setup first');
    this.throttleIp(meta.ip);
    this.assertNotBlocked(user);
    if (!verifyTotp(this.config.secretBox.decrypt(user.totpSecretEnc), code)) {
      await this.registerFailure(user);
      throw invalidCode();
    }

    const codes = newRecoveryCodes();
    const hashes = await Promise.all(codes.map((c) => hashPassword(c)));
    await this.prisma.$transaction(async (tx) => {
      await tx.adminRecoveryCode.deleteMany({ where: { userId: user.id } });
      await tx.adminRecoveryCode.createMany({ data: hashes.map((codeHash) => ({ userId: user.id, codeHash })) });
      await tx.adminUser.update({ where: { id: user.id }, data: { totpEnabledAt: new Date() } });
      await this.audit.record(
        { actorId: user.id, action: 'auth.2fa_enabled', entityType: 'admin_user', entityId: user.id, ip: meta.ip },
        tx,
      );
    });
    await this.completeLogin(user, session.id, session.trusted, 'totp', meta);
    return { recoveryCodes: codes };
  }

  /** Second step of every later login: a code from the app, or one recovery code. */
  async verifyMfa(
    { user, session }: ResolvedSession,
    input: { code?: string; recoveryCode?: string },
    meta: RequestMeta,
  ) {
    if (session.mfaVerified) return;
    if (!user.totpEnabledAt || !user.totpSecretEnc) throw new BadRequestException('2FA is not set up');
    this.throttleIp(meta.ip);
    this.assertNotBlocked(user);

    let method: 'totp' | 'recovery_code' | null = null;
    if (input.code && verifyTotp(this.config.secretBox.decrypt(user.totpSecretEnc), input.code)) method = 'totp';
    else if (input.recoveryCode && (await this.useRecoveryCode(user.id, input.recoveryCode))) method = 'recovery_code';

    if (!method) {
      await this.registerFailure(user);
      throw invalidCode();
    }
    await this.completeLogin(user, session.id, session.trusted, method, meta);
  }

  async logout(sessionId: number) {
    await this.sessions.revoke(sessionId);
  }

  async logoutEverywhere(userId: number, meta: RequestMeta) {
    await this.sessions.revokeAll(userId);
    await this.audit.record({
      actorId: userId,
      action: 'auth.logout_all',
      entityType: 'admin_user',
      entityId: userId,
      ip: meta.ip,
    });
  }

  me(user: AdminUser): AdminMe {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      isSuperAdmin: user.isSuperAdmin,
      permissions: effectivePermissions(user),
    };
  }

  /** Needs the current password and a 2FA code; logs out every other session (decision 59). */
  async changePassword(
    { user, session }: ResolvedSession,
    input: { currentPassword: string; newPassword: string; code: string },
    meta: RequestMeta,
  ) {
    this.throttleIp(meta.ip);
    this.assertNotBlocked(user);
    const passwordOk = !!user.passwordHash && (await verifyPassword(user.passwordHash, input.currentPassword));
    const codeOk = !!user.totpSecretEnc && verifyTotp(this.config.secretBox.decrypt(user.totpSecretEnc), input.code);
    if (!passwordOk || !codeOk) {
      await this.registerFailure(user);
      throw passwordOk ? invalidCode() : invalidCredentials();
    }
    await this.setPassword(user, input.newPassword);
    await this.sessions.revokeAll(user.id, session.id);
    await this.audit.record({
      actorId: user.id,
      action: 'auth.password_changed',
      entityType: 'admin_user',
      entityId: user.id,
      ip: meta.ip,
    });
  }

  // ---------- one-time links (decision 52) ----------

  async issueLink(userId: number, type: AdminTokenType): Promise<OneTimeLink> {
    const token = randomToken();
    const expiresAt = new Date(Date.now() + (type === AdminTokenType.INVITE ? INVITE_TTL_MS : RESET_TTL_MS));
    await this.prisma.$transaction([
      // A new link replaces any earlier unused one of the same kind.
      this.prisma.adminToken.updateMany({ where: { userId, type, usedAt: null }, data: { usedAt: new Date() } }),
      this.prisma.adminToken.create({ data: { userId, type, tokenHash: hashToken(token), expiresAt } }),
    ]);
    const path = type === AdminTokenType.INVITE ? 'invite' : 'reset-password';
    return { url: `${this.config.adminUrl}/${path}/${token}`, expiresAt: expiresAt.toISOString() };
  }

  /** What a link is for, so the page can greet the user. */
  async describeLink(token: string) {
    const { record, user } = await this.findLink(token);
    return {
      type: record.type === AdminTokenType.INVITE ? ('invite' as const) : ('reset' as const),
      email: user.email,
      name: user.name,
    };
  }

  /** Sets the password from an invite or reset link. Only the user ever chooses it (decision 59). */
  async useLink(token: string, password: string, meta: RequestMeta) {
    this.throttleIp(meta.ip);
    const { record, user } = await this.findLink(token);
    await this.setPassword(user, password);
    await this.prisma.$transaction(async (tx) => {
      await tx.adminToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
      await tx.adminUser.update({
        where: { id: user.id },
        data: { status: AdminUserStatus.ACTIVE, failedLogins: 0, loginBlockedUntil: null },
      });
      await this.audit.record(
        {
          actorId: user.id,
          action: record.type === AdminTokenType.INVITE ? 'user.invite_accepted' : 'auth.password_reset',
          entityType: 'admin_user',
          entityId: user.id,
          ip: meta.ip,
        },
        tx,
      );
    });
    if (record.type === AdminTokenType.PASSWORD_RESET) await this.sessions.revokeAll(user.id);
  }

  // ---------- internals ----------

  private async findLink(token: string) {
    const record = await this.prisma.adminToken.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });
    if (!record || record.usedAt || record.expiresAt <= new Date()) throw invalidLink();
    const { user } = record;
    const valid =
      record.type === AdminTokenType.INVITE
        ? user.status === AdminUserStatus.INVITED
        : user.status === AdminUserStatus.ACTIVE;
    if (!valid) throw invalidLink();
    return { record, user };
  }

  private async setPassword(user: AdminUser, password: string) {
    const problem = checkPassword(password, [user.email, user.name]);
    if (problem) throw weakPassword(problem);
    await this.prisma.adminUser.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(password) },
    });
  }

  private async completeLogin(user: AdminUser, sessionId: number, trusted: boolean, method: string, meta: RequestMeta) {
    await this.sessions.completeMfa(sessionId, trusted);
    await this.prisma.adminUser.update({
      where: { id: user.id },
      data: { failedLogins: 0, loginBlockedUntil: null, lastLoginAt: new Date() },
    });
    await this.audit.record({
      actorId: user.id,
      action: 'auth.login',
      entityType: 'admin_user',
      entityId: user.id,
      after: { method, trustedDevice: trusted },
      ip: meta.ip,
    });
  }

  private async useRecoveryCode(userId: number, code: string): Promise<boolean> {
    const normalized = normalizeRecoveryCode(code);
    const unused = await this.prisma.adminRecoveryCode.findMany({ where: { userId, usedAt: null } });
    for (const candidate of unused) {
      if (await verifyPassword(candidate.codeHash, normalized)) {
        const { count } = await this.prisma.adminRecoveryCode.updateMany({
          where: { id: candidate.id, usedAt: null },
          data: { usedAt: new Date() },
        });
        return count === 1;
      }
    }
    return false;
  }

  private throttleIp(ip: string | undefined) {
    if (!this.ipThrottle.allow(ip ?? 'unknown')) throw tooManyAttempts(15 * 60);
  }

  private assertNotBlocked(user: AdminUser) {
    const waitMs = (user.loginBlockedUntil?.getTime() ?? 0) - Date.now();
    if (waitMs > 0) throw tooManyAttempts(Math.ceil(waitMs / 1000));
  }

  private async registerFailure(user: AdminUser) {
    const failures = user.failedLogins + 1;
    const delay = accountDelayMs(failures);
    await this.prisma.adminUser.update({
      where: { id: user.id },
      data: { failedLogins: failures, loginBlockedUntil: delay ? new Date(Date.now() + delay) : null },
    });
  }
}
