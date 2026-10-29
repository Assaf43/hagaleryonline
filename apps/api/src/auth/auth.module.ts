import { Module } from '@nestjs/common';
import { AdminUsersService } from './admin-users.service.js';
import { AuthController, LinksController } from './auth.controller.js';
import { AuthConfig } from './auth.config.js';
import { AuthService } from './auth.service.js';
import { AdminAuthGuard, SameOriginGuard } from './guards.js';
import { SessionService } from './session.service.js';
import { AuditController, UsersController } from './users.controller.js';

@Module({
  controllers: [AuthController, LinksController, UsersController, AuditController],
  providers: [AuthConfig, SessionService, AuthService, AdminUsersService, AdminAuthGuard, SameOriginGuard],
  exports: [AuthConfig, SessionService, AdminUsersService, AdminAuthGuard, SameOriginGuard],
})
export class AuthModule {}
