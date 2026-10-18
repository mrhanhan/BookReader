import { z } from 'zod';
import { locatorSchema } from './locators';
import { ANNOTATION_COLORS, MAX_TAGS, MAX_TAG_LENGTH } from './schemas/reading';

/** Entity kinds carried by the sync protocol, in the order clients register them. */
export const SYNC_ENTITY_TYPES = [
  'reading_progress',
  'annotation',
  'bookmark',
  'reader_settings',
] as const;

export type SyncEntityType = (typeof SYNC_ENTITY_TYPES)[number];

/** Operations a client may push for an entity. */
export const SYNC_OPS = ['upsert', 'delete'] as const;

export type SyncOp = (typeof SYNC_OPS)[number];

/** Maximum number of changes accepted in one push request. */
export const SYNC_PUSH_MAX_CHANGES = 100;
/** Page size used by a pull when the client does not ask for one. */
export const SYNC_PULL_DEFAULT_LIMIT = 200;
/** Largest page a client may request. */
export const SYNC_PULL_MAX_LIMIT = 500;
/** How far a client clock may run ahead before the server distrusts it. */
export const SYNC_CLOCK_SKEW_MS = 5 * 60 * 1000;
/** How long the change log is retained before clients must resnapshot. */
export const SYNC_RETENTION_DAYS = 90;
/** Maximum serialized size of the reader settings payload. */
export const SYNC_SETTINGS_MAX_BYTES = 16 * 1024;

/** Why the server refused to apply one pushed change. */
export type SyncRejectReason =
  | 'not_allowed'
  | 'unknown_entity'
  | 'invalid_payload'
  | 'unsupported_op';

/** One change as sent by a client, before the server assigns a revision. */
export interface SyncPushChange {
  entityType: SyncEntityType;
  entityId: string;
  op: SyncOp;
  clientUpdatedAt: string;
  payload?: unknown;
}

/** One change as recorded in the log and returned by push/pull. */
export interface SyncChangeEnvelope {
  revision: number;
  entityType: SyncEntityType;
  entityId: string;
  op: SyncOp;
  payload: unknown;
  clientUpdatedAt: string;
  serverUpdatedAt: string;
}

/** Outcome of a push: applied changes, no-ops and refusals. */
export interface SyncPushResult {
  applied: SyncChangeEnvelope[];
  skipped: string[];
  rejected: Array<{ key: string; reason: SyncRejectReason }>;
  /**
   * Revision of the last change applied in this batch, or 0 when nothing was
   * applied. This is an acknowledgement marker, not a pull cursor: clients
   * advance their pull cursor from `SyncPullResult.cursor`.
   */
  cursor: number;
}

/** One page of the change log, or a full snapshot when the cursor is too old. */
export interface SyncPullResult {
  changes: SyncChangeEnvelope[];
  cursor: number;
  hasMore: boolean;
  reset: boolean;
}

/** Full state returned when a client cannot resume from its cursor. */
export interface SyncSnapshot {
  cursor: number;
  progress: unknown[];
  annotations: unknown[];
  bookmarks: unknown[];
  settings: unknown | null;
}

/** Stable identity of one entity inside the change log. */
export function syncKey(entityType: SyncEntityType, entityId: string): string {
  return `${entityType}:${entityId}`;
}

const MAX_ENTITY_ID_LENGTH = 64;
const MAX_ANNOTATION_TEXT_LENGTH = 10_000;
const MAX_BOOKMARK_LABEL_LENGTH = 200;

const syncEntityTypeSchema = z.enum(SYNC_ENTITY_TYPES);
const syncOpSchema = z.enum(SYNC_OPS);
const cursorSchema = z.coerce.number().int().min(0);

/** One change in a push request. Delete payloads are optional. */
export const syncPushChangeSchema = z.object({
  entityType: syncEntityTypeSchema,
  entityId: z.string().min(1).max(MAX_ENTITY_ID_LENGTH),
  op: syncOpSchema,
  clientUpdatedAt: z.iso.datetime(),
  payload: z.unknown().optional(),
});

/** Body of a push request; bounded so one request cannot monopolize a worker. */
export const syncPushRequestSchema = z.object({
  changes: z.array(syncPushChangeSchema).min(1).max(SYNC_PUSH_MAX_CHANGES),
});

/** Query string of a pull request. */
export const syncPullQuerySchema = z.object({
  since: cursorSchema.default(0),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(SYNC_PULL_MAX_LIMIT)
    .default(SYNC_PULL_DEFAULT_LIMIT),
});

/** Query string of a server-sent change stream. */
export const syncStreamQuerySchema = z.object({
  token: z.string().min(1),
  since: cursorSchema.default(0),
});

/** Payload of a reading-progress upsert. */
export const syncProgressPayloadSchema = z.object({
  bookId: z.uuid(),
  locator: locatorSchema,
});

const annotationTypeSchema = z.enum(['highlight', 'note']);
const annotationColorSchema = z.enum(ANNOTATION_COLORS);
const annotationTextSchema = z.string().trim().min(1).max(MAX_ANNOTATION_TEXT_LENGTH);
const annotationTagSchema = z.string().trim().min(1).max(MAX_TAG_LENGTH);

/** Payload of an annotation upsert; note annotations must carry note text. */
export const syncAnnotationPayloadSchema = z
  .object({
    bookId: z.uuid(),
    type: annotationTypeSchema,
    color: annotationColorSchema,
    locator: locatorSchema,
    selectedText: annotationTextSchema,
    noteText: annotationTextSchema.nullable(),
    tags: z.array(annotationTagSchema).max(MAX_TAGS),
  })
  .superRefine((data, ctx) => {
    if (data.type === 'note' && data.noteText === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['noteText'],
        message: 'noteText is required for a note',
      });
    }
  });

/** Payload of a bookmark upsert. */
export const syncBookmarkPayloadSchema = z.object({
  bookId: z.uuid(),
  locator: locatorSchema,
  label: z.string().trim().max(MAX_BOOKMARK_LABEL_LENGTH).nullable(),
});

/** Values reach the store through JSON, so only plain objects are safe to merge. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Payload of a reader-settings upsert; the whole payload must fit the size cap. */
export const syncSettingsPayloadSchema = z
  .object({
    settings: z.record(z.string(), z.unknown()),
  })
  .superRefine((payload, ctx) => {
    if (!isPlainObject(payload.settings)) {
      ctx.addIssue({
        code: 'custom',
        path: ['settings'],
        message: 'settings must be a plain object',
      });
      return;
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(payload);
    } catch {
      ctx.addIssue({
        code: 'custom',
        path: ['settings'],
        message: 'settings must be JSON-serializable',
      });
      return;
    }

    if (serialized.length > SYNC_SETTINGS_MAX_BYTES) {
      ctx.addIssue({
        code: 'custom',
        path: ['settings'],
        message: `settings must not exceed ${SYNC_SETTINGS_MAX_BYTES} bytes`,
      });
    }
  });

/** Returns the payload schema for an entity type; unknown types are rejected loudly. */
export function syncPayloadSchemaFor(entityType: SyncEntityType) {
  switch (entityType) {
    case 'reading_progress':
      return syncProgressPayloadSchema;
    case 'annotation':
      return syncAnnotationPayloadSchema;
    case 'bookmark':
      return syncBookmarkPayloadSchema;
    case 'reader_settings':
      return syncSettingsPayloadSchema;
    default:
      throw new Error('Unknown sync entity type');
  }
}
