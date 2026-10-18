# 私人书房 — 计划 1：基础设施与共享书架 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个可部署的最小完整产品：邀请注册、登录、共享书架、图书上传（PDF/EPUB/MOBI/AZW3）、元数据与封面、分类筛选、回收站、成员与配额管理。

**Architecture:** pnpm + Turborepo 单仓；Fastify + PostgreSQL + MinIO 服务端；React SPA 前端；Docker Compose 部署；所有大文件通过预签名 URL 直传对象存储，服务端不中转文件流量。

**Tech Stack:** Node.js 22, TypeScript 5.8+, Fastify 5, Drizzle ORM, PostgreSQL 16, MinIO, jose, argon2, zod, uuid v7, React 19, Vite, TanStack Query 5, React Router 7, Tailwind CSS 4, Vitest 3, Testing Library, MSW 2, Playwright, Docker Compose, Caddy 2。

**Spec:** `docs/superpowers/specs/2026-10-18-private-book-reader-design.md`

**Plan set:** 本项目共 8 份计划，见 `2026-10-18-00-roadmap.md`。本计划覆盖 P0 + P1，不包含阅读器、同步、AI、统计（后续计划）。

## Global Constraints

- 单机部署：4 核 8G / 100G；共享书架为单库（`libraries` 表仅一行）。
- 仅邀请注册；密码 Argon2id（memoryCost 19456, timeCost 2, parallelism 1）。
- Access Token 900 秒；Refresh Token 30 天，哈希后存 `devices`，可撤销。
- 单文件上限 500 MiB（`MAX_UPLOAD_BYTES = 524288000`）。
- 共享池默认 80 GiB（`LIBRARY_QUOTA_BYTES = 85899345920`）；每成员上传配额默认 20 GiB（`MEMBER_UPLOAD_QUOTA_BYTES = 21474836480`）。
- 预签名有效期 900 秒；上传会话 24 小时过期；回收站保留 30 天。
- 所有时间存 UTC（`timestamptz`）；所有主键为 UUIDv7。
- API 前缀 `/api`；错误统一为 `{ "error": { "code": string, "message": string, "details"?: object } }`。
- 日志禁止出现书籍正文、密码、token；pino redact `req.headers.authorization`、`password`、`token`、`refreshToken`。
- 代码、变量名、注释用英文；界面文案用简体中文。
- 文件格式：`pdf | epub | mobi | azw3`；状态：`unread | reading | finished`。

## Review Focus

以下五类输入/故障最可能伤害真实用户，对应测试必须在所属任务中实现：

1. 成员尝试修改或删除他人上传的书 → 403，数据保持不变（Task 8）。
2. 同一 sha256 在同一书架重复上传 → 409 并返回 `existingBookId`，不产生第二本书（Task 7）。
3. 扩展名伪装或超过 500 MiB 的文件 → 在上传完成阶段拒绝、删除对象、不落库（Task 7）。
4. 并发上传撞上配额边界 → 不超卖，最多一个成功（Task 7）。
5. MOBI/AZW3 转换失败 → 原书仍可下载，状态为 `failed`，可重试（Task 9b）。

## File Structure

```
package.json, pnpm-workspace.yaml, turbo.json, tsconfig.base.json, .gitignore, .editorconfig
.env.example
docker-compose.yml, Caddyfile, README.md
scripts/backup-export.sh, scripts/pull-backup.sh
.github/workflows/ci.yml

packages/shared/
  src/constants.ts        格式、状态、上限等常量
  src/ids.ts              UUIDv7 生成
  src/errors.ts           错误码与错误响应类型
  src/schemas/auth.ts     注册/登录/刷新校验
  src/schemas/books.ts    图书查询、编辑、DTO
  src/schemas/uploads.ts  上传会话校验
  src/schemas/categories.ts
  src/index.ts            公共导出
  src/__tests__/*.test.ts

packages/ui/
  src/tokens.ts           纸墨书房设计令牌
  src/theme.css           CSS 变量与 Tailwind 主题
  src/components/*.tsx    Button / Input / Dialog / EmptyState
  src/index.ts

apps/server/
  src/config.ts           环境变量校验
  src/app.ts              buildApp(deps)
  src/server.ts           启动入口
  src/db/schema.ts        Drizzle 表定义
  src/db/client.ts        连接池
  src/db/migrate.ts       迁移执行
  src/auth/password.ts
  src/auth/tokens.ts
  src/auth/guards.ts
  src/auth/service.ts
  src/auth/routes.ts
  src/library/service.ts
  src/admin/routes.ts
  src/books/service.ts
  src/books/repo.ts
  src/books/routes.ts
  src/books/metadata.ts
  src/books/conversion.ts
  src/categories/routes.ts
  src/uploads/service.ts
  src/uploads/routes.ts
  src/uploads/magic.ts
  src/storage/types.ts
  src/storage/s3.ts
  src/storage/fake.ts
  src/jobs/types.ts
  src/jobs/queue.ts
  src/jobs/worker.ts
  src/cli/create-admin.ts
  src/cli/cleanup.ts
  scripts/make-fixtures.ts
  Dockerfile
  drizzle/*.sql
  test/helpers.ts
  test/*.test.ts
  test/fixtures/*

apps/web/
  src/main.tsx, src/app/router.tsx, src/app/providers.tsx
  src/api/client.ts, src/api/auth.ts, src/api/books.ts, src/api/categories.ts, src/api/admin.ts
  src/features/auth/LoginPage.tsx, RegisterPage.tsx
  src/features/bookshelf/BookshelfPage.tsx, BookCard.tsx, UploadDialog.tsx, EditBookDialog.tsx, FilterBar.tsx, TrashPage.tsx
  src/features/admin/MembersPage.tsx, InviteDialog.tsx
  src/lib/upload.ts, hash-worker.ts, format.ts
  test/*.test.tsx
  e2e/*.spec.ts, global-setup.ts, fixtures/sample.pdf
  playwright.config.ts
  Dockerfile
```

---

### Task 1: Monorepo scaffold and CI

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.gitignore`, `.editorconfig`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/vitest.config.ts`
- Create: `packages/shared/src/constants.ts`, `packages/shared/src/index.ts`, `packages/shared/src/__tests__/constants.test.ts`
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: workspace package `@bookr/shared`; root scripts `build`, `test`, `typecheck`, `lint`.
- Produces: `BOOK_FORMATS`, `BOOK_STATUSES`, `MAX_UPLOAD_BYTES`, `LIBRARY_QUOTA_BYTES`, `MEMBER_UPLOAD_QUOTA_BYTES`, `TRASH_RETENTION_DAYS`.

- [ ] **Step 1: Write the failing test**

`packages/shared/src/__tests__/constants.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  BOOK_FORMATS, BOOK_STATUSES, LIBRARY_QUOTA_BYTES,
  MAX_UPLOAD_BYTES, MEMBER_UPLOAD_QUOTA_BYTES, TRASH_RETENTION_DAYS,
} from '../constants';

describe('shared constants', () => {
  it('pins the supported book formats', () => {
    expect(BOOK_FORMATS).toEqual(['pdf', 'epub', 'mobi', 'azw3']);
  });
  it('pins statuses, upload limit, quotas and retention', () => {
    expect(BOOK_STATUSES).toEqual(['unread', 'reading', 'finished']);
    expect(MAX_UPLOAD_BYTES).toBe(500 * 1024 * 1024);
    expect(LIBRARY_QUOTA_BYTES).toBe(80 * 1024 ** 3);
    expect(MEMBER_UPLOAD_QUOTA_BYTES).toBe(20 * 1024 ** 3);
    expect(TRASH_RETENTION_DAYS).toBe(30);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @bookr/shared test`
Expected: FAIL — cannot resolve `../constants` or package not found.

- [ ] **Step 3: Implement workspace and constants**

Root `package.json` uses `"packageManager": "pnpm@10"`, scripts `build: turbo build`, `test: turbo test`, `typecheck: turbo typecheck`, `dev: turbo dev`. `pnpm-workspace.yaml` includes `apps/*`, `packages/*`. `tsconfig.base.json` sets `strict: true`, `module: NodeNext`, `target: ES2023`, `noUncheckedIndexedAccess: true`. Add `.gitignore` for `node_modules`, `dist`, `.env`, `coverage`, `*.log`, `.turbo`.

`packages/shared/src/constants.ts` exports the six constants as `as const` arrays and numeric literals listed in Global Constraints. `src/index.ts` re-exports `./constants`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm install && pnpm --filter @bookr/shared test`
Expected: PASS — 2 tests.

- [ ] **Step 5: Add CI and commit**

CI runs `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`.

```bash
git init
git add .
git commit -m "chore: scaffold pnpm monorepo with shared constants"
```

---

### Task 2: Shared contracts, IDs and error codes

**Files:**
- Create: `packages/shared/src/ids.ts`, `packages/shared/src/errors.ts`
- Create: `packages/shared/src/schemas/auth.ts`, `books.ts`, `uploads.ts`, `categories.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/ids.test.ts`, `__tests__/schemas.test.ts`

**Interfaces:**
- Produces: `newId(): string` returning UUIDv7.
- Produces zod schemas: `registerSchema`, `loginSchema`, `refreshSchema`, `createUploadSchema`, `updateBookSchema`, `listBooksQuerySchema`, `createCategorySchema`, `updateCategorySchema`.
- Produces types: `BookFormat`, `BookStatus`, `BookDto`, `CategoryDto`, `CreateUploadResponse`, `CompleteUploadResponse`, `AuthTokens`, `MeDto`, `ApiErrorBody`, plus `ListBooksQuery = z.infer<typeof listBooksQuerySchema>` and `UpdateBookInput = z.infer<typeof updateBookSchema>`.
- Produces `ERROR_CODES` with `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `DUPLICATE_BOOK`, `QUOTA_EXCEEDED`, `INVALID_FILE`, `VALIDATION_FAILED`, `INVITE_INVALID`, `RATE_LIMITED`, `INTERNAL`.

- [ ] **Step 1: Write the failing tests**

`ids.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { newId } from '../ids';

it('returns a UUIDv7', () => {
  const id = newId();
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
it('returns unique ids', () => {
  expect(new Set(Array.from({ length: 1000 }, newId)).size).toBe(1000);
});
```

`schemas.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { registerSchema } from '../schemas/auth';
import { createUploadSchema } from '../schemas/uploads';
import { listBooksQuerySchema } from '../schemas/books';

it('rejects passwords shorter than 10 characters', () => {
  const result = registerSchema.safeParse({ inviteCode: 'ABC123', username: 'reader', password: 'short', displayName: '读者' });
  expect(result.success).toBe(false);
});
it('rejects files over 500 MiB and malformed sha256', () => {
  const base = { filename: 'a.pdf', contentType: 'application/pdf', sha256: 'a'.repeat(64) };
  expect(createUploadSchema.safeParse({ ...base, size: 524288001 }).success).toBe(false);
  expect(createUploadSchema.safeParse({ ...base, size: 1024, sha256: 'xyz' }).success).toBe(false);
  expect(createUploadSchema.safeParse({ ...base, size: 1024 }).success).toBe(true);
});
it('defaults book list pagination to 24 and caps it at 100', () => {
  expect(listBooksQuerySchema.parse({}).pageSize).toBe(24);
  expect(listBooksQuerySchema.safeParse({ pageSize: 101 }).success).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bookr/shared test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement IDs, errors and schemas**

`newId` uses `uuid` v11 `v7()`. `errors.ts` exports `ERROR_CODES` and `ApiErrorBody`.

`registerSchema`: `inviteCode` 6–64 chars; `username` `/^[a-zA-Z0-9_]{3,32}$/`; `password` 10–128; `displayName` 1–50.
`loginSchema`: username as above, password 1–128.
`refreshSchema`: `{ refreshToken: string min 32 }`.
`createUploadSchema`: `filename` 1–255, `size` positive int ≤ `MAX_UPLOAD_BYTES`, `sha256` 64 lowercase hex, `contentType` enum `application/pdf | application/epub+zip | application/x-mobipocket-ebook | application/vnd.amazon.ebook`.
`listBooksQuerySchema`: `query` optional ≤100; `categoryId` optional uuid; `format` optional enum; `status` optional enum; `sort` enum `recent|added|title` default `recent`; `page` int ≥1 default 1; `pageSize` int 1–100 default 24.
`updateBookSchema`: `title` 1–200 optional; `author` ≤100 nullable; `description` ≤2000 nullable; `status` enum optional; `categoryIds` array of uuid max 20 optional.
`createCategorySchema`: `name` 1–30; `color` hex `/^#[0-9a-fA-F]{6}$/`.
`updateCategorySchema`: partial of name/color/sortOrder.
DTO interfaces: `BookDto { id, title, author, description, format, size, coverUrl, status, progressPercent, categories, uploadedBy: { id, displayName }, conversionStatus, createdAt, updatedAt }`; `CategoryDto { id, name, color }`; `CreateUploadResponse { uploadId, putUrl, expiresAt }`; `CompleteUploadResponse { book }`; `AuthTokens { accessToken, refreshToken, expiresIn }`; `MeDto { id, username, displayName, role, timezone, aiEnabled, uploadUsedBytes, uploadQuotaBytes, libraryUsedBytes, libraryQuotaBytes }`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @bookr/shared test`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add ids, error codes and API contracts"
```

---

### Task 3: Server skeleton, config and error envelope

**Files:**
- Create: `apps/server/package.json`, `apps/server/tsconfig.json`, `apps/server/vitest.config.ts`
- Create: `apps/server/src/config.ts`, `src/app.ts`, `src/server.ts`
- Create: `apps/server/test/health.test.ts`, `test/helpers.ts`
- Create: `apps/server/src/storage/types.ts`, `src/storage/fake.ts`
- Create: `apps/server/src/jobs/types.ts`
- Create: `apps/server/src/db/client.ts` (thin wrapper; schema added in Task 4)

**Interfaces:**
- Produces: `AppConfig` with `port`, `host`, `databaseUrl`, `s3: { endpoint, region, accessKey, secretKey, bucket }`, `jwtSecret`, `libraryQuotaBytes`, `memberUploadQuotaBytes`, `loginRateLimit`, `corsOrigin`.
- Produces: `buildApp(deps: AppDeps): FastifyInstance`.
- Produces: `AppDeps { config; db; storage; clock; ids; jobs }`, `Clock { now(): Date }`, `IdGenerator { newId(): string }`, `JobQueue { enqueue(job: Job): Promise<void> }`.
- Produces: `GET /healthz` → `{ status: 'ok' }`.

- [ ] **Step 1: Write the failing test**

`test/health.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildTestApp } from './helpers';

it('returns ok on healthz', async () => {
  const app = await buildTestApp();
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ status: 'ok' });
});
it('wraps unknown routes in the error envelope', async () => {
  const app = await buildTestApp();
  const res = await app.inject({ method: 'GET', url: '/api/nope' });
  expect(res.statusCode).toBe(404);
  expect(res.json().error.code).toBe('NOT_FOUND');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bookr/server test`
Expected: FAIL — `buildTestApp` missing.

- [ ] **Step 3: Implement config, app factory and error handler**

`config.ts` parses `process.env` with zod: `PORT` default 3000, `HOST` default `0.0.0.0`, `DATABASE_URL` required, `S3_ENDPOINT` required, `S3_REGION` default `us-east-1`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET` default `bookr`, `JWT_SECRET` min 32, quotas default from shared constants, `LOGIN_RATE_LIMIT` default 10, `CORS_ORIGIN` default `http://localhost:5173`. Throw with a readable message listing missing keys.

`app.ts` creates Fastify with pino redaction, registers CORS, request id, `setErrorHandler` mapping `AppError` and zod errors to the envelope, and `setNotFoundHandler`.

`test/helpers.ts` exports `buildTestDeps()` (the dependency object used by both the app and background jobs) and `buildTestApp(overrides?)` using `FakeStorage`, a test DB client, fixed clock, and `newId`. `FakeStorage` implements `StorageService` with an in-memory `Map<string, Buffer>`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @bookr/server test -- test/health.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "feat(server): add app factory, config and error envelope"
```

---

### Task 4: Database schema and migrations

**Files:**
- Create: `apps/server/drizzle.config.ts`
- Create: `apps/server/src/db/schema.ts`, `src/db/migrate.ts`
- Create: `apps/server/drizzle/0000_init.sql` (generated)
- Create: `apps/server/test/db.test.ts`
- Modify: `apps/server/package.json` scripts `db:generate`, `db:migrate`, `db:test:reset`
- Modify: `apps/server/test/helpers.ts` to reset the database between tests

**Interfaces:**
- Produces Drizzle tables: `users`, `invites`, `devices`, `libraries`, `books`, `categories`, `bookCategories`, `uploadSessions`, `auditLogs`.
- Produces: `migrate(db)`; test helper `resetDb()` truncates all tables; exported types `BookRow = typeof books.$inferSelect` and `NewBook = typeof books.$inferInsert`.
- Constraint: partial unique index `books_library_sha_active` on `(library_id, sha256) WHERE deleted_at IS NULL`.

- [ ] **Step 1: Write the failing test**

`test/db.test.ts`:
```ts
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { books, libraries, users } from '../src/db/schema';
import { resetDb, testDb } from './helpers';

it('enforces active-file dedupe per library', async () => {
  await resetDb();
  const [library] = await testDb.insert(libraries).values({ name: '书房' }).returning();
  const [user] = await testDb.insert(users).values({
    username: 'reader', passwordHash: 'x', displayName: '读者', role: 'admin',
  }).returning();
  const base = { libraryId: library.id, uploadedBy: user.id, title: 'A', format: 'pdf' as const, size: 10, sha256: 'a'.repeat(64) };
  await testDb.insert(books).values(base);
  await expect(testDb.insert(books).values(base)).rejects.toThrow();
});
it('allows the same file again after the first copy is soft-deleted', async () => {
  await resetDb();
  const [library] = await testDb.insert(libraries).values({ name: '书房' }).returning();
  const [user] = await testDb.insert(users).values({ username: 'r2', passwordHash: 'x', displayName: '读者', role: 'member' }).returning();
  const base = { libraryId: library.id, uploadedBy: user.id, title: 'A', format: 'pdf' as const, size: 10, sha256: 'b'.repeat(64) };
  const [first] = await testDb.insert(books).values(base).returning();
  await testDb.update(books).set({ deletedAt: new Date() }).where(eq(books.id, first.id));
  await expect(testDb.insert(books).values(base)).resolves.toBeDefined();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bookr/server db:test:reset && pnpm --filter @bookr/server test -- test/db.test.ts`
Expected: FAIL — tables or schema missing.

- [ ] **Step 3: Implement schema and migration**

Columns per design section 7, plus:
- `users`: `is_active boolean not null default true`, `created_at`, `updated_at`.
- `invites`: `code text unique`, `created_by uuid`, `expires_at timestamptz not null`, `used_by uuid`, `used_at timestamptz`, `revoked_at timestamptz`.
- `devices`: `id`, `user_id`, `name`, `platform`, `refresh_token_hash text not null`, `refresh_expires_at timestamptz not null`, `revoked_at`, `last_seen_at`, `created_at`.
- `libraries`: `id`, `name`, `created_at`.
- `books`: `id`, `library_id`, `uploaded_by`, `title text not null`, `author`, `description`, `format text not null`, `original_filename text not null`, `original_size bigint not null` (mode number), `sha256 text not null`, `file_key text`, `cover_key`, `text_layer_key`, `reflow_key`, `epub_key`, `status text not null default 'unread'`, `conversion_status text not null default 'none'`, `conversion_error text`, `metadata_status text not null default 'pending'`, `deleted_at`, `created_at`, `updated_at`. Unique partial index as above.
- `categories`: `id`, `library_id`, `name`, `color`, `sort_order int default 0`, `created_by`, `created_at`.
- `book_categories`: `book_id`, `category_id`, primary key both, FKs cascade.
- `upload_sessions`: `id`, `user_id`, `filename`, `size bigint`, `sha256`, `content_type`, `format`, `object_key`, `status text` (`created|completed|failed|expired`), `expires_at`, `created_at`, `completed_at`.
- `audit_logs`: `id`, `user_id`, `action`, `target`, `metadata jsonb`, `created_at`.

Generate SQL with `pnpm --filter @bookr/server db:generate`; commit the generated file. `migrate.ts` calls `drizzle-orm/node-postgres/migrator`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @bookr/server test -- test/db.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/server/drizzle apps/server/src/db apps/server/test
git commit -m "feat(server): add database schema and initial migration"
```

---

### Task 5: Password hashing, tokens and guards

**Files:**
- Create: `apps/server/src/auth/password.ts`, `src/auth/tokens.ts`, `src/auth/guards.ts`
- Test: `apps/server/test/auth-core.test.ts`

**Interfaces:**
- Produces: `hashPassword(password: string): Promise<string>`, `verifyPassword(hash: string, password: string): Promise<boolean>`.
- Produces: `signAccessToken(claims: { sub: string; role: Role }, secret: string, ttlSeconds?: number): Promise<string>`, `verifyAccessToken(token: string, secret: string): Promise<{ sub: string; role: Role }>`.
- Produces: `newRefreshToken(): { token: string; hash: string; expiresAt: Date }`, `hashRefreshToken(token: string): string`.
- Produces: `makeRequireAuth(deps: AppDeps): preHandlerHookHandler`, `makeRequireAdmin(): preHandlerHookHandler`; the former attaches `request.user = { id, role }`.

- [ ] **Step 1: Write the failing test**

`test/auth-core.test.ts`:
```ts
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password';
import { makeRequireAdmin, makeRequireAuth } from '../src/auth/guards';
import { hashRefreshToken, newRefreshToken, signAccessToken, verifyAccessToken } from '../src/auth/tokens';
import { buildTestDeps, seedUser } from './helpers';

it('hashes passwords with argon2id and verifies them', async () => {
  const hash = await hashPassword('correct horse battery');
  expect(hash).toMatch(/^\$argon2id\$/);
  expect(hash).not.toContain('correct horse');
  await expect(verifyPassword(hash, 'correct horse battery')).resolves.toBe(true);
  await expect(verifyPassword(hash, 'wrong password')).resolves.toBe(false);
});
it('signs and verifies access tokens, rejecting expired ones', async () => {
  const token = await signAccessToken({ sub: 'user-1', role: 'admin' }, 's'.repeat(32), 900);
  await expect(verifyAccessToken(token, 's'.repeat(32))).resolves.toEqual({ sub: 'user-1', role: 'admin' });
  await expect(verifyAccessToken(token, 'x'.repeat(32))).rejects.toThrow();
  const expired = await signAccessToken({ sub: 'user-1', role: 'member' }, 's'.repeat(32), -1);
  await expect(verifyAccessToken(expired, 's'.repeat(32))).rejects.toThrow(/expired/i);
});
it('creates 30-day refresh tokens stored as sha256 hashes', () => {
  const { token, hash, expiresAt } = newRefreshToken();
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(hash).toHaveLength(64);
  expect(hashRefreshToken(token)).toBe(hash);
  const days = (expiresAt.getTime() - Date.now()) / 86_400_000;
  expect(days).toBeGreaterThan(29.9);
});
it('guards routes: 401 without a token, 403 for a member on an admin route', async () => {
  const deps = await buildTestDeps();
  const app = Fastify();
  app.get('/auth', { preHandler: makeRequireAuth(deps) }, async () => ({ ok: true }));
  app.get('/admin', { preHandler: [makeRequireAuth(deps), makeRequireAdmin()] }, async () => ({ ok: true }));
  expect((await app.inject({ method: 'GET', url: '/auth' })).statusCode).toBe(401);
  const member = await seedUser('member');
  const token = await signAccessToken({ sub: member.id, role: 'member' }, deps.config.jwtSecret, 900);
  expect((await app.inject({ method: 'GET', url: '/auth', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
  expect((await app.inject({ method: 'GET', url: '/admin', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(403);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bookr/server test -- test/auth-core.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement hash, tokens and guards**

`password.ts` uses `argon2.hash` with `{ type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }`.

`tokens.ts` uses `jose` `SignJWT` with HS256, issuer `bookr`, audience `bookr-web`, `setExpirationTime` from `ttlSeconds` (negative values produce an already-expired token). `verifyAccessToken` maps `JWTExpired` to an error whose message contains `expired`.

`newRefreshToken` uses `randomBytes(32).toString('base64url')` and sha256 hex; `expiresAt` is now + 30 days.

`guards.ts` reads `Authorization: Bearer <token>`; missing/invalid → 401 `UNAUTHORIZED`; `makeRequireAdmin` additionally requires `role === 'admin'` → 403 `FORBIDDEN`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @bookr/server test -- test/auth-core.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/auth apps/server/test/auth-core.test.ts
git commit -m "feat(server): add argon2id passwords, JWT and auth guards"
```

---

### Task 6: Auth routes, invites and admin bootstrap

**Files:**
- Create: `apps/server/src/auth/service.ts`, `src/auth/routes.ts`, `src/library/service.ts`
- Create: `apps/server/src/cli/create-admin.ts`
- Modify: `apps/server/src/app.ts` to register auth routes
- Test: `apps/server/test/auth-routes.test.ts`

**Interfaces:**
- Produces: `registerUser(deps, input): Promise<AuthTokens>`; `loginUser(deps, input, deviceName, platform): Promise<AuthTokens>`; `refreshSession(deps, refreshToken): Promise<AuthTokens>`; `logoutSession(deps, refreshToken): Promise<void>`.
- Produces: `createAdmin(deps, input: { username; password; displayName }): Promise<{ userId: string }>` — throws `CONFLICT` if any user exists.
- Produces: `getLibrary(deps): Promise<{ id: string; name: string }>` — returns the single library row, creating `书房` on first call.
- Routes: `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/refresh`, `POST /api/auth/logout`, `GET /api/auth/me`.
- `POST /api/auth/register` body: `{ inviteCode, username, password, displayName }` → 201 `AuthTokens`.
- `POST /api/auth/login` body: `{ username, password }` → 200 `AuthTokens`.
- `POST /api/auth/refresh` body: `{ refreshToken }` → 200 `AuthTokens` (rotated).
- `POST /api/auth/logout` body: `{ refreshToken }` → 204.
- `GET /api/auth/me` → 200 `MeDto`.

- [ ] **Step 1: Write the failing test**

`test/auth-routes.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildTestApp, createInvite, resetDb } from './helpers';

it('registers with a valid invite and returns a usable access token', async () => {
  await resetDb();
  const app = await buildTestApp();
  const code = await createInvite(app);
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: {
    inviteCode: code, username: 'reader', password: 'a-long-password', displayName: '读者',
  }});
  expect(res.statusCode).toBe(201);
  const tokens = res.json();
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${tokens.accessToken}` } });
  expect(me.statusCode).toBe(200);
  expect(me.json()).toMatchObject({ username: 'reader', role: 'member' });
});
it('rejects used, expired and unknown invite codes', async () => {
  await resetDb();
  const app = await buildTestApp();
  const code = await createInvite(app);
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { inviteCode: code, username: 'a', password: 'a-long-password', displayName: 'A' } });
  for (const inviteCode of [code, 'NOPE00']) {
    const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { inviteCode, username: `u${Math.random()}`, password: 'a-long-password', displayName: 'U' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVITE_INVALID');
  }
});
it('rejects a wrong password and a disabled account', async () => {
  await resetDb();
  const app = await buildTestApp();
  const code = await createInvite(app);
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { inviteCode: code, username: 'reader', password: 'a-long-password', displayName: '读者' } });
  const wrong = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'reader', password: 'wrong-password' } });
  expect(wrong.statusCode).toBe(401);
  await setUserInactive(app, 'reader');
  const disabled = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'reader', password: 'a-long-password' } });
  expect(disabled.statusCode).toBe(403);
});
it('rotates refresh tokens and revokes on logout', async () => {
  await resetDb();
  const app = await buildTestApp();
  const code = await createInvite(app);
  const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { inviteCode: code, username: 'reader', password: 'a-long-password', displayName: '读者' } });
  const first = reg.json();
  const refreshed = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: first.refreshToken } });
  expect(refreshed.statusCode).toBe(200);
  const second = refreshed.json();
  expect(second.refreshToken).not.toBe(first.refreshToken);
  const replay = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: first.refreshToken } });
  expect(replay.statusCode).toBe(401);
  await app.inject({ method: 'POST', url: '/api/auth/logout', payload: { refreshToken: second.refreshToken } });
  const afterLogout = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: second.refreshToken } });
  expect(afterLogout.statusCode).toBe(401);
});
it('rate-limits repeated failed logins', async () => {
  await resetDb();
  const app = await buildTestApp({ loginRateLimit: 3 });
  const code = await createInvite(app);
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { inviteCode: code, username: 'reader', password: 'a-long-password', displayName: '读者' } });
  for (let i = 0; i < 3; i += 1) {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'reader', password: 'wrong-password' } });
    expect(res.statusCode).toBe(401);
  }
  const limited = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'reader', password: 'wrong-password' } });
  expect(limited.statusCode).toBe(429);
  expect(limited.json().error.code).toBe('RATE_LIMITED');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bookr/server test -- test/auth-routes.test.ts`
Expected: FAIL — routes missing.

- [ ] **Step 3: Implement auth service, routes and CLI**

Register runs in one transaction: lock and validate invite (`used_at IS NULL`, `revoked_at IS NULL`, `expires_at > now()`), create user and device, mark invite used. Username conflict → 409 `CONFLICT`. Errors use `AppError`.

Login keeps an in-memory failure counter keyed by `${request.ip}:${username}` with a 60-second window; after `config.loginRateLimit` failures (default 10) it returns 429 `RATE_LIMITED`. Successful login and refresh clear the counter. This is single-instance state, matching the single-server deployment.

Write `audit_logs` rows for `auth.register`, `auth.login`, `auth.logout` (never store passwords or tokens).

Refresh: sha256 the token, find device with matching hash, not revoked, not expired; rotate hash + expiry, return new access + refresh. Old token immediately invalid.

Logout: set `revoked_at`.

`create-admin.ts` calls `createAdmin`; username/password from `ADMIN_USERNAME` / `ADMIN_PASSWORD`; prints the user id. Register an npm script `admin:create`. `createAdmin` calls `getLibrary` first, so the first admin and the shared shelf are created in one step. The single library uses the fixed id `00000000-0000-7000-8000-000000000001`; `getLibrary` inserts it with `ON CONFLICT DO NOTHING`, so concurrent first requests cannot create two shelves.

`test/helpers.ts` adds `createInvite(app)` (inserts an unused invite directly with `testDb`, keeping this task independent of the admin routes), `seedUser(role, username?)`, `authHeader(user)`, `resetDb()`, and `setUserInactive(app, username)` (sets `users.is_active=false`).

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @bookr/server test -- test/auth-routes.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/auth apps/server/src/cli apps/server/test
git commit -m "feat(server): add invite registration, login, refresh and logout"
```

---

### Task 7: Storage, upload sessions, quota and dedupe

**Files:**
- Create: `apps/server/src/storage/s3.ts`
- Create: `apps/server/src/uploads/service.ts`, `src/uploads/routes.ts`, `src/uploads/magic.ts`
- Create: `apps/server/src/jobs/queue.ts`
- Create: `apps/server/drizzle/0001_jobs.sql` (second migration with `jobs` table)
- Modify: `apps/server/src/db/schema.ts` (add `jobs`)
- Modify: `apps/server/src/app.ts` to register upload routes
- Test: `apps/server/test/uploads.test.ts`

**Interfaces:**
- Produces: `StorageService` (already declared): `presignPut(key, contentType, expiresInSeconds)`, `presignGet(key, expiresInSeconds)`, `head(key) → { size } | null`, `readFirstBytes(key, length) → Buffer`, `getObject(key) → Buffer`, `putObject(key, body, contentType)`, `delete(key)`.
- Produces: `createUpload(deps, userId, input): Promise<CreateUploadResponse>`.
- Produces: `completeUpload(deps, userId, uploadId): Promise<BookDto>`.
- Produces: `cleanupExpiredUploads(deps): Promise<number>`.
- Produces: `sniffMagic(head: Buffer, format: BookFormat): boolean`.
- Produces: `PostgresJobQueue implements JobQueue` with `enqueue`, `claimNext`, `complete`, `fail`.
- Routes: `POST /api/uploads` → 201 `CreateUploadResponse`; `POST /api/uploads/:id/complete` → 200 `CompleteUploadResponse`.

- [ ] **Step 1: Write the failing tests**

`test/uploads.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildTestApp, seedBook, seedUser, authHeader, resetDb, fakeStorage } from './helpers';

const PDF_HEAD = Buffer.from('%PDF-1.7\n');
const sha = (c: string) => c.repeat(64);

it('creates a presigned upload session for an authenticated member', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const res = await app.inject({ method: 'POST', url: '/api/uploads', headers: authHeader(user), payload: {
    filename: 'book.pdf', size: 1024, sha256: sha('a'), contentType: 'application/pdf',
  }});
  expect(res.statusCode).toBe(201);
  expect(res.json().putUrl).toContain('original.pdf');
  expect(res.json().putUrl).toContain('X-Amz-Expires=900');
});
it('returns 409 with the existing book id for a duplicate sha256', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const existing = await seedBook({ uploadedBy: user.id, sha256: sha('b'), size: 10 });
  const res = await app.inject({ method: 'POST', url: '/api/uploads', headers: authHeader(user), payload: {
    filename: 'copy.pdf', size: 10, sha256: sha('b'), contentType: 'application/pdf',
  }});
  expect(res.statusCode).toBe(409);
  expect(res.json().error.code).toBe('DUPLICATE_BOOK');
  expect(res.json().error.details.existingBookId).toBe(existing.id);
});
it('rejects uploads that would exceed the member quota', async () => {
  await resetDb();
  const app = await buildTestApp({ memberUploadQuotaBytes: 100 });
  const user = await seedUser('member');
  await seedBook({ uploadedBy: user.id, sha256: sha('c'), size: 80 });
  const res = await app.inject({ method: 'POST', url: '/api/uploads', headers: authHeader(user), payload: {
    filename: 'big.pdf', size: 30, sha256: sha('d'), contentType: 'application/pdf',
  }});
  expect(res.statusCode).toBe(409);
  expect(res.json().error.code).toBe('QUOTA_EXCEEDED');
});
it('does not oversell the quota under concurrent uploads', async () => {
  await resetDb();
  const app = await buildTestApp({ memberUploadQuotaBytes: 100 });
  const user = await seedUser('member');
  const payload = (c: string) => ({ filename: 'x.pdf', size: 60, sha256: sha(c), contentType: 'application/pdf' });
  const [a, b] = await Promise.all([
    app.inject({ method: 'POST', url: '/api/uploads', headers: authHeader(user), payload: payload('e') }),
    app.inject({ method: 'POST', url: '/api/uploads', headers: authHeader(user), payload: payload('f') }),
  ]);
  expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
});
it('rejects a file whose bytes do not match its extension', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const created = (await app.inject({ method: 'POST', url: '/api/uploads', headers: authHeader(user), payload: {
    filename: 'fake.pdf', size: PDF_HEAD.length, sha256: sha('1'), contentType: 'application/pdf',
  }})).json();
  const key = findSessionObjectKey(created.uploadId);
  await fakeStorage.putObject(key, Buffer.from('not a pdf at all'), 'application/pdf');
  const res = await app.inject({ method: 'POST', url: `/api/uploads/${created.uploadId}/complete`, headers: authHeader(user) });
  expect(res.statusCode).toBe(422);
  expect(res.json().error.code).toBe('INVALID_FILE');
  expect(await fakeStorage.head(key)).toBeNull();
});
it('completes a valid upload and queues metadata extraction', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const created = (await app.inject({ method: 'POST', url: '/api/uploads', headers: authHeader(user), payload: {
    filename: ' Sample Book.pdf', size: PDF_HEAD.length, sha256: sha('2'), contentType: 'application/pdf',
  }})).json();
  const key = findSessionObjectKey(created.uploadId);
  await fakeStorage.putObject(key, PDF_HEAD, 'application/pdf');
  const res = await app.inject({ method: 'POST', url: `/api/uploads/${created.uploadId}/complete`, headers: authHeader(user) });
  expect(res.statusCode).toBe(200);
  expect(res.json().book).toMatchObject({ title: 'Sample Book', format: 'pdf', size: PDF_HEAD.length });
  expect(enqueuedJobs()).toContainEqual(expect.objectContaining({ type: 'metadata' }));
});
it('expires stale sessions and deletes their objects', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const created = (await app.inject({ method: 'POST', url: '/api/uploads', headers: authHeader(user), payload: {
    filename: 'old.pdf', size: 10, sha256: sha('3'), contentType: 'application/pdf',
  }})).json();
  await expireSession(created.uploadId, 25 * 3600 * 1000);
  const removed = await cleanupExpiredUploadsForTest();
  expect(removed).toBe(1);
  expect(await fakeStorage.head(findSessionObjectKey(created.uploadId))).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bookr/server test -- test/uploads.test.ts`
Expected: FAIL — upload routes missing.

- [ ] **Step 3: Implement storage, sessions, quota, dedupe and completion**

Add `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` to server dependencies. `storage/s3.ts` uses them with `forcePathStyle: true` (MinIO) and `@aws-sdk/s3-request-presigner`. `presignPut` signs `PutObjectCommand({ Bucket, Key, ContentType })` with 900 seconds. `readFirstBytes` uses `GetObjectCommand` with `Range: bytes=0-15`.

`uploads/magic.ts`:
- PDF: first 5 bytes `%PDF-`.
- EPUB: `PK\x03\x04`.
- MOBI/AZW3: bytes 60–67 equal `BOOKMOBI`.

`uploads/service.ts`:
- `createUpload` resolves the library with `getLibrary(deps)`, then runs in a transaction with `SELECT pg_advisory_xact_lock(741852963)`, then:
  1. Active duplicate: `books WHERE library_id=? AND sha256=? AND deleted_at IS NULL` → throw `AppError(409, 'DUPLICATE_BOOK', { existingBookId })`.
  2. `libraryUsed = SUM(books.original_size) + SUM(upload_sessions.size WHERE status='created' AND expires_at > now())`; `memberUsed` filtered by the same `uploaded_by`/`user_id`.
  3. If `libraryUsed + size > config.libraryQuotaBytes` or `memberUsed + size > config.memberUploadQuotaBytes` → `AppError(409, 'QUOTA_EXCEEDED')`.
  4. Insert session with `object_key = library/{libraryId}/books/{uploadId}/original.{format}`, `expires_at = now + 24h`; return presigned PUT.
- `completeUpload` runs in a transaction: load session for `userId`, require status `created` and not expired; `head` object and compare `size` to session size (and ≤ `MAX_UPLOAD_BYTES`); `readFirstBytes` and `sniffMagic`; on failure delete object, set status `failed`, throw `AppError(422, 'INVALID_FILE')`; on success insert book (`title` = filename without final extension, trimmed; `metadata_status='pending'`; `conversion_status` = `pending` for mobi/azw3 else `none`), set session `completed`, enqueue `metadata` and (for mobi/azw3) `convert` jobs. Unique-index violation on insert → delete object, mark session failed, throw `DUPLICATE_BOOK`.
- `cleanupExpiredUploads`: delete objects for sessions `status='created' AND expires_at < now()`, mark them `expired`, return count.

`jobs/queue.ts`: `PostgresJobQueue` inserts into `jobs` and claims with `FOR UPDATE SKIP LOCKED`; `complete` sets `done`; `fail` increments `attempts`, stores `last_error`, and schedules retry with exponential backoff (max 3 attempts). Job payload types: `metadata { bookId }`, `convert { bookId }`, `cleanup {}`.

Test helpers to add in `test/helpers.ts`:
- `fakeStorage`: exported `FakeStorage` instance used by the app.
- `enqueuedJobs()`: returns jobs enqueued through `FakeJobQueue`.
- `findSessionObjectKey(uploadId)`: reads `object_key` from `upload_sessions`.
- `expireSession(uploadId, msAgo)`: updates `expires_at`.
- `cleanupExpiredUploadsForTest()`: calls `cleanupExpiredUploads` with test deps.
- `seedBook(input)`, `seedUser(role)`, `authHeader(user)`, `resetDb()`, `buildTestApp(overrides?: Partial<AppConfig>)`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @bookr/server test -- test/uploads.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/storage apps/server/src/uploads apps/server/src/jobs apps/server/src/db apps/server/test
git commit -m "feat(server): add presigned uploads with quota, dedupe and magic checks"
```

---

### Task 8: Book service and routes with permissions

**Files:**
- Create: `apps/server/src/books/repo.ts`, `src/books/service.ts`, `src/books/routes.ts`
- Modify: `apps/server/src/app.ts` to register book routes
- Test: `apps/server/test/books.test.ts`

**Interfaces:**
- Produces: `listBooks(deps, query: ListBooksQuery): Promise<{ items: BookDto[]; total: number; page: number; pageSize: number }>`.
- Produces: `getBook(deps, bookId: string): Promise<BookDto>`.
- Produces: `updateBook(deps, actor: { id: string; role: Role }, bookId: string, patch: UpdateBookInput): Promise<BookDto>`.
- Produces: `softDeleteBook(deps, actor, bookId): Promise<void>`; `restoreBook(deps, actor, bookId): Promise<BookDto>`; `listTrash(deps): Promise<BookDto[]>`.
- Produces: `toBookDto(deps, book, categories): Promise<BookDto>` — cover URL signed for 3600 seconds.
- Produces: `replaceCover(deps, actor, bookId, file: { buffer: Buffer; contentType: string }): Promise<{ coverUrl: string }>` — uploader/admin only; max 5 MiB; `image/jpeg|png|webp`.
- Produces: `cleanupTrash(deps): Promise<number>` — hard-deletes books soft-deleted more than 30 days ago and their stored objects.
- Routes: `GET /api/books`, `GET /api/books/:id`, `PATCH /api/books/:id`, `DELETE /api/books/:id`, `POST /api/books/:id/restore`, `GET /api/trash`, `POST /api/books/:id/cover`.

- [ ] **Step 1: Write the failing test**

`test/books.test.ts`:
```ts
import FormData from 'form-data';
import { describe, expect, it } from 'vitest';
import { buildTestApp, seedBook, seedUser, authHeader, resetDb, testDb, fakeStorage, cleanupTrashForTest, getBookRow } from './helpers';
import { books } from '../src/db/schema';

it('lists books uploaded by other members in the shared shelf', async () => {
  await resetDb();
  const app = await buildTestApp();
  const alice = await seedUser('member', 'alice');
  const bob = await seedUser('member', 'bob');
  await seedBook({ uploadedBy: alice.id, title: '共享的书' });
  const res = await app.inject({ method: 'GET', url: '/api/books', headers: authHeader(bob) });
  expect(res.statusCode).toBe(200);
  expect(res.json().items.map((b: { title: string }) => b.title)).toContain('共享的书');
});
it('filters by query, format, status and category, and paginates', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  await seedBook({ uploadedBy: user.id, title: '深入理解计算机系统', author: 'Bryant', format: 'pdf' });
  await seedBook({ uploadedBy: user.id, title: '三体', author: '刘慈欣', format: 'epub', status: 'finished' });
  const byQuery = await app.inject({ method: 'GET', url: '/api/books?query=刘慈欣', headers: authHeader(user) });
  expect(byQuery.json().items).toHaveLength(1);
  const byFormat = await app.inject({ method: 'GET', url: '/api/books?format=pdf', headers: authHeader(user) });
  expect(byFormat.json().items).toHaveLength(1);
  const paged = await app.inject({ method: 'GET', url: '/api/books?pageSize=1&page=2&sort=title', headers: authHeader(user) });
  expect(paged.json()).toMatchObject({ total: 2, page: 2, pageSize: 1 });
});
it('forbids a member from editing or deleting another member\'s book', async () => {
  await resetDb();
  const app = await buildTestApp();
  const owner = await seedUser('member', 'owner');
  const other = await seedUser('member', 'other');
  const book = await seedBook({ uploadedBy: owner.id, title: '原书名' });
  const patch = await app.inject({ method: 'PATCH', url: `/api/books/${book.id}`, headers: authHeader(other), payload: { title: '被改了' } });
  expect(patch.statusCode).toBe(403);
  const del = await app.inject({ method: 'DELETE', url: `/api/books/${book.id}`, headers: authHeader(other) });
  expect(del.statusCode).toBe(403);
  const [row] = await testDb.select().from(books);
  expect(row.title).toBe('原书名');
  expect(row.deletedAt).toBeNull();
});
it('lets the uploader and an admin edit the book', async () => {
  await resetDb();
  const app = await buildTestApp();
  const owner = await seedUser('member', 'owner');
  const admin = await seedUser('admin', 'admin');
  const book = await seedBook({ uploadedBy: owner.id, title: '原书名' });
  const byOwner = await app.inject({ method: 'PATCH', url: `/api/books/${book.id}`, headers: authHeader(owner), payload: { title: '作者改的' } });
  expect(byOwner.statusCode).toBe(200);
  const byAdmin = await app.inject({ method: 'PATCH', url: `/api/books/${book.id}`, headers: authHeader(admin), payload: { title: '管理员改的' } });
  expect(byAdmin.statusCode).toBe(200);
  expect(byAdmin.json().book.title).toBe('管理员改的');
});
it('soft-deletes, hides from the shelf, lists in trash and restores', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id, title: '待删' });
  expect((await app.inject({ method: 'DELETE', url: `/api/books/${book.id}`, headers: authHeader(user) })).statusCode).toBe(204);
  expect((await app.inject({ method: 'GET', url: '/api/books', headers: authHeader(user) })).json().items).toHaveLength(0);
  expect((await app.inject({ method: 'GET', url: '/api/trash', headers: authHeader(user) })).json().items).toHaveLength(1);
  expect((await app.inject({ method: 'POST', url: `/api/books/${book.id}/restore`, headers: authHeader(user) })).statusCode).toBe(200);
  expect((await app.inject({ method: 'GET', url: '/api/books', headers: authHeader(user) })).json().items).toHaveLength(1);
});
it('lets the uploader replace the cover but forbids other members', async () => {
  await resetDb();
  const app = await buildTestApp();
  const owner = await seedUser('member', 'owner');
  const other = await seedUser('member', 'other');
  const book = await seedBook({ uploadedBy: owner.id });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const makeForm = () => { const form = new FormData(); form.append('file', png, { filename: 'cover.png', contentType: 'image/png' }); return form; };
  const deniedForm = makeForm();
  const denied = await app.inject({ method: 'POST', url: `/api/books/${book.id}/cover`, headers: { ...authHeader(other), ...deniedForm.getHeaders() }, payload: deniedForm });
  expect(denied.statusCode).toBe(403);
  const okForm = makeForm();
  const ok = await app.inject({ method: 'POST', url: `/api/books/${book.id}/cover`, headers: { ...authHeader(owner), ...okForm.getHeaders() }, payload: okForm });
  expect(ok.statusCode).toBe(200);
  expect(ok.json().coverUrl).toContain('cover');
});
it('purges books deleted more than 30 days ago', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id });
  await fakeStorage.putObject(book.fileKey!, Buffer.from('%PDF-1.7'), 'application/pdf');
  await testDb.update(books).set({ deletedAt: new Date(Date.now() - 31 * 86_400_000) }).where(eq(books.id, book.id));
  expect(await cleanupTrashForTest()).toBe(1);
  expect(await getBookRow(book.id)).toBeUndefined();
  expect(await fakeStorage.head(book.fileKey!)).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bookr/server test -- test/books.test.ts`
Expected: FAIL — routes missing.

- [ ] **Step 3: Implement repo, service and routes**

`repo.ts` builds the list query with optional `ILIKE` on title/author, format/status filters, category join, sorting (`recent` = `updated_at desc`, `added` = `created_at desc`, `title` = `title asc`), `COUNT(*)` for total, and `LIMIT/OFFSET`. Fetch categories for the page in one query.

Permission rule in one place: `canManage(actor, book) = actor.role === 'admin' || book.uploadedBy === actor.id`. Both PATCH and DELETE use it; otherwise `AppError(403, 'FORBIDDEN')`.

Delete sets `deleted_at = now()` and writes an `audit_logs` row `action='book.delete'`. Restore clears `deleted_at` and writes `book.restore`. Both require `canManage`.

Add `@fastify/multipart` to server dependencies (and `form-data` for tests). `replaceCover` uses it with a 5 MiB limit, validates the image magic bytes, writes `covers/{bookId}.{ext}` and returns a fresh signed URL. `cleanupTrash` selects books with `deleted_at < now() - 30 days`, deletes `file_key`, `cover_key`, `epub_key`, `text_layer_key` and `reflow_key` from storage, then deletes the rows; it is called daily by the worker.

`toBookDto` signs `cover_key` when present; `progressPercent` is 0 until the reader plan adds progress.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @bookr/server test -- test/books.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/books apps/server/test/books.test.ts
git commit -m "feat(server): add shared bookshelf queries and permission checks"
```

---

### Task 9a: Metadata and cover extraction

**Files:**
- Create: `apps/server/src/books/metadata.ts`
- Create: `apps/server/src/jobs/worker.ts`
- Create: `apps/server/scripts/make-fixtures.ts` and generated `test/fixtures/sample.epub`, `test/fixtures/sample.pdf`
- Test: `apps/server/test/metadata.test.ts`

**Interfaces:**
- Produces: `extractMetadata(input: { buffer: Buffer; format: BookFormat }): Promise<{ title?: string; author?: string; description?: string; cover?: { data: Buffer; contentType: 'image/png' | 'image/jpeg' } }>`.
- Produces: `runMetadataJob(deps, bookId: string): Promise<void>` — downloads the original, extracts, writes `title/author/description/cover_key`, sets `metadata_status` to `done` or `failed`.
- Produces: `startWorker(deps): () => Promise<void>` — polls jobs, dispatches `metadata|convert|cleanup`.

- [ ] **Step 1: Write the failing test**

`test/metadata.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { extractMetadata } from '../src/books/metadata';

it('extracts title, author and cover from an EPUB', async () => {
  const result = await extractMetadata({ buffer: readFileSync('test/fixtures/sample.epub'), format: 'epub' });
  expect(result.title).toBe('测试之书');
  expect(result.author).toBe('张三');
  expect(result.cover?.contentType).toBe('image/png');
  expect(result.cover!.data.length).toBeGreaterThan(100);
});
it('extracts metadata and renders a cover from a PDF', async () => {
  const result = await extractMetadata({ buffer: readFileSync('test/fixtures/sample.pdf'), format: 'pdf' });
  expect(result.title).toBe('PDF 测试');
  expect(result.cover?.contentType).toBe('image/png');
  expect(result.cover!.data.length).toBeGreaterThan(1000);
});
it('marks the metadata job failed without losing the book', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id, title: '坏文件', metadataStatus: 'pending' });
  await fakeStorage.putObject(book.fileKey!, Buffer.from('broken'), 'application/pdf');
  await runMetadataJobForTest(book.id);
  const [row] = await testDb.select().from(books).where(eq(books.id, book.id));
  expect(row.metadataStatus).toBe('failed');
  expect(row.title).toBe('坏文件');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bookr/server test -- test/metadata.test.ts`
Expected: FAIL — module missing or fixtures absent.

- [ ] **Step 3: Generate fixtures and implement extraction**

`scripts/make-fixtures.ts` writes:
- `sample.epub`: zip with `mimetype` (stored, first entry), `META-INF/container.xml`, `OEBPS/content.opf` with `<dc:title>测试之书</dc:title>`, `<dc:creator>张三</dc:creator>`, a manifest cover `cover.png` and a 1×1 PNG generated with `pngjs`.
- `sample.pdf`: one A4 page via `pdf-lib`, metadata title `PDF 测试`.

Run `pnpm --filter @bookr/server tsx scripts/make-fixtures.ts`, commit the fixtures.

Add dependencies `adm-zip`, `fast-xml-parser`, `pdfjs-dist`, `@napi-rs/canvas`, `pngjs` (fixtures) and `pdf-lib` (fixtures). EPUB parsing uses `adm-zip` and `fast-xml-parser`: read `META-INF/container.xml` → `rootfile@full-path` → OPF → `metadata.title/creator/description` → manifest item with `properties="cover-image"` or `meta name="cover" content="<id>"` → entry bytes.
PDF parsing uses `pdfjs-dist/legacy/build/pdf.mjs` with `getMetadata()` and page 1 render at scale 1.5 into `@napi-rs/canvas`; export PNG. If the PDF has no title, return `undefined` (the book keeps its filename title).
`runMetadataJob` catches all errors, writes `metadata_status='failed'`, logs only the book id and error class (no text), and rethrows nothing.

Test helpers used by this task: `runMetadataJobForTest(bookId)` calls `runMetadataJob` with `buildTestDeps()`; `seedBook` accepts overrides including `metadataStatus` and `fileKey`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @bookr/server test -- test/metadata.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/books/metadata.ts apps/server/src/jobs apps/server/scripts apps/server/test
git commit -m "feat(server): extract EPUB/PDF metadata and covers in background jobs"
```

---

### Task 9b: MOBI/AZW3 conversion with visible failure

**Files:**
- Create: `apps/server/src/books/conversion.ts`
- Modify: `apps/server/src/jobs/worker.ts` (handle `convert`)
- Modify: `apps/server/src/app.ts` (add `converter` to `AppDeps`)
- Modify: `apps/server/src/books/routes.ts` (`POST /api/books/:id/convert`)
- Test: `apps/server/test/conversion.test.ts`

**Interfaces:**
- Produces: `Converter { convert(input: { path: string; format: BookFormat }, outputPath: string): Promise<void> }`; `CalibreConverter` spawns `ebook-convert`.
- Produces: `runConvertJob(deps, bookId: string): Promise<void>` — downloads original to a temp dir, converts, uploads `library/{libraryId}/books/{bookId}/converted.epub`, sets `epub_key` and `conversion_status='done'`; on failure sets `failed` and `conversion_error`, leaves original untouched.
- Route: `POST /api/books/:id/convert` → 202 for uploader/admin when status is `failed`; 409 otherwise; 403 for other members.

- [ ] **Step 1: Write the failing test**

`test/conversion.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildTestApp, seedBook, seedUser, authHeader, resetDb, fakeStorage, fakeConverter } from './helpers';
import { runConvertJob } from '../src/books/conversion';

it('converts MOBI to EPUB and keeps the original file', async () => {
  await resetDb();
  const deps = await buildTestDeps();
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id, format: 'mobi', conversionStatus: 'pending' });
  await fakeStorage.putObject(book.fileKey!, Buffer.from('BOOKMOBI'), 'application/x-mobipocket-ebook');
  fakeConverter.onConvert = async (_input, outputPath) => {
    writeFileSync(outputPath, readFileSync('test/fixtures/sample.epub'));
  };
  await runConvertJob(deps, book.id);
  const converted = await getBookRow(book.id);
  expect(converted.conversionStatus).toBe('done');
  expect(converted.epubKey).toContain('converted.epub');
  expect(await fakeStorage.head(book.fileKey!)).not.toBeNull();
});
it('marks a failed conversion but keeps the original downloadable', async () => {
  await resetDb();
  const deps = await buildTestDeps();
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id, format: 'azw3', conversionStatus: 'pending' });
  await fakeStorage.putObject(book.fileKey!, Buffer.from('BOOKMOBI'), 'application/vnd.amazon.ebook');
  fakeConverter.onConvert = async () => { throw new Error('calibre exploded'); };
  await runConvertJob(deps, book.id);
  const converted = await getBookRow(book.id);
  expect(converted.conversionStatus).toBe('failed');
  expect(converted.conversionError).toMatch(/calibre exploded/);
  expect(await fakeStorage.head(book.fileKey!)).not.toBeNull();
});
it('only lets the uploader or an admin retry a failed conversion', async () => {
  await resetDb();
  const app = await buildTestApp();
  const owner = await seedUser('member', 'owner');
  const other = await seedUser('member', 'other');
  const admin = await seedUser('admin', 'admin');
  const book = await seedBook({ uploadedBy: owner.id, format: 'mobi', conversionStatus: 'failed' });
  expect((await app.inject({ method: 'POST', url: `/api/books/${book.id}/convert`, headers: authHeader(other) })).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url: `/api/books/${book.id}/convert`, headers: authHeader(owner) })).statusCode).toBe(202);
  expect((await app.inject({ method: 'POST', url: `/api/books/${book.id}/convert`, headers: authHeader(admin) })).statusCode).toBe(202);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bookr/server test -- test/conversion.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement conversion**

`CalibreConverter.convert` spawns `ebook-convert <input> <output>` with `stdio: 'ignore'` and rejects on non-zero exit; the book's format is passed only for logging. Use `mkdtemp` for the temp directory and always `rm` it in `finally`.

`runConvertJob`:
1. Load the book; skip unless format is `mobi|azw3` and `conversion_status !== 'done'`.
2. Download `file_key` to a temp file using `StorageService` (add `getObject(key): Promise<Buffer>` if not present).
3. Convert, upload with `putObject(..., 'application/epub+zip')`, update book.
4. On error update `conversion_status='failed'`, `conversion_error = error.message`; never delete `file_key`.
5. Audit log `book.convert`.

Add `converter: Converter` to `AppDeps`; production uses `CalibreConverter`, tests inject `FakeConverter`. `FakeConverter` exposes `onConvert` and records calls. `buildTestDeps()` returns the same dependency object used by `buildTestApp`, so jobs and routes share `fakeStorage`. `getBookRow(id)` returns the raw `books` row.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @bookr/server test -- test/conversion.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/books apps/server/src/jobs apps/server/test
git commit -m "feat(server): convert MOBI/AZW3 in the background without losing originals"
```

---

### Task 10: Shared categories

**Files:**
- Create: `apps/server/src/categories/routes.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/test/categories.test.ts`

**Interfaces:**
- Routes: `GET /api/categories` → `{ items: CategoryDto[] }`; `POST /api/categories` → 201 `CategoryDto`; `PATCH /api/categories/:id` → 200; `DELETE /api/categories/:id` → 204.
- Rule: any active member may create; only admins may rename, recolor, reorder or delete.
- Deleting a category removes `book_categories` rows but never deletes books.

- [ ] **Step 1: Write the failing test**

`test/categories.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildTestApp, seedBook, seedUser, authHeader, resetDb, testDb } from './helpers';
import { bookCategories } from '../src/db/schema';

it('lets members create categories and lists them for everyone', async () => {
  await resetDb();
  const app = await buildTestApp();
  const alice = await seedUser('member', 'alice');
  const bob = await seedUser('member', 'bob');
  const created = await app.inject({ method: 'POST', url: '/api/categories', headers: authHeader(alice), payload: { name: '历史', color: '#8C5A3B' } });
  expect(created.statusCode).toBe(201);
  const list = await app.inject({ method: 'GET', url: '/api/categories', headers: authHeader(bob) });
  expect(list.json().items).toHaveLength(1);
});
it('forbids members from renaming or deleting categories', async () => {
  await resetDb();
  const app = await buildTestApp();
  const member = await seedUser('member');
  const admin = await seedUser('admin', 'admin');
  const category = (await app.inject({ method: 'POST', url: '/api/categories', headers: authHeader(member), payload: { name: '历史', color: '#8C5A3B' } })).json();
  expect((await app.inject({ method: 'PATCH', url: `/api/categories/${category.id}`, headers: authHeader(member), payload: { name: '改名' } })).statusCode).toBe(403);
  expect((await app.inject({ method: 'DELETE', url: `/api/categories/${category.id}`, headers: authHeader(member) })).statusCode).toBe(403);
  expect((await app.inject({ method: 'PATCH', url: `/api/categories/${category.id}`, headers: authHeader(admin), payload: { name: '改名' } })).statusCode).toBe(200);
});
it('assigns categories to books and detaches them on delete without deleting the book', async () => {
  await resetDb();
  const app = await buildTestApp();
  const admin = await seedUser('admin');
  const book = await seedBook({ uploadedBy: admin.id });
  const category = (await app.inject({ method: 'POST', url: '/api/categories', headers: authHeader(admin), payload: { name: '小说', color: '#5B6B8C' } })).json();
  const patched = await app.inject({ method: 'PATCH', url: `/api/books/${book.id}`, headers: authHeader(admin), payload: { categoryIds: [category.id] } });
  expect(patched.json().book.categories).toHaveLength(1);
  expect((await app.inject({ method: 'DELETE', url: `/api/categories/${category.id}`, headers: authHeader(admin) })).statusCode).toBe(204);
  expect(await testDb.select().from(bookCategories)).toHaveLength(0);
  expect((await app.inject({ method: 'GET', url: `/api/books/${book.id}`, headers: authHeader(admin) })).statusCode).toBe(200);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bookr/server test -- test/categories.test.ts`
Expected: FAIL — routes missing.

- [ ] **Step 3: Implement category routes**

All endpoints require auth. `POST` inserts with `library_id` from the single library and `created_by`. `PATCH`/`DELETE` call `makeRequireAdmin`. `DELETE` relies on `ON DELETE CASCADE` for `book_categories`. Book `PATCH` in the books service replaces `book_categories` in the same transaction when `categoryIds` is present and validates that every id exists in the library.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @bookr/server test -- test/categories.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/categories apps/server/src/books apps/server/test
git commit -m "feat(server): add shared categories with admin-only management"
```

---

### Task 11: Admin API for members, invites and storage

**Files:**
- Create: `apps/server/src/admin/routes.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/test/admin.test.ts`

**Interfaces:**
- Routes (all `requireAdmin`):
  - `GET /api/admin/members` → `{ items: Array<{ id, username, displayName, role, isActive, uploadQuotaBytes, usedBytes, createdAt }> }`
  - `PATCH /api/admin/members/:id` body `{ isActive?: boolean; uploadQuotaBytes?: number; password?: string }` → 200 member summary
  - `POST /api/admin/invites` body `{ expiresInHours?: number }` (default 72, max 720) → 201 `{ code, expiresAt }`
  - `GET /api/admin/invites` → `{ items: Array<{ code, expiresAt, usedBy, revokedAt }> }`
  - `DELETE /api/admin/invites/:code` → 204 (sets `revoked_at`)
  - `GET /api/admin/storage` → `{ totalBytes, usedBytes, perMember: Array<{ userId, displayName, usedBytes }> }`
- Rule: a member's own password reset marks all their devices revoked.

- [ ] **Step 1: Write the failing test**

`test/admin.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildTestApp, seedBook, seedUser, authHeader, resetDb } from './helpers';

it('rejects every admin route for members', async () => {
  await resetDb();
  const app = await buildTestApp();
  const member = await seedUser('member');
  for (const url of ['/api/admin/members', '/api/admin/invites', '/api/admin/storage']) {
    expect((await app.inject({ method: 'GET', url, headers: authHeader(member) })).statusCode).toBe(403);
  }
});
it('creates, lists and revokes invites', async () => {
  await resetDb();
  const app = await buildTestApp();
  const admin = await seedUser('admin');
  const created = await app.inject({ method: 'POST', url: '/api/admin/invites', headers: authHeader(admin), payload: { expiresInHours: 24 } });
  expect(created.statusCode).toBe(201);
  const code = created.json().code;
  expect((await app.inject({ method: 'GET', url: '/api/admin/invites', headers: authHeader(admin) })).json().items).toHaveLength(1);
  expect((await app.inject({ method: 'DELETE', url: `/api/admin/invites/${code}`, headers: authHeader(admin) })).statusCode).toBe(204);
  const register = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { inviteCode: code, username: 'newbie', password: 'a-long-password', displayName: '新人' } });
  expect(register.json().error.code).toBe('INVITE_INVALID');
});
it('disables a member and revokes their sessions', async () => {
  await resetDb();
  const app = await buildTestApp();
  const admin = await seedUser('admin');
  const member = await seedUser('member');
  const tokens = await loginAs(app, member);
  const res = await app.inject({ method: 'PATCH', url: `/api/admin/members/${member.id}`, headers: authHeader(admin), payload: { isActive: false } });
  expect(res.statusCode).toBe(200);
  const denied = await app.inject({ method: 'GET', url: '/api/books', headers: { authorization: `Bearer ${tokens.accessToken}` } });
  expect(denied.statusCode).toBe(401);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: member.username, password: 'valid-password-1' } });
  expect(login.statusCode).toBe(403);
});
it('resets a member password and revokes their sessions', async () => {
  await resetDb();
  const app = await buildTestApp();
  const admin = await seedUser('admin');
  const member = await seedUser('member');
  const tokens = await loginAs(app, member);
  const res = await app.inject({ method: 'PATCH', url: `/api/admin/members/${member.id}`, headers: authHeader(admin), payload: { password: 'brand-new-password' } });
  expect(res.statusCode).toBe(200);
  expect((await app.inject({ method: 'GET', url: '/api/books', headers: { authorization: `Bearer ${tokens.accessToken}` } })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: member.username, password: 'valid-password-1' } })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: member.username, password: 'brand-new-password' } })).statusCode).toBe(200);
});
it('reports total and per-member storage usage', async () => {
  await resetDb();
  const app = await buildTestApp();
  const admin = await seedUser('admin');
  const member = await seedUser('member');
  await seedBook({ uploadedBy: member.id, size: 300 });
  await seedBook({ uploadedBy: admin.id, size: 200 });
  const res = await app.inject({ method: 'GET', url: '/api/admin/storage', headers: authHeader(admin) });
  expect(res.json()).toMatchObject({ usedBytes: 500 });
  expect(res.json().perMember).toEqual(expect.arrayContaining([expect.objectContaining({ userId: member.id, usedBytes: 300 })]));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bookr/server test -- test/admin.test.ts`
Expected: FAIL — routes missing.

- [ ] **Step 3: Implement admin routes**

Member listing aggregates `SUM(books.original_size) WHERE deleted_at IS NULL GROUP BY uploaded_by`. Disabling (`isActive: false`) also sets `devices.revoked_at = now()` for that user; the auth guard checks `users.is_active` on every request, so existing access tokens stop working immediately. `test/helpers.ts` adds `loginAs(app, user)`, which logs in with the seeded password `valid-password-1` and returns `AuthTokens`. Password reset hashes with the same Argon2id settings and revokes devices. Invite codes are 10 characters from an unambiguous alphabet (`23456789ABCDEFGHJKMNPQRSTUVWXYZ`), unique retry on conflict. Storage totals exclude soft-deleted books and include active upload sessions.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @bookr/server test -- test/admin.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/admin apps/server/test/admin.test.ts
git commit -m "feat(server): add admin member, invite and storage endpoints"
```

---

### Task 12: UI design tokens, app shell and auth pages

**Files:**
- Create: `packages/ui/package.json`, `src/tokens.ts`, `src/theme.css`, `src/components/Button.tsx`, `Input.tsx`, `Dialog.tsx`, `EmptyState.tsx`, `src/index.ts`, `src/__tests__/ui.test.tsx`
- Create: `apps/web/package.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/app/router.tsx`, `src/app/providers.tsx`, `src/app/AppLayout.tsx`
- Create: `apps/web/src/api/client.ts`, `src/api/auth.ts`, `src/features/auth/LoginPage.tsx`, `src/features/auth/RegisterPage.tsx`
- Create: `apps/web/test/setup.ts`, `src/features/auth/__tests__/auth-pages.test.tsx`

**Interfaces:**
- Produces: `tokens` object with `paper`, `surface`, `ink`, `muted`, `accent`, `border`, `highlight` colors; `fontSerif`, `fontSans`.
- Produces components: `Button({ variant?: 'primary'|'ghost'|'danger'; size?: 'sm'|'md'; loading?: boolean })`, `Input`, `Dialog({ open, onClose, title, children })`, `EmptyState({ title, description, action? })`.
- Produces: `apiFetch<T>(path: string, init?: RequestInit): Promise<T>` — attaches `Authorization`, refreshes once on 401, clears session and redirects to `/login` on failure.
- Produces: `useAuth()` with `{ user, login, register, logout, loading }`.
- Routes: `/login`, `/register`, `/` (protected bookshelf placeholder).

- [ ] **Step 1: Write the failing tests**

`packages/ui/src/__tests__/ui.test.tsx`:
```tsx
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from '../components/Button';
import { tokens } from '../tokens';

it('pins the paper-ink palette', () => {
  expect(tokens.paper).toBe('#F6F1E7');
  expect(tokens.ink).toBe('#2B2620');
  expect(tokens.accent).toBe('#8C5A3B');
});
it('disables the button while loading and keeps its label', () => {
  render(<Button loading>保存</Button>);
  const button = screen.getByRole('button', { name: '保存' });
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute('aria-busy', 'true');
});
```

`apps/web/src/features/auth/__tests__/auth-pages.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { routes } from '../../../app/router';
import { renderWithProviders } from '../../../../test/setup';

it('redirects an unauthenticated visitor from / to /login', async () => {
  const router = createMemoryRouter(routes, { initialEntries: ['/'] });
  renderWithProviders(<RouterProvider router={router} />);
  await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
});
it('shows an error when login fails', async () => {
  const router = createMemoryRouter(routes, { initialEntries: ['/login'] });
  renderWithProviders(<RouterProvider router={router} />);
  await userEvent.type(screen.getByLabelText('用户名'), 'reader');
  await userEvent.type(screen.getByLabelText('密码'), 'a-long-password');
  await userEvent.click(screen.getByRole('button', { name: '登录' }));
  expect(await screen.findByText('用户名或密码错误')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bookr/ui test && pnpm --filter @bookr/web test`
Expected: FAIL — components missing.

- [ ] **Step 3: Implement tokens, components and auth flow**

`theme.css` defines the same values as CSS variables (`--color-paper`, `--color-ink`, ...) and Tailwind 4 `@theme` mappings. `tokens.ts` is the single source the tests pin; keep values in sync manually and add a comment pointing at `theme.css`.

`Button`: `aria-busy={loading}`, `disabled={disabled || loading}`, variants map to token colors. `Input` forwards `label`, `error`, `id`. `Dialog` renders a native `<dialog>` with a backdrop and closes on Escape. `EmptyState` centers a short message.

`providers.tsx` sets up `QueryClientProvider`, `BrowserRouter` (memory router in tests via `createMemoryRouter`), and the auth context. Tokens persist in `localStorage` under `bookr.tokens`; the API client reads and rotates them.

`LoginPage` and `RegisterPage` use the shared `Input`/`Button`, show inline field errors, and navigate to `/` on success. Register requires an invite code field.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @bookr/ui test && pnpm --filter @bookr/web test`
Expected: PASS — 2 UI tests + 2 web tests.

- [ ] **Step 5: Commit**

```bash
git add packages/ui apps/web
git commit -m "feat(web): add paper-ink design tokens, app shell and auth pages"
```

---

### Task 13: Bookshelf, filters and trash UI

**Files:**
- Create: `apps/web/src/api/books.ts`, `src/api/categories.ts`
- Create: `apps/web/src/features/bookshelf/BookshelfPage.tsx`, `BookCard.tsx`, `FilterBar.tsx`, `EditBookDialog.tsx`, `TrashPage.tsx`
- Modify: `apps/web/src/app/router.tsx` (add `/`, `/trash`)
- Test: `apps/web/src/features/bookshelf/__tests__/bookshelf.test.tsx`

**Interfaces:**
- Produces: `useBooks(query)`, `useBook(id)`, `useUpdateBook()`, `useDeleteBook()`, `useRestoreBook()`, `useTrash()`, `useCategories()`, `useCreateCategory()`.
- Query params: `query`, `format`, `status`, `categoryId`, `sort`, `page`, `pageSize`.
- UI shows edit/delete only when `user.role === 'admin' || book.uploadedBy.id === user.id`.

- [ ] **Step 1: Write the failing test**

`apps/web/src/features/bookshelf/__tests__/bookshelf.test.tsx`:
```tsx
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { routes } from '../../../app/router';
import { renderWithProviders, server } from '../../../../test/setup';
import { http, HttpResponse } from 'msw';

it('renders the shared shelf with books from other members', async () => {
  const router = createMemoryRouter(routes, { initialEntries: ['/'] });
  renderWithProviders(<RouterProvider router={router} />);
  expect(await screen.findByText('深入理解计算机系统')).toBeInTheDocument();
  expect(await screen.findByText('三体')).toBeInTheDocument();
});
it('sends filters to the API when the format filter changes', async () => {
  let lastUrl = '';
  server.use(http.get('/api/books', ({ request }) => { lastUrl = request.url; return HttpResponse.json({ items: [], total: 0, page: 1, pageSize: 24 }); }));
  const router = createMemoryRouter(routes, { initialEntries: ['/'] });
  renderWithProviders(<RouterProvider router={router} />);
  await userEvent.selectOptions(screen.getByLabelText('格式'), 'epub');
  expect(lastUrl).toContain('format=epub');
});
it('hides edit and delete for books uploaded by others', async () => {
  const router = createMemoryRouter(routes, { initialEntries: ['/'] });
  renderWithProviders(<RouterProvider router={router} />);
  const card = (await screen.findByText('三体')).closest('[data-testid="book-card"]')!;
  expect(within(card as HTMLElement).queryByRole('button', { name: '编辑' })).toBeNull();
});
it('confirms before deleting and moves the book to trash', async () => {
  const router = createMemoryRouter(routes, { initialEntries: ['/'] });
  renderWithProviders(<RouterProvider router={router} />);
  await userEvent.click(await screen.findByRole('button', { name: '删除《深入理解计算机系统》' }));
  await userEvent.click(screen.getByRole('button', { name: '确认删除' }));
  expect(await screen.findByText('已移入回收站')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bookr/web test -- src/features/bookshelf`
Expected: FAIL — components missing.

- [ ] **Step 3: Implement shelf UI**

`BookshelfPage` uses TanStack Query with the filter state as the query key; shows a grid of `BookCard` (cover or paper-colored placeholder, title, author, progress bar, uploader), a `FilterBar` (search input debounced 300ms, format/status/category selects, sort select), and an `EmptyState` with an "上传第一本书" action. `BookCard` exposes `data-testid="book-card"`.

`EditBookDialog` edits title/author/description/status/categories, includes a cover replacement input (PNG/JPEG/WebP ≤5 MiB) calling `POST /api/books/:id/cover`, and saves with `PATCH /api/books/:id`. Delete uses a confirmation `Dialog`; success shows the toast "已移入回收站". `TrashPage` lists deleted books with a "恢复" action and shows the remaining retention days.

The shelf supports a grid/list toggle persisted in `localStorage`. When `me.libraryUsedBytes / me.libraryQuotaBytes > 0.9`, show a warning banner with a link to the admin storage view.

MSW fixtures in `apps/web/test/setup.ts`: two books (`深入理解计算机系统`, uploaded by the current user; `三体`, uploaded by another member), categories, and handlers for list/edit/delete/trash. The default current user is a `member`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @bookr/web test -- src/features/bookshelf`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api apps/web/src/features/bookshelf apps/web/src/app/router.tsx apps/web/test
git commit -m "feat(web): add bookshelf grid, filters, editing and trash"
```

---

### Task 13b: Admin members and invite UI

**Files:**
- Create: `apps/web/src/api/admin.ts`
- Create: `apps/web/src/features/admin/MembersPage.tsx`, `InviteDialog.tsx`
- Modify: `apps/web/src/app/router.tsx` (add `/admin/members`) and `AppLayout.tsx` (admin-only nav link)
- Test: `apps/web/src/features/admin/__tests__/admin.test.tsx`

**Interfaces:**
- Produces hooks: `useMembers()`, `useUpdateMember()`, `useInvites()`, `useCreateInvite()`, `useRevokeInvite()`, `useStorageOverview()`.
- Page shows: members with used bytes, active toggle, quota input, reset-password action; invite list with code, expiry, revoke; "生成邀请码" button that reveals the code with a copy button.
- Access: only `role === 'admin'` sees the nav link; members visiting `/admin/members` are redirected to `/`.

- [ ] **Step 1: Write the failing test**

`apps/web/src/features/admin/__tests__/admin.test.tsx`:
```tsx
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { it, expect } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { routes } from '../../../app/router';
import { renderWithProviders, server } from '../../../../test/setup';
import { http, HttpResponse } from 'msw';

it('lists members and creates an invite code for admins', async () => {
  server.use(http.get('/api/admin/members', () => HttpResponse.json({ items: [
    { id: 'u1', username: 'alice', displayName: 'Alice', role: 'member', isActive: true, uploadQuotaBytes: 1000, usedBytes: 300, createdAt: new Date().toISOString() },
  ] })));
  server.use(http.post('/api/admin/invites', () => HttpResponse.json({ code: 'ABCD234567', expiresAt: new Date().toISOString() }, { status: 201 })));
  const router = createMemoryRouter(routes, { initialEntries: ['/admin/members'] });
  renderWithProviders(<RouterProvider router={router} />);
  expect(await screen.findByText('Alice')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '生成邀请码' }));
  expect(await screen.findByText('ABCD234567')).toBeInTheDocument();
});
it('redirects members away from the admin page', async () => {
  server.use(http.get('/api/auth/me', () => HttpResponse.json({ id: 'u2', username: 'bob', displayName: 'Bob', role: 'member' })));
  const router = createMemoryRouter(routes, { initialEntries: ['/admin/members'] });
  renderWithProviders(<RouterProvider router={router} />);
  await waitFor(() => expect(router.state.location.pathname).toBe('/'));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bookr/web test -- src/features/admin`
Expected: FAIL — page missing.

- [ ] **Step 3: Implement admin UI**

`MembersPage` fetches members, invites and storage overview; renders a table with used/total bytes formatted by `lib/format.ts` (`formatBytes`). Toggling `isActive` calls `PATCH /api/admin/members/:id` and refetches. The quota field saves on blur with validation (positive integer). Reset password opens a `Dialog` with a new-password field and a confirmation warning that all devices will be signed out.

`InviteDialog` calls `POST /api/admin/invites` with `expiresInHours` (default 72) and displays the code in a monospace block with a copy button; the invite list below shows expired/used/revoked states and a revoke action.

The route guard reads `useAuth()`: while loading show a skeleton; members are redirected to `/`; admins render the page. The nav link is rendered only for admins.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @bookr/web test -- src/features/admin`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api/admin.ts apps/web/src/features/admin apps/web/src/app
git commit -m "feat(web): add admin member, invite and storage views"
```

---

### Task 14: Upload dialog with progress, dedupe and quota feedback

**Files:**
- Create: `apps/web/src/lib/upload.ts`, `apps/web/src/lib/hash-worker.ts`
- Create: `apps/web/src/features/bookshelf/UploadDialog.tsx`
- Modify: `apps/web/src/features/bookshelf/BookshelfPage.tsx` (open the dialog)
- Test: `apps/web/src/lib/__tests__/upload.test.ts`, `apps/web/src/features/bookshelf/__tests__/upload-dialog.test.tsx`

**Interfaces:**
- Produces: `hashFile(file: File): Promise<string>` — incremental SHA-256 in a Web Worker using `hash-wasm`.
- Produces: `putWithProgress(url: string, file: File, onProgress: (percent: number) => void): Promise<void>` — XHR PUT to the presigned URL.
- Produces: `uploadBook(file: File, deps?: UploadDeps): Promise<BookDto>`; throws `DuplicateBookError(existingBookId)`, `QuotaExceededError`, `InvalidFileError`.
- Produces: `UploadDialog` showing filename, progress bar, cancel, and error states.
- Limit: files over 500 MiB are rejected before hashing with "单本上限 500 MB".

- [ ] **Step 1: Write the failing tests**

`apps/web/src/lib/__tests__/upload.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { uploadBook, QuotaExceededError, DuplicateBookError } from '../upload';

const file = new File(['%PDF-1.7'], 'a.pdf', { type: 'application/pdf' });
const deps = (overrides = {}) => ({
  hash: vi.fn(async () => 'a'.repeat(64)),
  create: vi.fn(async () => ({ uploadId: 'u1', putUrl: 'http://minio/u1', expiresAt: new Date().toISOString() })),
  put: vi.fn(async (_url: string, _file: File, onProgress: (n: number) => void) => { onProgress(100); }),
  complete: vi.fn(async () => ({ book: { id: 'b1', title: 'a' } })),
  ...overrides,
});
it('hashes, uploads and completes in order', async () => {
  const d = deps();
  const progress: number[] = [];
  const book = await uploadBook(file, { ...d, onProgress: (n) => progress.push(n) });
  expect(book.id).toBe('b1');
  expect(d.create).toHaveBeenCalledWith(expect.objectContaining({ filename: 'a.pdf', sha256: 'a'.repeat(64) }));
  expect(progress.at(-1)).toBe(100);
});
it('surfaces duplicate uploads with the existing book id', async () => {
  const d = deps({ create: vi.fn(async () => { throw new DuplicateBookError('existing-1'); }) });
  await expect(uploadBook(file, d)).rejects.toMatchObject({ existingBookId: 'existing-1' });
});
it('surfaces quota errors without calling PUT', async () => {
  const d = deps({ create: vi.fn(async () => { throw new QuotaExceededError(); }) });
  await expect(uploadBook(file, d)).rejects.toBeInstanceOf(QuotaExceededError);
  expect(d.put).not.toHaveBeenCalled();
});
```

`apps/web/src/features/bookshelf/__tests__/upload-dialog.test.tsx`:
```tsx
it('shows the duplicate message with a link to the existing book', async () => {
  renderDialog({ rejectWith: new DuplicateBookError('b1') });
  await userEvent.upload(screen.getByLabelText('选择文件'), file);
  expect(await screen.findByText('这本书已经在书架里了')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '查看已有图书' })).toHaveAttribute('href', '/books/b1');
});
it('shows a quota message when the shelf is full', async () => {
  renderDialog({ rejectWith: new QuotaExceededError() });
  await userEvent.upload(screen.getByLabelText('选择文件'), file);
  expect(await screen.findByText('共享书库空间不足，请联系管理员')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bookr/web test -- src/lib`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement upload pipeline and dialog**

Add `hash-wasm` to web dependencies. `hash-worker.ts` imports `createSHA256` from `hash-wasm`, reads the file in 4 MiB chunks via `file.slice().arrayBuffer()`, calls `update`, and posts the hex digest back. `hashFile` wraps it in a Promise and falls back to `crypto.subtle.digest` only for files under 32 MiB.

`putWithProgress` uses `XMLHttpRequest`, sets `Content-Type` from the file, listens to `upload.onprogress`, and rejects on non-2xx or network error.

`uploadBook` rejects files over `MAX_UPLOAD_BYTES` with `InvalidFileError`, computes sha256, calls `POST /api/uploads`, PUTs to `putUrl`, then `POST /api/uploads/:id/complete`. Map API error codes: `DUPLICATE_BOOK` → `DuplicateBookError(details.existingBookId)`, `QUOTA_EXCEEDED` → `QuotaExceededError`, `INVALID_FILE` → `InvalidFileError`.

`UploadDialog`: drag-and-drop zone + file picker, per-file queue (max 3 concurrent), progress bars, cancel via `AbortController`, and a summary. On success it shows the toast `上传完成` and closes the dialog. Duplicate error shows "这本书已经在书架里了" with a "查看已有图书" action; quota error shows "共享书库空间不足，请联系管理员".

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @bookr/web test -- src/lib src/features/bookshelf/__tests__/upload-dialog.test.tsx`
Expected: PASS — 3 upload tests + 2 dialog tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib apps/web/src/features/bookshelf apps/web/package.json
git commit -m "feat(web): add resumable-friendly upload dialog with progress and dedupe"
```

---

### Task 15: Docker Compose deployment and backup scripts

**Files:**
- Create: `apps/server/Dockerfile`, `apps/web/Dockerfile`
- Create: `docker-compose.yml`, `Caddyfile`, `.env.example`
- Create: `scripts/backup-export.sh`, `scripts/pull-backup.sh`
- Create: `README.md` (runbook)
- Modify: `apps/server/src/server.ts` to run the worker in-process

**Interfaces:**
- Compose services: `postgres`, `minio`, `server`, `web` (Caddy), with named volumes `pgdata`, `miniodata`, `caddy_data`.
- `web` serves the SPA on port 8080 in dev compose and proxies `/api/*` and `/healthz` to `server:3000`.
- Server env: `DATABASE_URL`, `S3_*`, `JWT_SECRET`, `LIBRARY_QUOTA_BYTES`, `MEMBER_UPLOAD_QUOTA_BYTES`, `CORS_ORIGIN`.

- [ ] **Step 1: Write the failing verification**

Run: `docker compose config`
Expected: FAIL — `docker-compose.yml` not found.

- [ ] **Step 2: Implement images and compose**

`apps/server/Dockerfile`: `node:22-bookworm-slim`, install `calibre` and `ca-certificates`, enable corepack, copy workspace manifests, `pnpm install --frozen-lockfile`, build shared + server, prune dev dependencies, run `node dist/server.js` as a non-root user. Expose 3000. Healthcheck `node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1))"`.

`apps/web/Dockerfile`: build the SPA with pnpm, copy `dist` and `Caddyfile` into `caddy:2-alpine`. Caddy serves static files with SPA fallback and `reverse_proxy /api/* server:3000`, `reverse_proxy /healthz server:3000`.

`docker-compose.yml`: Postgres 16-alpine with `POSTGRES_USER=bookr`, `POSTGRES_PASSWORD` from env, healthcheck `pg_isready`; MinIO with `minio server /data --console-address :9001` and healthcheck; server `depends_on` both healthy, runs migrations on start; web depends on server. Restart `unless-stopped`.

`server.ts` runs `migrate(db)` before listening (exit non-zero on failure), then starts the job worker (`startWorker(deps)` every 5 seconds) and a daily cleanup interval for expired upload sessions and 30-day trash purge.

`.env.example` lists every variable with safe example values and comments (no real secrets).

- [ ] **Step 3: Add backup scripts and runbook**

`scripts/backup-export.sh` (runs on the server via cron): nightly `pg_dump` gzip into `/srv/bookr/backups/db/`, keep 30 days; run `mc alias set local http://minio:9000 "$S3_ACCESS_KEY" "$S3_SECRET_KEY"` then `mc mirror --overwrite local/bookr /srv/bookr/backups/minio/`, keep a timestamped manifest.

`scripts/pull-backup.sh` (runs on the 5080 backup PC, WSL/Task Scheduler): `rsync -az --delete-after` the remote backup directory to `~/bookr-backups/`, then `restic backup --tag bookr` with 30-day retention. Exit non-zero on any failure so monitoring can alert.

Runbook covers: first start, admin creation, invite creation, upgrade (backup → pull images → migrate), restore (stop server → `pg_restore` → restore MinIO → start), disk thresholds, certificate/domain setup.

- [ ] **Step 4: Verify the stack**

```bash
cp .env.example .env   # fill in secrets
docker compose up -d --build
curl -fsS http://localhost:8080/healthz
docker compose exec -e ADMIN_USERNAME=admin -e ADMIN_PASSWORD='change-me-now' server node dist/cli/create-admin.js
```

Expected: `/healthz` returns `{"status":"ok"}`; the CLI prints the admin user id; `docker compose ps` shows all services healthy.

- [ ] **Step 5: Commit**

```bash
git add apps/server/Dockerfile apps/web/Dockerfile docker-compose.yml Caddyfile .env.example scripts README.md
git commit -m "chore: add Docker Compose deployment, migrations and backup scripts"
```

---

### Task 16: End-to-end acceptance on the deployed stack

**Files:**
- Create: `apps/web/playwright.config.ts`, `apps/web/e2e/global-setup.ts`, `apps/web/e2e/bookshelf.spec.ts`, `apps/web/e2e/fixtures/sample.pdf`
- Modify: `apps/web/package.json` scripts `e2e`

**Interfaces:**
- Global setup: ensures an admin exists by running `docker compose exec -e ADMIN_USERNAME=e2e-admin -e ADMIN_PASSWORD=e2e-admin-password server node dist/cli/create-admin.js`; ignores a "user already exists" failure.
- Base URL: `http://localhost:8080` (override with `E2E_BASE_URL`).

- [ ] **Step 1: Write the failing test**

`apps/web/e2e/bookshelf.spec.ts`:
```ts
import { test, expect } from '@playwright/test';

test('invite, register, upload, edit, filter, delete and restore', async ({ page, request }) => {
  const login = await request.post('/api/auth/login', { data: { username: 'e2e-admin', password: 'e2e-admin-password' } });
  const adminToken = (await login.json()).accessToken;
  const invite = await request.post('/api/admin/invites', { headers: { authorization: `Bearer ${adminToken}` }, data: { expiresInHours: 1 } });
  const code = (await invite.json()).code;

  await page.goto('/register');
  await page.getByLabel('邀请码').fill(code);
  await page.getByLabel('用户名').fill('e2e-reader');
  await page.getByLabel('密码').fill('e2e-reader-password');
  await page.getByRole('button', { name: '注册' }).click();
  await expect(page).toHaveURL('/');

  await page.getByRole('button', { name: '上传图书' }).click();
  await page.setInputFiles('input[type=file]', 'e2e/fixtures/sample.pdf');
  await expect(page.getByText('上传完成')).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: '编辑《sample》' }).click();
  await page.getByLabel('书名').fill('端到端测试书');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('端到端测试书')).toBeVisible();

  await page.getByLabel('格式').selectOption('pdf');
  await expect(page.getByText('端到端测试书')).toBeVisible();
  await page.getByLabel('格式').selectOption('epub');
  await expect(page.getByText('端到端测试书')).toBeHidden();

  await page.getByLabel('格式').selectOption('');
  await page.getByRole('button', { name: '删除《端到端测试书》' }).click();
  await page.getByRole('button', { name: '确认删除' }).click();
  await expect(page.getByText('已移入回收站')).toBeVisible();
  await page.goto('/trash');
  await page.getByRole('button', { name: '恢复《端到端测试书》' }).click();
  await page.goto('/');
  await expect(page.getByText('端到端测试书')).toBeVisible();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `docker compose up -d --build && pnpm --filter @bookr/web e2e`
Expected: FAIL — Playwright config missing.

- [ ] **Step 3: Implement Playwright config and setup**

Copy `apps/server/test/fixtures/sample.pdf` to `apps/web/e2e/fixtures/sample.pdf` and commit it. `playwright.config.ts`: `testDir: './e2e'`, `use: { baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080' }`, `globalSetup: './e2e/global-setup.ts'`, retries 1, trace on first retry. `global-setup.ts` runs the docker exec command with `execSync(..., { cwd: path.resolve(__dirname, '../../..') })` (repo root) and tolerates exit codes caused by an existing admin.

- [ ] **Step 4: Run the end-to-end test**

Run: `docker compose up -d --build && pnpm --filter @bookr/web e2e`
Expected: PASS — 1 test, all steps green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/playwright.config.ts apps/web/e2e apps/web/package.json
git commit -m "test(e2e): cover invite registration, upload, edit, filter and trash"
```

---

## Test Helper Contract (cumulative)

All server helpers live in `apps/server/test/helpers.ts`.

- `buildTestDeps(overrides?: Partial<AppConfig>): Promise<AppDeps>` — the same object is used by the app and background jobs.
- `buildTestApp(overrides?: Partial<AppConfig>): Promise<FastifyInstance>`.
- `resetDb(): Promise<void>` — runs migrations once, then truncates all tables.
- `testDb` — Drizzle client against `DATABASE_URL`.
- `seedUser(role: Role, username?: string)` → `{ id, username, password: 'valid-password-1' }`.
- `seedBook(input: Partial<NewBook> & { uploadedBy: string }): Promise<BookRow>`.
- `authHeader(user): { authorization: string }`.
- `loginAs(app, user): Promise<AuthTokens>`.
- `createInvite(app): Promise<string>`.
- `setUserInactive(app, username): Promise<void>`.
- `fakeStorage` — `FakeStorage` instance shared by the app and jobs.
- `enqueuedJobs(): Job[]`.
- `findSessionObjectKey(uploadId): Promise<string>`.
- `expireSession(uploadId, msAgo): Promise<void>`.
- `cleanupExpiredUploadsForTest(): Promise<number>`.
- `runMetadataJobForTest(bookId): Promise<void>`.
- `fakeConverter` — `FakeConverter` with settable `onConvert`.
- `getBookRow(id): Promise<BookRow | undefined>`.
- `cleanupTrashForTest(): Promise<number>`.

Web helpers live in `apps/web/test/setup.ts`: `server` (MSW server with default handlers) and `renderWithProviders(ui, { route })`.

---

## Plan 1 Coverage Check

| 设计章节 | 覆盖任务 |
|---|---|
| 5.1 账号与圈子 | 6, 11, 12, 13b |
| 5.2 书架与图书导入（除阅读） | 7, 8, 9a, 9b, 10, 13, 14（含封面上传与回收站） |
| 5.8 管理后台（成员/邀请/存储） | 11, 13b |
| 5.9 离线策略 | 不在本计划（计划 4） |
| 6.1–6.5 架构 | 1–4, 12, 15 |
| 7 数据模型（books/categories/users/invites） | 4 |
| 10 P0/P1 | 全部任务 |
| 11 部署与备份 | 15 |
| 12 安全与隐私 | 3, 5, 6, 8, 11 |
| 13 验收 #1（打开）、#10（共享书架） | 1–16；打开速度由计划 2 验收 |

本计划不覆盖：阅读器、笔记、同步、AI、统计、笔记库、管理后台的备份状态页面（计划 8）。
