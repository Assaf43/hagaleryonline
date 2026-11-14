import { Injectable, signal } from '@angular/core';

/**
 * A sign-up the sign-in page hands over (spec §6.1): a code was entered for a phone or e-mail with no account, so
 * the sign-up page continues with that contact filled and the server's ticket. Kept in memory only (never in a URL).
 */
export interface SignUpDraftData {
  phone: string | null;
  email: string | null;
  signUpToken: string;
  /** The contacts the ticket covers. */
  verified: { phone: string | null; email: string | null };
}

@Injectable({ providedIn: 'root' })
export class SignUpDraft {
  private readonly data = signal<SignUpDraftData | null>(null);

  readonly current = this.data.asReadonly();

  set(draft: SignUpDraftData): void {
    this.data.set(draft);
  }

  clear(): void {
    this.data.set(null);
  }
}
