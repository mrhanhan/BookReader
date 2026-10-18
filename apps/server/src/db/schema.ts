import {
  MEMBER_UPLOAD_QUOTA_BYTES,
  newId,
  type BookConversionStatus,
  type BookFormat,
  type BookStatus,
  type Role,
} from '@bookr/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
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
