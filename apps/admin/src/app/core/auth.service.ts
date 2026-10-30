import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { AdminMe, LoginResponse, Permission, RecoveryCodes, TotpSetup } from '@hg/models';

const API = '/api/admin/auth';

/** The signed-in admin user and the login steps (decisions 51–53). */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly current = signal<AdminMe | null>(null);
  private loaded = false;

  readonly me = this.current.asReadonly();
  readonly isSuperAdmin = computed(() => this.current()?.isSuperAdmin ?? false);

  can(permission: Permission): boolean {
    return this.current()?.permissions.includes(permission) ?? false;
  }

  /** Loads the session once; null when not signed in (or still waiting for 2FA). */
  async load(force = false): Promise<AdminMe | null> {
    if (this.loaded && !force) return this.current();
    try {
      this.current.set(await firstValueFrom(this.http.get<AdminMe>(`${API}/me`)));
    } catch (e) {
      if (!(e instanceof HttpErrorResponse) || e.status !== 401) throw e;
      this.current.set(null);
    }
    this.loaded = true;
    return this.current();
  }

  login(email: string, password: string, rememberDevice: boolean) {
    return firstValueFrom(this.http.post<LoginResponse>(`${API}/login`, { email, password, rememberDevice }));
  }

  setupTotp() {
    return firstValueFrom(this.http.post<TotpSetup>(`${API}/2fa/setup`, {}));
  }

  async enableTotp(code: string) {
    const result = await firstValueFrom(this.http.post<RecoveryCodes>(`${API}/2fa/enable`, { code }));
    await this.load(true);
    return result;
  }

  async verify(input: { code?: string; recoveryCode?: string }) {
    await firstValueFrom(this.http.post<LoginResponse>(`${API}/2fa/verify`, input));
    await this.load(true);
  }

  async logout(everywhere = false) {
    await firstValueFrom(this.http.post<void>(`${API}/${everywhere ? 'logout-all' : 'logout'}`, {}));
    this.clear();
  }

  changePassword(currentPassword: string, newPassword: string, code: string) {
    return firstValueFrom(this.http.post<void>(`${API}/password`, { currentPassword, newPassword, code }));
  }

  /** After a 401 elsewhere: forget the user so the guard sends them to the login page. */
  clear() {
    this.current.set(null);
    this.loaded = true;
  }
}
