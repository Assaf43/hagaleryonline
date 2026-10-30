import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { AdminUserInput, AdminUserRow, AuditPage, OneTimeLink, Permission, PermissionTemplate } from '@hg/models';

export interface AdminUserPatch {
  name?: string;
  template?: PermissionTemplate;
  extraPermissions?: Permission[];
  removedPermissions?: Permission[];
  status?: 'active' | 'disabled';
}

/** Users and permissions (Super Admin), invite/reset links and the audit log. */
@Injectable({ providedIn: 'root' })
export class UsersApi {
  private readonly http = inject(HttpClient);

  list() {
    return firstValueFrom(this.http.get<AdminUserRow[]>('/api/admin/users'));
  }

  create(input: AdminUserInput) {
    return firstValueFrom(this.http.post<{ user: AdminUserRow; invite: OneTimeLink }>('/api/admin/users', input));
  }

  update(id: number, patch: AdminUserPatch) {
    return firstValueFrom(this.http.patch<AdminUserRow>(`/api/admin/users/${id}`, patch));
  }

  inviteLink(id: number) {
    return firstValueFrom(this.http.post<OneTimeLink>(`/api/admin/users/${id}/invite-link`, {}));
  }

  passwordResetLink(id: number) {
    return firstValueFrom(this.http.post<OneTimeLink>(`/api/admin/users/${id}/reset-password`, {}));
  }

  resetTwoFactor(id: number) {
    return firstValueFrom(this.http.post<void>(`/api/admin/users/${id}/reset-2fa`, {}));
  }

  revokeSessions(id: number) {
    return firstValueFrom(this.http.post<void>(`/api/admin/users/${id}/revoke-sessions`, {}));
  }

  audit(page: number, filter: { entityType?: string; entityId?: string } = {}) {
    const params = { page: String(page), ...filter } as Record<string, string>;
    return firstValueFrom(this.http.get<AuditPage>('/api/admin/audit', { params }));
  }

  describeLink(token: string) {
    return firstValueFrom(
      this.http.get<{ type: 'invite' | 'reset'; email: string; name: string }>(
        `/api/admin/links/${encodeURIComponent(token)}`,
      ),
    );
  }

  useLink(token: string, password: string) {
    return firstValueFrom(this.http.post<void>(`/api/admin/links/${encodeURIComponent(token)}`, { password }));
  }
}
