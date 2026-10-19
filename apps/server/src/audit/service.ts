import type { AuditLogPageDto } from '@bookr/shared';
import { desc, eq, sql } from 'drizzle-orm';
import type { AppDeps } from '../app';
import { auditLogs, users } from '../db/schema';

/** Page requested by the administration audit screen. */
export interface AuditLogQuery {
  page: number;
  pageSize: number;
}

/**
 * Lists audit entries newest first, resolving the actor's display name. The
 * id tie-breaker keeps pagination stable when several rows share a timestamp.
 */
export async function listAuditEntries(
  deps: AppDeps,
  query: AuditLogQuery,
): Promise<AuditLogPageDto> {
  const [rows, [counted]] = await Promise.all([
    deps.db
      .select({
        id: auditLogs.id,
        userId: auditLogs.userId,
        displayName: users.displayName,
        action: auditLogs.action,
        target: auditLogs.target,
        metadata: auditLogs.metadata,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .leftJoin(users, eq(auditLogs.userId, users.id))
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    deps.db.select({ count: sql<string>`count(*)` }).from(auditLogs),
  ]);

  return {
    items: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
    page: query.page,
    pageSize: query.pageSize,
    total: Number(counted?.count ?? 0),
  };
}
