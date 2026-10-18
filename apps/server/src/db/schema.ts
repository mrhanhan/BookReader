import {
  MEMBER_UPLOAD_QUOTA_BYTES,
  newId,
  type AnnotationColor,
  type BookConversionStatus,
  type BookFormat,
  type BookStatus,
  type Locator,
  type Role,
  type SyncEntityType,
  type SyncOp,
} from '@bookr/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** Lifecycle of a presigned upload session. */
export type UploadSessionStatus = 'created' | 'completed' | 'failed' | 'expired';

/** State of background metadata extraction for a book. */
export type MetadataStatus = 'pending' | 'done' | 'failed';

/** Kinds of background work stored in the `jobs` table. */
export type JobType = 'metadata' | 'convert' | 'cleanup';

/** Lifecycle of a background job. */
export type JobStatus = 'pending' | 'running' | 'done' | 'failed';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable('users', {
  id: uuid('id').primaryKey().$defaultFn(newId),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  role: text('role').$type<Role>().notNull().default('member'),
  uploadQuotaBytes: bigint('upload_quota_bytes', { mode: 'number' })
    .notNull()
    .default(MEMBER_UPLOAD_QUOTA_BYTES),
  timezone: text('timezone').notNull().default('Asia/Shanghai'),
  aiEnabled: boolean('ai_enabled').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const invites = pgTable('invites', {
  code: text('code').primaryKey(),
  createdBy: uuid('created_by').references(() => users.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedBy: uuid('used_by').references(() => users.id),
  usedAt: timestamp('used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const devices = pgTable('devices', {
  id: uuid('id').primaryKey().$defaultFn(newId),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name'),
  platform: text('platform'),
  refreshTokenHash: text('refresh_token_hash').notNull(),
  refreshExpiresAt: timestamp('refresh_expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const libraries = pgTable('libraries', {
  id: uuid('id').primaryKey().$defaultFn(newId),
  name: text('name').notNull(),
  createdAt: createdAt(),
});

export const books = pgTable(
  'books',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id),
    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => users.id),
    title: text('title').notNull(),
    author: text('author'),
    description: text('description'),
    format: text('format').$type<BookFormat>().notNull(),
    originalFilename: text('original_filename').notNull(),
    size: bigint('original_size', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    fileKey: text('file_key'),
    coverKey: text('cover_key'),
    textLayerKey: text('text_layer_key'),
    reflowKey: text('reflow_key'),
    reflowSchemaVersion: integer('reflow_schema_version'),
    reflowPageCount: integer('reflow_page_count'),
    reflowUpdatedAt: timestamp('reflow_updated_at', { withTimezone: true }),
    epubKey: text('epub_key'),
    status: text('status').$type<BookStatus>().notNull().default('unread'),
    conversionStatus: text('conversion_status')
      .$type<BookConversionStatus>()
      .notNull()
      .default('none'),
    conversionError: text('conversion_error'),
    metadataStatus: text('metadata_status').$type<MetadataStatus>().notNull().default('pending'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('books_library_sha_active')
      .on(table.libraryId, table.sha256)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export const categories = pgTable('categories', {
  id: uuid('id').primaryKey().$defaultFn(newId),
  libraryId: uuid('library_id')
    .notNull()
    .references(() => libraries.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  color: text('color').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
});

export const bookCategories = pgTable(
  'book_categories',
  {
    bookId: uuid('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.bookId, table.categoryId] })],
);

export const uploadSessions = pgTable('upload_sessions', {
  id: uuid('id').primaryKey().$defaultFn(newId),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  size: bigint('size', { mode: 'number' }).notNull(),
  sha256: text('sha256').notNull(),
  contentType: text('content_type').notNull(),
  format: text('format').$type<BookFormat>().notNull(),
  objectKey: text('object_key').notNull(),
  status: text('status').$type<UploadSessionStatus>().notNull().default('created'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

/** Lifecycle of a presigned reflow pack upload session. */
export type ReflowUploadStatus = 'created' | 'completed' | 'failed' | 'expired';

export const reflowUploads = pgTable(
  'reflow_uploads',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    bookId: uuid('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    objectKey: text('object_key').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    status: text('status')
      .$type<ReflowUploadStatus>()
      .notNull()
      .default('created'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [index('reflow_uploads_status_expires_idx').on(table.status, table.expiresAt)],
);

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    type: text('type').$type<JobType>().notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status').$type<JobStatus>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    /** When a worker claimed the row; stale leases are reclaimed. */
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('jobs_status_run_at_idx').on(table.status, table.runAt)],
);

export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().$defaultFn(newId),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  action: text('action').notNull(),
  target: text('target'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  createdAt: createdAt(),
});

/** A book row as stored in Postgres. */
export type BookRow = typeof books.$inferSelect;

/** Fields accepted when inserting a book. */
export type NewBook = typeof books.$inferInsert;

export const readingProgress = pgTable(
  'reading_progress',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bookId: uuid('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    locator: jsonb('locator').$type<Locator>().notNull(),
    percent: doublePrecision('percent').notNull(),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    clientUpdatedAt: timestamp('client_updated_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.bookId] }),
    index('reading_progress_book_id_idx').on(table.bookId),
  ],
);

export const annotations = pgTable(
  'annotations',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bookId: uuid('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    type: text('type').$type<'highlight' | 'note'>().notNull(),
    color: text('color').$type<AnnotationColor>().notNull(),
    locator: jsonb('locator').$type<Locator>().notNull(),
    selectedText: text('selected_text').notNull(),
    noteText: text('note_text'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    revision: integer('revision').notNull().default(1),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    clientUpdatedAt: timestamp('client_updated_at', { withTimezone: true }),
  },
  (table) => [
    index('annotations_user_book_updated_idx').on(table.userId, table.bookId, table.updatedAt),
  ],
);

export const annotationHistory = pgTable('annotation_history', {
  id: uuid('id').primaryKey().$defaultFn(newId),
  annotationId: uuid('annotation_id')
    .notNull()
    .references(() => annotations.id, { onDelete: 'cascade' }),
  noteText: text('note_text'),
  editedAt: timestamp('edited_at', { withTimezone: true }).notNull().defaultNow(),
  deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
});

export const bookmarks = pgTable(
  'bookmarks',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bookId: uuid('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    locator: jsonb('locator').$type<Locator>().notNull(),
    label: text('label'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    clientUpdatedAt: timestamp('client_updated_at', { withTimezone: true }),
  },
  (table) => [
    index('bookmarks_user_book_created_idx').on(table.userId, table.bookId, table.createdAt),
  ],
);

/**
 * Append-only log of per-user entity changes. Clients pull by revision and
 * push through a server transaction; `revision` is the pull cursor.
 */
export const syncChanges = pgTable(
  'sync_changes',
  {
    revision: bigserial('revision', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').$type<SyncEntityType>().notNull(),
    entityId: text('entity_id').notNull(),
    op: text('op').$type<SyncOp>().notNull(),
    payload: jsonb('payload').$type<unknown>(),
    clientUpdatedAt: timestamp('client_updated_at', { withTimezone: true }).notNull(),
    serverUpdatedAt: timestamp('server_updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (table) => [
    index('sync_changes_user_revision_idx').on(table.userId, table.revision),
    index('sync_changes_created_idx').on(table.createdAt),
  ],
);

/** Small key/value store for server-wide sync bookkeeping. */
export const syncMeta = pgTable('sync_meta', {
  key: text('key').primaryKey(),
  value: bigint('value', { mode: 'number' }).notNull(),
});

/** One row per user holding the reader settings the sync protocol mirrors. */
export const userSettings = pgTable('user_settings', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  clientUpdatedAt: timestamp('client_updated_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** A reading progress row as stored in Postgres. */
export type ReadingProgressRow = typeof readingProgress.$inferSelect;

/** An annotation row as stored in Postgres. */
export type AnnotationRow = typeof annotations.$inferSelect;

/** A bookmark row as stored in Postgres. */
export type BookmarkRow = typeof bookmarks.$inferSelect;
