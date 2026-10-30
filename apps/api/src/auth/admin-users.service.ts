import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  PERMISSION_KEYS,
  PERMISSION_TEMPLATES,
  effectivePermissions,
  type AdminUserInput,
  type AdminUserRow,
  type OneTimeLink,
  type Permission,
  type PermissionTemplate,
} from '@hg/models';
import { AdminTokenType, AdminUserStatus, Prisma, type AdminUser } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuthService } from './auth.service.js';
import { SessionService } from './session.service.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATUS: Record<AdminUserStatus, AdminUserRow['status']> = {
  INVITED: 'invited',
  ACTIVE: 'active',
  DISABLED: 'disabled',
};

export interface AdminUserPatch {
  name?: string;
  template?: PermissionTemplate;
  extraPermissions?: Permission[];
  removedPermissions?: Permission[];
  /** Only between active and disabled; invited users become active by accepting the invite. */
  status?: 'active' | 'disabled';
}

/**
 * User management (decisions 48–52). Only the Super Admin calls these (enforced by the controller),
 * and nobody — including the Super Admin — can change the Super Admin through them.
 */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<AdminUserRow[]> {
    const users = await this.prisma.adminUser.findMany({ orderBy: [{ isSuperAdmin: 'desc' }, { name: 'asc' }] });
    return users.map(toRow);
  }

  async create(
    input: AdminUserInput,
    actorId: number,
    ip?: string,
  ): Promise<{ user: AdminUserRow; invite: OneTimeLink }> {
    const data = validateInput(input);
    try {
      const user = await this.prisma.adminUser.create({ data: { ...data, status: AdminUserStatus.INVITED } });
      await this.audit.record({
        actorId,
        action: 'user.create',
        entityType: 'admin_user',
        entityId: user.id,
        after: auditView(user),
        ip,
      });
      return { user: toRow(user), invite: await this.auth.issueLink(user.id, AdminTokenType.INVITE) };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
        throw new ConflictException({ code: 'email_taken' });
      throw e;
    }
  }

  async update(id: number, patch: AdminUserPatch, actorId: number, ip?: string): Promise<AdminUserRow> {
    const before = await this.findEditable(id);
    const data: Prisma.AdminUserUpdateInput = {};
    if (patch.name !== undefined) data.name = requiredText(patch.name, 'name', 100);
    if (patch.template !== undefined) data.template = validTemplate(patch.template);
    if (patch.extraPermissions !== undefined) data.extraPermissions = validPermissions(patch.extraPermissions);
    if (patch.removedPermissions !== undefined) data.removedPermissions = validPermissions(patch.removedPermissions);
    if (patch.status !== undefined) {
      if (before.status === AdminUserStatus.INVITED)
        throw new BadRequestException('An invited user becomes active by accepting the invite');
      if (patch.status !== 'active' && patch.status !== 'disabled')
        throw new BadRequestException('status must be active or disabled');
      data.status = patch.status === 'active' ? AdminUserStatus.ACTIVE : AdminUserStatus.DISABLED;
    }

    const after = await this.prisma.adminUser.update({ where: { id }, data });
    if (after.status === AdminUserStatus.DISABLED) await this.sessions.revokeAll(id);
    await this.audit.record({
      actorId,
      action: 'user.update',
      entityType: 'admin_user',
      entityId: id,
      before: auditView(before),
      after: auditView(after),
      ip,
    });
    return toRow(after);
  }

  /** A fresh invite link for someone who has not joined yet; earlier links stop working. */
  async inviteLink(id: number, actorId: number, ip?: string): Promise<OneTimeLink> {
    const user = await this.findEditable(id);
    if (user.status !== AdminUserStatus.INVITED) throw new BadRequestException('The user has already joined');
    await this.audit.record({ actorId, action: 'user.invite_link', entityType: 'admin_user', entityId: id, ip });
    return this.auth.issueLink(id, AdminTokenType.INVITE);
  }

  /** The Super Admin never sets a password — they hand over a link where the user chooses one (decision 59). */
  async passwordResetLink(id: number, actorId: number, ip?: string): Promise<OneTimeLink> {
    const user = await this.findEditable(id);
    if (user.status !== AdminUserStatus.ACTIVE) throw new BadRequestException('Only active users can reset a password');
    await this.audit.record({
      actorId,
      action: 'user.password_reset_link',
      entityType: 'admin_user',
      entityId: id,
      ip,
    });
    return this.auth.issueLink(id, AdminTokenType.PASSWORD_RESET);
  }

  /** Lost phone: 2FA is set up again at the next login. */
  async resetTwoFactor(id: number, actorId: number | null, ip?: string, allowSuperAdmin = false): Promise<void> {
    const user = allowSuperAdmin ? await this.findUser(id) : await this.findEditable(id);
    await this.prisma.$transaction([
      this.prisma.adminRecoveryCode.deleteMany({ where: { userId: id } }),
      this.prisma.adminUser.update({ where: { id }, data: { totpSecretEnc: null, totpEnabledAt: null } }),
    ]);
    await this.sessions.revokeAll(user.id);
    await this.audit.record({ actorId, action: 'user.2fa_reset', entityType: 'admin_user', entityId: id, ip });
  }

  async revokeSessions(id: number, actorId: number, ip?: string): Promise<void> {
    await this.findEditable(id);
    await this.sessions.revokeAll(id);
    await this.audit.record({ actorId, action: 'user.sessions_revoked', entityType: 'admin_user', entityId: id, ip });
  }

  // ---------- CLI only ----------

  /** The one Super Admin (decision 48), created from the server CLI. Returns the invite link. */
  async createSuperAdmin(email: string, name: string): Promise<OneTimeLink> {
    if (await this.prisma.adminUser.findFirst({ where: { isSuperAdmin: true } })) {
      throw new ConflictException('A Super Admin already exists');
    }
    const data = validateInput({ email, name, template: 'manager' });
    const user = await this.prisma.adminUser.create({
      data: { email: data.email, name: data.name, isSuperAdmin: true, template: null, status: AdminUserStatus.INVITED },
    });
    await this.audit.record({
      actorId: null,
      action: 'user.create_super_admin',
      entityType: 'admin_user',
      entityId: user.id,
      after: auditView(user),
    });
    return this.auth.issueLink(user.id, AdminTokenType.INVITE);
  }

  /** Emergency reset of any user's 2FA from the server, including the Super Admin (decision 51). */
  async resetTwoFactorByEmail(email: string): Promise<void> {
    const user = await this.prisma.adminUser.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!user) throw new NotFoundException('No such user');
    await this.resetTwoFactor(user.id, null, 'cli', true);
  }

  private async findUser(id: number): Promise<AdminUser> {
    const user = await this.prisma.adminUser.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('No such user');
    return user;
  }

  private async findEditable(id: number): Promise<AdminUser> {
    const user = await this.findUser(id);
    if (user.isSuperAdmin) throw new BadRequestException('The Super Admin cannot be changed here');
    return user;
  }
}

function validateInput(input: AdminUserInput) {
  const email = requiredText(input.email, 'email', 254).toLowerCase();
  if (!EMAIL.test(email)) throw new BadRequestException('invalid email');
  return {
    email,
    name: requiredText(input.name, 'name', 100),
    template: validTemplate(input.template),
    extraPermissions: validPermissions(input.extraPermissions ?? []),
    removedPermissions: validPermissions(input.removedPermissions ?? []),
  };
}

function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new BadRequestException(`invalid ${field}`);
  return value.trim();
}

function validTemplate(value: unknown): PermissionTemplate {
  const template = PERMISSION_TEMPLATES.find((t) => t.code === value);
  if (!template) throw new BadRequestException('invalid template');
  return template.code;
}

function validPermissions(value: unknown): Permission[] {
  if (!Array.isArray(value) || !value.every((p) => PERMISSION_KEYS.includes(p as Permission))) {
    throw new BadRequestException('invalid permissions');
  }
  return [...new Set(value as Permission[])];
}

function toRow(u: AdminUser): AdminUserRow {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    status: STATUS[u.status],
    isSuperAdmin: u.isSuperAdmin,
    template: (u.template as PermissionTemplate | null) ?? null,
    extraPermissions: u.extraPermissions as Permission[],
    removedPermissions: u.removedPermissions as Permission[],
    permissions: effectivePermissions(u),
    twoFactorEnabled: !!u.totpEnabledAt,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
  };
}

/** What the audit log keeps about a user — never hashes or secrets. */
function auditView(u: AdminUser) {
  return {
    email: u.email,
    name: u.name,
    status: STATUS[u.status],
    template: u.template,
    extraPermissions: u.extraPermissions,
    removedPermissions: u.removedPermissions,
  };
}
