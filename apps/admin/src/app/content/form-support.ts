import { signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import type { ErrorStateMatcher } from '@angular/material/core';
import { errorMessage } from '../core/errors';

/** Field errors of a content form: the matcher marks a Material field invalid while the last check found a problem. */
export class FieldErrors {
  readonly all = signal<Record<string, string>>({});
  private readonly matchers = new Map<string, ErrorStateMatcher>();

  matcher(field: string): ErrorStateMatcher {
    let m = this.matchers.get(field);
    if (!m) {
      m = { isErrorState: () => !!this.all()[field] };
      this.matchers.set(field, m);
    }
    return m;
  }

  set(errors: Record<string, string>) {
    this.all.set(errors);
  }

  clear(field: string) {
    if (!this.all()[field]) return;
    this.all.update((all) => {
      const next = { ...all };
      delete next[field];
      return next;
    });
  }
}

/** A refused save: the field the API named (if any) and the Hebrew sentence for it. */
export function refusal(e: unknown): { code: string | null; field: string | null; message: string } {
  const body = (e instanceof HttpErrorResponse ? e.error : null) as { code?: string; field?: string } | null;
  const field = e instanceof HttpErrorResponse && body?.field ? body.field : null;
  return { code: body?.code ?? null, field, message: errorMessage(e) };
}

export const LEAVE_PROMPT = 'יש שינויים שלא נשמרו. לצאת בלי לשמור?';
