import type { AuditAction, AuditEntityType } from '@hg/models';
import type { AuditService } from '../audit/audit.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { auditDiff, type AuditView } from '../shipping/shipping-audit.js';

export type ContentMeta = { actorId: number; ip?: string };

/**
 * One content audit entry (`content.<entity>.<create|update|delete>`, readable Hebrew-keyed views, never image
 * binaries). Create / delete keep the whole view; an update keeps only the changed keys (nothing changed: no entry).
 */
export async function recordContentChange(
  audit: AuditService,
  tx: Prisma.TransactionClient,
  meta: ContentMeta,
  action: AuditAction,
  entityType: AuditEntityType,
  entityId: number,
  before: AuditView | null,
  after: AuditView | null,
): Promise<void> {
  if (before && after) {
    const change = auditDiff(before, after);
    if (!change) return;
    ({ before, after } = change);
  }
  await audit.record({ actorId: meta.actorId, ip: meta.ip, action, entityType, entityId, before, after }, tx);
}
