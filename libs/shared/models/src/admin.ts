/**
 * Admin users and permissions (Phase 2a, decisions 48–55), shared by the API and the admin app.
 */

export const PERMISSIONS = [
  { key: 'catalog.view', labelHe: 'צפייה בקטלוג' },
  { key: 'catalog.edit', labelHe: 'עריכת מוצרים, מחירים ומלאי' },
  { key: 'catalog.structure', labelHe: 'קטגוריות, חדרים ורשימות ערכים' },
  { key: 'catalog.import', labelHe: 'ייבוא וייצוא Excel' },
  { key: 'media.manage', labelHe: 'תמונות' },
  { key: 'orders.view', labelHe: 'צפייה בהזמנות' },
  { key: 'orders.manage', labelHe: 'טיפול בהזמנות' },
  { key: 'content.manage', labelHe: 'באנרים ועמודי תוכן' },
  { key: 'audit.view', labelHe: 'צפייה ביומן השינויים' },
] as const;

export type Permission = (typeof PERMISSIONS)[number]['key'];

export const PERMISSION_KEYS: readonly Permission[] = PERMISSIONS.map((p) => p.key);

/** Starting points the Super Admin assigns (decision 49); single permissions can be added or removed per user. */
export const PERMISSION_TEMPLATES = [
  { code: 'manager', labelHe: 'מנהל', permissions: [...PERMISSION_KEYS] },
  {
    code: 'content_editor',
    labelHe: 'עורך תוכן',
    permissions: ['catalog.view', 'catalog.edit', 'catalog.import', 'media.manage', 'content.manage'],
  },
  { code: 'customer_service', labelHe: 'שירות לקוחות', permissions: ['catalog.view', 'orders.view', 'orders.manage'] },
  { code: 'store_seller', labelHe: 'מוכר בחנות', permissions: ['orders.view'] },
] as const satisfies readonly { code: string; labelHe: string; permissions: readonly Permission[] }[];

export type PermissionTemplate = (typeof PERMISSION_TEMPLATES)[number]['code'];

/**
 * What a user may do: the template, plus added, minus removed. The Super Admin may do everything,
 * and is the only one who manages users and permissions (decision 48) — that is not a Permission.
 */
export function effectivePermissions(user: {
  isSuperAdmin: boolean;
  template: string | null;
  extraPermissions: readonly string[];
  removedPermissions: readonly string[];
}): Permission[] {
  if (user.isSuperAdmin) return [...PERMISSION_KEYS];
  const fromTemplate = PERMISSION_TEMPLATES.find((t) => t.code === user.template)?.permissions ?? [];
  const granted = new Set<string>([...fromTemplate, ...user.extraPermissions]);
  for (const p of user.removedPermissions) granted.delete(p);
  return PERMISSION_KEYS.filter((p) => granted.has(p));
}

export type AdminUserStatus = 'invited' | 'active' | 'disabled';

/** GET /api/admin/auth/me */
export interface AdminMe {
  id: number;
  email: string;
  name: string;
  isSuperAdmin: boolean;
  permissions: Permission[];
}

/** POST /api/admin/auth/login and the 2FA steps: what the login screen shows next. */
export type LoginStep = 'setup-2fa' | 'verify-2fa' | 'done';

export interface LoginResponse {
  step: LoginStep;
}

export interface TotpSetup {
  /** otpauth:// URL for authenticator apps. */
  otpauthUrl: string;
  /** PNG data URL of the same, as a QR code. */
  qrDataUrl: string;
  /** For typing in manually. */
  secret: string;
}

/** Shown once, right after enabling 2FA (decision 51). */
export interface RecoveryCodes {
  recoveryCodes: string[];
}

/** Machine-readable error codes; the admin app maps them to Hebrew. */
export type AuthErrorCode =
  | 'invalid_credentials'
  | 'too_many_attempts'
  | 'invalid_code'
  | 'weak_password'
  | 'invalid_link'
  | 'not_authenticated'
  | 'mfa_required'
  | 'forbidden'
  | 'email_taken';

export interface AdminUserRow {
  id: number;
  email: string;
  name: string;
  status: AdminUserStatus;
  isSuperAdmin: boolean;
  template: PermissionTemplate | null;
  extraPermissions: Permission[];
  removedPermissions: Permission[];
  permissions: Permission[];
  twoFactorEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface AdminUserInput {
  email: string;
  name: string;
  template: PermissionTemplate;
  extraPermissions?: Permission[];
  removedPermissions?: Permission[];
}

/** A one-time link the Super Admin copies and sends (decision 52). Shown once. */
export interface OneTimeLink {
  url: string;
  expiresAt: string;
}

export interface AuditEntry {
  id: number;
  createdAt: string;
  actor: { id: number; name: string } | null;
  action: string;
  entityType: string;
  entityId: string | null;
  /** Readable name of the entity (e.g. the user's name), when known. */
  entityLabel: string | null;
  before: unknown;
  after: unknown;
}

export interface AuditPage {
  items: AuditEntry[];
  total: number;
  page: number;
  pageSize: number;
}
