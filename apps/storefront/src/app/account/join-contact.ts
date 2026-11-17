import { Injectable } from '@angular/core';

/** The contact a guest typed at checkout. */
export interface JoinContactData {
  fullName: string;
  phone: string;
  email: string;
}

const KEY = 'hg.join-contact';

/**
 * Keeps a guest's checkout contact in this tab's `sessionStorage` while the payment page is open, so the order page
 * can offer to join the club with those details filled in (CLB-01). Never in a URL, never sent to the server, never
 * linked to the order (decision 77); the order page clears it as soon as it decides on the join box (keeping it in
 * memory for the click). Storage can be unavailable: then the join form simply starts empty.
 */
@Injectable({ providedIn: 'root' })
export class JoinContact {
  save(contact: JoinContactData): void {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(contact));
    } catch {
      // No storage: the sign-up form starts empty.
    }
  }

  read(): JoinContactData | null {
    try {
      const raw = sessionStorage.getItem(KEY);
      const v = raw ? (JSON.parse(raw) as Partial<Record<keyof JoinContactData, unknown>>) : null;
      if (v && typeof v.fullName === 'string' && typeof v.phone === 'string' && typeof v.email === 'string')
        return { fullName: v.fullName, phone: v.phone, email: v.email };
    } catch {
      // Damaged or unavailable: nothing to prefill.
    }
    return null;
  }

  clear(): void {
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      // Nothing stored.
    }
  }
}
