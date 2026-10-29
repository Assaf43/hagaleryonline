import { CanActivate, ExecutionContext, Injectable, SetMetadata, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { effectivePermissions, type Permission } from '@hg/models';
import { AuthConfig, SESSION_COOKIE } from './auth.config.js';
import { forbidden, mfaRequired, notAuthenticated } from './auth-errors.js';
import { SessionService, type ResolvedSession } from './session.service.js';

export interface AdminContext extends ResolvedSession {
  permissions: Permission[];
}

type AdminRequest = Request & { admin?: AdminContext };

const PUBLIC = 'admin:public';
const ALLOW_PENDING_MFA = 'admin:allow-pending-mfa';
const PERMISSION = 'admin:permission';
const SUPER_ADMIN = 'admin:super-admin';

/** No session needed (login, invite links). */
export const Public = () => SetMetadata(PUBLIC, true);
/** Reachable between password and 2FA (the 2FA steps themselves, logout). */
export const AllowPendingMfa = () => SetMetadata(ALLOW_PENDING_MFA, true);
export const RequirePermission = (permission: Permission) => SetMetadata(PERMISSION, permission);
/** Users and permissions are the Super Admin's alone (decision 48). */
export const SuperAdminOnly = () => SetMetadata(SUPER_ADMIN, true);

export const Admin = createParamDecorator((_: unknown, ctx: ExecutionContext): AdminContext => {
  const admin = ctx.switchToHttp().getRequest<AdminRequest>().admin;
  if (!admin) throw notAuthenticated();
  return admin;
});

export const ClientMeta = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<Request>();
  return { ip: req.ip, userAgent: req.get('user-agent') };
});

/**
 * CSRF defence for cookie-authenticated requests: anything that changes state must come from the
 * admin app's own origin. Together with SameSite=Strict cookies.
 */
@Injectable()
export class SameOriginGuard implements CanActivate {
  constructor(private readonly config: AuthConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
    const origin = req.get('origin') ?? originOf(req.get('referer'));
    if (!origin || !this.config.allowedOrigins.includes(origin)) throw forbidden();
    return true;
  }
}

/** Resolves the session cookie and enforces 2FA, permissions and Super Admin–only routes. */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const flag = <T>(key: string) => this.reflector.getAllAndOverride<T>(key, [ctx.getHandler(), ctx.getClass()]);
    if (flag<boolean>(PUBLIC)) return true;

    const req = ctx.switchToHttp().getRequest<AdminRequest>();
    const resolved = await this.sessions.resolve(req.cookies?.[SESSION_COOKIE]);
    if (!resolved) throw notAuthenticated();
    req.admin = { ...resolved, permissions: effectivePermissions(resolved.user) };

    if (!resolved.session.mfaVerified && !flag<boolean>(ALLOW_PENDING_MFA)) throw mfaRequired();
    if (flag<boolean>(SUPER_ADMIN) && !resolved.user.isSuperAdmin) throw forbidden();
    const permission = flag<Permission>(PERMISSION);
    if (permission && !req.admin.permissions.includes(permission)) throw forbidden();
    return true;
  }
}

function originOf(url: string | undefined): string | undefined {
  try {
    return url ? new URL(url).origin : undefined;
  } catch {
    return undefined;
  }
}
