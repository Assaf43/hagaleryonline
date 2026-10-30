import { Body, Controller, Get, HttpCode, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { CookieOptions, Response } from 'express';
import type { AdminMe, LoginResponse, RecoveryCodes, TotpSetup } from '@hg/models';
import { ADMIN_API_PATH, AuthConfig, SESSION_COOKIE, TRUSTED_SESSION_MS } from './auth.config.js';
import { AuthService, type RequestMeta } from './auth.service.js';
import { bool, optionalStr, str } from './body.js';
import {
  Admin,
  AdminAuthGuard,
  AllowPendingMfa,
  ClientMeta,
  Public,
  SameOriginGuard,
  type AdminContext,
} from './guards.js';

/** Login, 2FA and the current user (ADM-17). */
@Controller('admin/auth')
@UseGuards(SameOriginGuard, AdminAuthGuard)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AuthConfig,
  ) {}

  @Post('login')
  @Public()
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @ClientMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    const remember = bool(body, 'rememberDevice');
    const { token, step } = await this.auth.login(str(body, 'email', 254), str(body, 'password'), remember, meta);
    res.cookie(SESSION_COOKIE, token, this.cookieOptions(remember));
    return { step };
  }

  @Post('2fa/setup')
  @AllowPendingMfa()
  @HttpCode(200)
  setupTotp(@Admin() admin: AdminContext): Promise<TotpSetup> {
    return this.auth.setupTotp(admin);
  }

  @Post('2fa/enable')
  @AllowPendingMfa()
  @HttpCode(200)
  enableTotp(
    @Admin() admin: AdminContext,
    @Body() body: unknown,
    @ClientMeta() meta: RequestMeta,
  ): Promise<RecoveryCodes> {
    return this.auth.enableTotp(admin, str(body, 'code', 16), meta);
  }

  @Post('2fa/verify')
  @AllowPendingMfa()
  @HttpCode(200)
  async verifyMfa(
    @Admin() admin: AdminContext,
    @Body() body: unknown,
    @ClientMeta() meta: RequestMeta,
  ): Promise<LoginResponse> {
    await this.auth.verifyMfa(
      admin,
      { code: optionalStr(body, 'code', 16), recoveryCode: optionalStr(body, 'recoveryCode', 32) },
      meta,
    );
    return { step: 'done' };
  }

  @Post('logout')
  @AllowPendingMfa()
  @HttpCode(204)
  async logout(@Admin() admin: AdminContext, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(admin.session.id);
    res.clearCookie(SESSION_COOKIE, this.cookieOptions(false));
  }

  @Post('logout-all')
  @HttpCode(204)
  async logoutAll(
    @Admin() admin: AdminContext,
    @ClientMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logoutEverywhere(admin.user.id, meta);
    res.clearCookie(SESSION_COOKIE, this.cookieOptions(false));
  }

  @Get('me')
  me(@Admin() admin: AdminContext): AdminMe {
    return this.auth.me(admin.user);
  }

  @Post('password')
  @HttpCode(204)
  async changePassword(
    @Admin() admin: AdminContext,
    @Body() body: unknown,
    @ClientMeta() meta: RequestMeta,
  ): Promise<void> {
    await this.auth.changePassword(
      admin,
      {
        currentPassword: str(body, 'currentPassword'),
        newPassword: str(body, 'newPassword'),
        code: str(body, 'code', 16),
      },
      meta,
    );
  }

  private cookieOptions(remember: boolean): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: 'strict',
      path: ADMIN_API_PATH,
      // Without "remember", a browser-session cookie; the server still enforces the 8 h idle limit.
      ...(remember ? { maxAge: TRUSTED_SESSION_MS } : {}),
    };
  }
}

/** Invite and password-reset links (decision 52). No session: the link is the credential. */
@Controller('admin/links')
@UseGuards(SameOriginGuard, AdminAuthGuard)
@Public()
export class LinksController {
  constructor(private readonly auth: AuthService) {}

  @Get(':token')
  describe(@Param('token') token: string) {
    return this.auth.describeLink(token);
  }

  @Post(':token')
  @HttpCode(204)
  async use(@Param('token') token: string, @Body() body: unknown, @ClientMeta() meta: RequestMeta): Promise<void> {
    await this.auth.useLink(token, str(body, 'password'), meta);
  }
}
