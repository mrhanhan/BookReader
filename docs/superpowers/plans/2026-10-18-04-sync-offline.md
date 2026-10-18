# 同步与离线（P4）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让阅读进度、划线/批注、书签与阅读设置在多设备间同步：批注/书签近实时推送，进度在打开书籍时对齐，并在断网时仍可阅读最近 5 本书、记笔记，联网后无丢失地合并。

**Architecture:** 本地优先。客户端所有写操作先落 IndexedDB（Dexie）并入 outbox，再由同步引擎批量推送；服务端为每个用户维护单调递增的 `sync_changes` 变更日志，客户端凭游标增量拉取，同时在线的设备通过 SSE 在 5 秒内收到变更。冲突按实体类型处理：进度/书签/设置为「客户端更新时间 + 服务端接收顺序」的 LWW，批注逐条合并且文字冲突保留旧版到 `annotation_history`。离线缓存用 OPFS（不可用时退化为 IndexedDB）保存原书文件与重排包，保留最近 5 本 + 手动固定，其余 LRU 淘汰。

**Tech Stack:** TypeScript strict、Fastify 5、PostgreSQL 16 + Drizzle、SSE（Fastify `reply.hijack`）、`jose` JWT、React 19、Dexie 4、TanStack Query、Vitest/jsdom + `fake-indexeddb`、Playwright。

**Spec:** `docs/superpowers/specs/2026-10-18-private-book-reader-design.md`（5.7 同步、5.9 离线策略、13 验收标准 3 与 11）

## Global Constraints

- TypeScript strict，禁止 `any`；共享契约先于使用方（`packages/shared` → `apps/server` / `apps/web`）。
- 服务端所有数据按 `user_id` 隔离；同步日志、快照、SSE 只能看到调用者自己的变更。
- 大文件不经过应用服务器：离线缓存由浏览器直接从预签名 URL 下载。
- 时间统一用 UTC ISO-8601；`z.iso.datetime()` 只接受 `Z` 结尾。
- 客户端时间超前服务端 5 分钟以上时，以服务端接收时间兜底并标记 `clockSkew`。
- 删除一律留墓碑（`deleted_at`），墓碑与变更日志保留 90 天。
- 不新增对外暴露端口；服务端仍只能经 Caddy 访问。
- E2E 是破坏性测试：只允许 localhost；`E2E_ALLOW_REMOTE=1` 仅用于一次性测试环境，永不对生产运行。
- 日志不得记录书籍正文、笔记文字或同步 payload 内容。
- 每个任务结束必须 `pnpm exec turbo run typecheck test` 通过并提交。
- 新增依赖仅限：`dexie`、`dexie-react-hooks`（web dependencies），`fake-indexeddb`（web devDependencies）。服务端不新增依赖。

## Review Focus

- **离线写入不被缓存清理波及**：清理离线书只删文件缓存，绝不删 `outbox`/`annotations`/`bookmarks`/`progress`；测试必须清缓存后断言待同步条目仍在。
- **同一实体并发编辑**：两台设备先后改同一条批注文字，最终两端一致，旧文字出现在 `annotation_history`，任何一版都不静默消失。
- **推送幂等**：同一批变更重复推送两次，服务端不产生重复行、不重复写日志、`revision` 不因重放跳变。
- **SSE 断线补齐**：断开期间产生的变更在重连后按游标补齐，不重不漏（用 `Last-Event-ID`/`since`）。
- **离线打开**：断网时最近读过的书能打开并翻页/划线；未缓存的书写明不可用而不是白屏。

---

## 文件结构

**共享**
- 创建 `packages/shared/src/sync.ts`、`packages/shared/src/__tests__/sync-schemas.test.ts`

**服务端**
- 创建 `apps/server/src/sync/{repo,apply,service,hub,tokens,routes}.ts`
- 创建 `apps/server/src/devices/{routes,service}.ts`
- 创建 `apps/server/test/{sync-push,sync-pull,sync-stream,sync-devices}.test.ts`
- 修改 `apps/server/src/db/schema.ts`、`drizzle/0004_sync.sql`、`drizzle/meta/*`
- 修改 `apps/server/src/reading/{progress,annotations,bookmarks,repo}.ts`（记录变更）
- 修改 `apps/server/src/{app,runtime,startup}.ts`、`auth/tokens.ts`
- 创建 `apps/server/test/helpers/sync.ts`（共享测试工具）

**Web**
- 创建 `apps/web/src/sync/{db,types,repository,outbox,engine}.ts`、`SyncProvider.tsx`、`useSyncStatus.ts`
- 创建 `apps/web/src/sync/__tests__/*`
- 创建 `apps/web/src/offline/{fileStore,cacheManager}.ts` 与测试
- 创建 `apps/web/src/features/settings/SettingsPage.tsx`
- 修改 `apps/web/src/api/{sync,devices,reading}.ts`、`app/{providers,router,AppLayout}.tsx`
- 修改 `apps/web/src/features/reader/{ReaderPage,useReaderProgress,progressStore}.ts(x)`
- 修改 `apps/web/src/features/bookshelf/{BookCard,BookshelfPage}.tsx`

**文档**
- 修改 `README.md`、`docs/superpowers/plans/2026-10-18-00-roadmap.md`

---

### Task 1: 共享同步契约

**Files:**
- Create: `packages/shared/src/sync.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/sync-schemas.test.ts`

**Interfaces:**
- Consumes: `locatorSchema`/`Locator`（`./locators`）、`ANNOTATION_COLORS`、`MAX_TAGS`、`MAX_TAG_LENGTH`（`./schemas/reading`）
- Produces（后续任务逐字使用）:

```ts
export const SYNC_ENTITY_TYPES = ['reading_progress', 'annotation', 'bookmark', 'reader_settings'] as const;
export type SyncEntityType = (typeof SYNC_ENTITY_TYPES)[number];
export const SYNC_OPS = ['upsert', 'delete'] as const;
export type SyncOp = (typeof SYNC_OPS)[number];

export const SYNC_PUSH_MAX_CHANGES = 100;
export const SYNC_PULL_DEFAULT_LIMIT = 200;
export const SYNC_PULL_MAX_LIMIT = 500;
export const SYNC_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const SYNC_RETENTION_DAYS = 90;
export const SYNC_SETTINGS_MAX_BYTES = 16 * 1024;

export type SyncRejectReason =
  | 'not_allowed' | 'unknown_entity' | 'invalid_payload' | 'unsupported_op';

export interface SyncPushChange {
  entityType: SyncEntityType;
  entityId: string;
  op: SyncOp;
  clientUpdatedAt: string;
  payload?: unknown;
}

export interface SyncChangeEnvelope {
  revision: number;
  entityType: SyncEntityType;
  entityId: string;
  op: SyncOp;
  payload: unknown;
  clientUpdatedAt: string;
  serverUpdatedAt: string;
}

export interface SyncPushResult {
  applied: SyncChangeEnvelope[];
  skipped: string[];
  rejected: Array<{ key: string; reason: SyncRejectReason }>;
  cursor: number;
}

export interface SyncPullResult {
  changes: SyncChangeEnvelope[];
  cursor: number;
  hasMore: boolean;
  reset: boolean;
}

export interface SyncSnapshot {
  cursor: number;
  progress: unknown[];
  annotations: unknown[];
  bookmarks: unknown[];
  settings: unknown | null;
}

export function syncKey(entityType: SyncEntityType, entityId: string): string;

export const syncPushChangeSchema;
export const syncPushRequestSchema;
export const syncPullQuerySchema;
export const syncStreamQuerySchema;
export const syncProgressPayloadSchema;
export const syncAnnotationPayloadSchema;
export const syncBookmarkPayloadSchema;
export const syncSettingsPayloadSchema;
export function syncPayloadSchemaFor(entityType: SyncEntityType);
```

- `syncPushRequestSchema = z.object({ changes: z.array(syncPushChangeSchema).min(1).max(SYNC_PUSH_MAX_CHANGES) })`。
- `syncPushChangeSchema`：`entityId: z.string().min(1).max(64)`、`clientUpdatedAt: z.iso.datetime()`、`payload: z.unknown().optional()`。
- `syncPullQuerySchema`：`since` 为非负整数、默认 0；`limit` 为 1..500、默认 200（输入是字符串时用 `z.coerce.number()` 后再 `int()`）。
- `syncStreamQuerySchema`：`{ token: z.string().min(1), since: 非负整数默认 0 }`。
- 负载 schema：
  - `syncProgressPayloadSchema = { bookId: z.uuid(), locator: locatorSchema }`
  - `syncAnnotationPayloadSchema = { bookId: z.uuid(), type: enum(highlight|note), color: enum(ANNOTATION_COLORS), locator, selectedText: 1..10000, noteText: null|1..10000, tags: 数组 ≤20、每项 ≤30 }`，`type === 'note'` 时 `noteText` 必须非空（`superRefine`）。
  - `syncBookmarkPayloadSchema = { bookId: z.uuid(), locator, label: null|≤200 }`
  - `syncSettingsPayloadSchema = { settings: z.record(z.string(), z.unknown()) }`，`Reflect` 普通对象 + `JSON.stringify(payload).length <= SYNC_SETTINGS_MAX_BYTES`（超限 `custom` issue）。
- `syncPayloadSchemaFor` 返回上述 schema；未知类型抛 `Error('Unknown sync entity type')`。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest';
import {
  SYNC_PUSH_MAX_CHANGES,
  syncAnnotationPayloadSchema,
  syncKey,
  syncProgressPayloadSchema,
  syncPullQuerySchema,
  syncPushRequestSchema,
  syncSettingsPayloadSchema,
} from '../sync';

const BOOK = '01a14f19-c2e6-73c7-a934-733f788451cf';
const ISO = '2026-10-18T08:00:00.000Z';
const change = (over: Record<string, unknown> = {}) => ({
  entityType: 'reading_progress',
  entityId: BOOK,
  op: 'upsert',
  clientUpdatedAt: ISO,
  payload: { bookId: BOOK, locator: { kind: 'pdf', page: 12, percent: 0.4 } },
  ...over,
});

describe('sync contract', () => {
  it('builds stable keys', () => {
    expect(syncKey('annotation', 'abc')).toBe('annotation:abc');
  });
  it('accepts a well-formed push request', () => {
    expect(syncPushRequestSchema.safeParse({ changes: [change()] }).success).toBe(true);
  });
  it('rejects more than the batch limit', () => {
    const changes = Array.from({ length: SYNC_PUSH_MAX_CHANGES + 1 }, () => change());
    expect(syncPushRequestSchema.safeParse({ changes }).success).toBe(false);
  });
  it('rejects non-UTC client times', () => {
    expect(syncPushRequestSchema.safeParse({
      changes: [change({ clientUpdatedAt: '2026-10-18T08:00:00.000+00:00' })],
    }).success).toBe(false);
  });
  it('validates the progress locator kind', () => {
    expect(syncProgressPayloadSchema.safeParse({ bookId: BOOK, locator: { kind: 'nope' } }).success).toBe(false);
  });
  it('requires a note body for note annotations', () => {
    const base = { bookId: BOOK, color: 'yellow', locator: { kind: 'pdf', page: 1, percent: 0 }, selectedText: 'x', tags: [] };
    expect(syncAnnotationPayloadSchema.safeParse({ ...base, type: 'note', noteText: null }).success).toBe(false);
    expect(syncAnnotationPayloadSchema.safeParse({ ...base, type: 'highlight', noteText: null }).success).toBe(true);
  });
  it('caps settings payloads at 16 KiB', () => {
    expect(syncSettingsPayloadSchema.safeParse({ settings: { big: 'x'.repeat(17000) } }).success).toBe(false);
  });
  it('defaults and clamps the pull query', () => {
    expect(syncPullQuerySchema.parse({})).toEqual({ since: 0, limit: 200 });
    expect(syncPullQuerySchema.safeParse({ limit: 501 }).success).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @bookr/shared test`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `packages/shared/src/sync.ts` 并从 `index.ts` 导出**

复用既有常量，不重复字面量；批注/书签的 locator 校验与 DTO 一致。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @bookr/shared test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src/sync.ts packages/shared/src/index.ts packages/shared/src/__tests__/sync-schemas.test.ts
git commit -m "feat(shared): define the sync protocol contract"
```

---

### Task 2: 服务端同步存储（表、迁移、仓储）

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Create: `apps/server/drizzle/0004_sync.sql`（用 `pnpm --filter @bookr/server db:generate` 生成后再核对 SQL）
- Modify: `apps/server/src/reading/repo.ts`（复用事务类型）
- Create: `apps/server/src/sync/repo.ts`
- Test: `apps/server/test/sync-repo.test.ts`

**Interfaces:**
- Consumes: `SyncEntityType`、`SyncOp`、`SyncChangeEnvelope`（Task 1）
- Produces:

```ts
// db/schema.ts
export const syncChanges = pgTable('sync_changes', {
  revision: bigserial('revision', { mode: 'number' }).primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  entityType: text('entity_type').$type<SyncEntityType>().notNull(),
  entityId: text('entity_id').notNull(),
  op: text('op').$type<SyncOp>().notNull(),
  payload: jsonb('payload').$type<unknown>(),
  clientUpdatedAt: timestamp('client_updated_at', { withTimezone: true }).notNull(),
  serverUpdatedAt: timestamp('server_updated_at', { withTimezone: true }).notNull().defaultNow(),
  deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
}, (table) => [
  index('sync_changes_user_revision_idx').on(table.userId, table.revision),
  index('sync_changes_created_idx').on(table.createdAt),
]);

export const syncMeta = pgTable('sync_meta', {
  key: text('key').primaryKey(),
  value: bigint('value', { mode: 'number' }).notNull(),
});

export const userSettings = pgTable('user_settings', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  clientUpdatedAt: timestamp('client_updated_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
// reading_progress / annotations / bookmarks 各加一列：
clientUpdatedAt: timestamp('client_updated_at', { withTimezone: true }),

// db/client.ts（新增，reading/repo.ts 改为 `export type { Transaction as ReadingTransaction }`）
export type Transaction = PgTransaction<NodePgQueryResultHKT, Record<string, never>, ExtractTablesWithRelations<Record<string, never>>>;

// sync/repo.ts
export const PRUNED_THROUGH_KEY = 'pruned_through';
export interface AppendChangeInput {
  userId: string;
  entityType: SyncEntityType;
  entityId: string;
  op: SyncOp;
  payload: unknown;
  clientUpdatedAt: Date;
  serverUpdatedAt: Date;
  deviceId?: string | null;
}
export async function appendChange(tx: Transaction, input: AppendChangeInput): Promise<SyncChangeEnvelope>;
export async function listChanges(db: Database, userId: string, since: number, limit: number): Promise<{ rows: SyncChangeEnvelope[]; hasMore: boolean }>;
export async function maxRevision(db: Database, userId: string): Promise<number>;
export async function prunedThrough(db: Database): Promise<number>;
export async function markPrunedThrough(tx: Transaction, revision: number): Promise<void>;
export async function readUserSettings(db: Database, userId: string): Promise<{ payload: Record<string, unknown>; clientUpdatedAt: Date } | null>;
export async function upsertUserSettings(tx: Transaction, input: { userId: string; payload: Record<string, unknown>; clientUpdatedAt: Date; updatedAt: Date }): Promise<void>;
```

- 信封映射都在 `repo.ts` 内部：`serverUpdatedAt` 用 ISO 字符串，`payload` 原样返回。
- `listChanges` 取 `limit + 1` 行判断 `hasMore`，按 `revision asc`。
- `appendChange` 返回刚插入的行（`returning()`），`revision` 是 bigserial。
- `appendChange` 先执行 `pg_advisory_xact_lock(hashtext(userId))`（事务级、可重入），把同一用户的日志写入串行化，使 revision 按提交顺序对该用户可见；`maxRevision(db, userId)` 只统计该用户的日志。

- [ ] **Step 1: 写失败测试**（`apps/server/test/sync-repo.test.ts`，沿用现有 `test/helpers.ts` 的 `createTestApp`/DB 清理方式）

```ts
it('appends changes in revision order per user', async () => {
  const first = await appendChangeInTx({ userId, entityType: 'reading_progress', entityId: bookId, op: 'upsert', payload: { bookId, locator }, clientUpdatedAt: now, serverUpdatedAt: now });
  const second = await appendChangeInTx({ userId, entityType: 'annotation', entityId: annotationId, op: 'upsert', payload: {}, clientUpdatedAt: now, serverUpdatedAt: now });
  expect(second.revision).toBeGreaterThan(first.revision);
  const page = await listChanges(db, userId, 0, 10);
  expect(page.rows.map((r) => r.revision)).toEqual([first.revision, second.revision]);
  expect(page.hasMore).toBe(false);
});

it('paginates with hasMore', async () => {
  // insert 3, ask for limit 2
});

it('never returns another user\'s changes', async () => {
  // two users, listChanges(userA) excludes userB rows
});

it('reads and writes the pruned-through watermark', async () => {
  expect(await prunedThrough(db)).toBe(0);
  await markPrunedThroughInTx(42);
  expect(await prunedThrough(db)).toBe(42);
});

it('upserts user settings in place', async () => {
  // upsert twice, payload updated, single row
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @bookr/server test -- sync-repo`
Expected: FAIL

- [ ] **Step 3: 改 schema、生成迁移、实现 `sync/repo.ts`**

`drizzle.config.ts` 已按 schema 生成；生成后人工核对 `0004_sync.sql` 含三张新表、三个 `client_updated_at` 列与两个索引。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @bookr/server test -- sync-repo`
Expected: PASS

- [ ] **Step 5: 迁移测试库并跑全量服务端测试**

Run: `pnpm --filter @bookr/server db:test:reset && pnpm --filter @bookr/server test`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/db apps/server/src/sync/repo.ts apps/server/drizzle apps/server/test/sync-repo.test.ts
git commit -m "feat(server): store the per-user sync change log"
```

---

### Task 3: 普通阅读写入也进入变更日志

**Files:**
- Modify: `apps/server/src/reading/progress.ts`、`annotations.ts`、`bookmarks.ts`、`repo.ts`
- Create: `apps/server/src/sync/service.ts`（本任务只放 `recordChange` 与负载构造函数）
- Test: `apps/server/test/sync-recording.test.ts`

**Interfaces:**
- Consumes: `appendChange`（Task 2）、既有 `toProgressDto`/`toAnnotationDto`/`toBookmarkDto`
- Produces:

```ts
// sync/service.ts
export type SyncPayloadFor = { entityType: SyncEntityType; entityId: string; payload: unknown };
export function progressChangePayload(dto: ReadingProgressDto, clientUpdatedAt: Date): unknown;
export function annotationChangePayload(dto: AnnotationDto, clientUpdatedAt: Date): unknown;
export function bookmarkChangePayload(dto: BookmarkDto, clientUpdatedAt: Date): unknown;
export function settingsChangePayload(settings: Record<string, unknown>, clientUpdatedAt: Date, updatedAt: Date): unknown;
export async function recordChange(
  tx: Transaction,
  input: {
    userId: string;
    entityType: SyncEntityType;
    entityId: string;
    op: SyncOp;
    payload: unknown;
    clientUpdatedAt: Date;
    serverUpdatedAt: Date;
    deviceId?: string | null;
  },
): Promise<SyncChangeEnvelope>;
export async function pullChanges(deps: AppDeps, userId: string, since: number, limit: number): Promise<SyncPullResult>;
export async function buildSnapshot(deps: AppDeps, userId: string): Promise<SyncSnapshot>;
```

**负载口径（push 的写入字段 vs 日志里的完整对象）**：日志与 pull 返回的 payload 是完整对象——
- progress：`{ bookId, locator, percent, updatedAt: ISO, clientUpdatedAt: ISO }`
- annotation：`{ id, bookId, type, color, locator, selectedText, noteText, tags, revision, createdAt, updatedAt, clientUpdatedAt }`
- bookmark：`{ id, bookId, locator, label, createdAt, updatedAt, clientUpdatedAt }`
- settings：`{ settings, updatedAt, clientUpdatedAt }`

三个表在每次写入时同时更新 `client_updated_at`（普通 HTTP 写入取 `deps.clock.now()`，因为该请求本身就是一次客户端动作）。

**改动点：**
- `saveProgress`：包进 `deps.db.transaction`，`upsertProgress` 增加 `clientUpdatedAt` 入参，事务内 `recordChange`。
- `createAnnotation`：包进事务（insert + recordChange）。
- `updateAnnotation`：既有事务内，在返回前 `recordChange`（payload 用更新后的 DTO）。
- `deleteAnnotation`：既有事务内，软删后 `recordChange`，`op: 'delete'`，payload 为删除前的完整对象。
- `createBookmark` / `updateBookmark` / `deleteBookmark`：同上。

- [ ] **Step 1: 写失败测试**

```ts
it('records a canonical progress change on save', async () => {
  await saveProgress(deps, { id: userId, deviceId }, bookId, locator);
  const page = await listChanges(db, userId, 0, 10);
  expect(page.rows).toHaveLength(1);
  expect(page.rows[0]).toMatchObject({
    entityType: 'reading_progress',
    entityId: bookId,
    op: 'upsert',
    payload: { bookId, locator, percent: locator.percent },
  });
});

it('records create, update and delete for annotations', async () => {
  // create -> update -> delete, expect 3 rows, the delete payload carries the note text
});

it('records bookmarks and never records another user\'s rows', async () => { /* ... */ });
```

- [ ] **Step 2: 运行确认失败** — `pnpm --filter @bookr/server test -- sync-recording` → FAIL

- [ ] **Step 3: 实现**（保持既有 DTO 与 HTTP 行为不变；只在事务里追加日志）

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @bookr/server test -- sync-recording`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/reading apps/server/src/sync/service.ts apps/server/test/sync-recording.test.ts
git commit -m "feat(server): append reading writes to the sync log"
```

---

### Task 4: 拉取与快照端点

**Files:**
- Modify: `apps/server/src/sync/service.ts`（`pullChanges`、`buildSnapshot`）
- Create: `apps/server/src/sync/routes.ts`（本任务只注册 pull/snapshot）
- Modify: `apps/server/src/app.ts`（注册 sync 路由）
- Test: `apps/server/test/sync-pull.test.ts`

**Interfaces:**
- Produces：`GET /api/sync/pull?since&limit` → `SyncPullResult`；`GET /api/sync/snapshot` → `SyncSnapshot`

**行为：**
- `pullChanges`：返回本页最后一条变更的 `revision`（空页或 reset 时返回 `since`）；若 `since > 0 && since < prunedThrough(db)` → `{ changes: [], cursor: since, hasMore: false, reset: true }`；否则按 `revision asc` 读 `listChanges(since, limit)`。带 `hasMore` 的游标不能用全局最大 revision，否则会跳过本页之后的变更。
- `buildSnapshot`：`progress` 为该用户全部进度（按 `updatedAt desc`）、`annotations`/`bookmarks` 仅 `deleted_at is null`，`settings` 为 `readUserSettings` 的 payload 或 null，`cursor = max(maxRevision(db, userId), prunedThrough(db))`（用户日志头与全局清理水位的较大者，避免用户日志低于水位时反复 reset）。
- 两个端点都要求登录；只返回调用者自己的数据。

- [ ] **Step 1: 写失败测试**

```ts
it('pulls incrementally by cursor', async () => {
  // 3 changes; pull since 0 limit 2 -> 2 rows hasMore true cursor=r2
  // pull since r2 -> 1 row hasMore false
});
it('returns reset when the cursor predates the retention watermark', async () => {
  // markPrunedThrough(5); pull since 2 -> reset true, changes []
});
it('snapshots live entities only and includes the cursor', async () => {
  // soft-deleted annotation/bookmark excluded; settings included
});
it('does not leak another user\'s snapshot', async () => { /* ... */ });
it('rejects an unauthenticated pull', async () => { /* 401 */ });
```

- [ ] **Step 2: 运行确认失败** — `pnpm --filter @bookr/server test -- sync-pull` → FAIL

- [ ] **Step 3: 实现 `routes.ts` 与 `app.ts` 注册**

路由文件先导出 `registerSyncRoutes(app, deps)`，后续任务在同一文件追加 push/stream 路由。

- [ ] **Step 4: 运行确认通过** — `pnpm --filter @bookr/server test -- sync-pull` → PASS

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/sync apps/server/src/app.ts apps/server/test/sync-pull.test.ts
git commit -m "feat(server): pull and snapshot endpoints"
```

---

### Task 5: 推送端点与冲突策略

**Files:**
- Create: `apps/server/src/sync/apply.ts`
- Modify: `apps/server/src/sync/service.ts`（`applyPush`）、`routes.ts`（`POST /api/sync/push`）
- Modify: `apps/server/src/reading/repo.ts`（读取 `client_updated_at`、按 id 查找批注/书签）
- Test: `apps/server/test/sync-push.test.ts`

**Interfaces:**
- Consumes: Task 1 的 schema、Task 2 的仓储、Task 3 的负载构造、既有 `requireLiveBook`/`assertLocatorKind`
- Produces:

```ts
export interface ApplyResult {
  status: 'applied' | 'skipped' | 'rejected';
  change?: SyncChangeEnvelope;
  reason?: SyncRejectReason;
}
export function effectiveClientTime(clientUpdatedAt: Date, now: Date): { time: Date; clockSkew: boolean };
export async function applyChange(deps: AppDeps, actor: ReadingActor, incoming: SyncPushChange): Promise<ApplyResult>;
export async function applyPush(deps: AppDeps, actor: ReadingActor, changes: SyncPushChange[]): Promise<SyncPushResult>;
```

**统一规则：**
- `effectiveClientTime`：`client > now + SYNC_CLOCK_SKEW_MS` → 返回 `now`（`clockSkew: true`），否则原样。
- **幂等**：仅当 `incomingTime > storedTime` 时应用；`incomingTime < storedTime` 跳过；相等时比较 `stableJson(incomingPayload)` 与 `stableJson(storedPayload)`，相同则跳过，不同则应用（服务端接收顺序打破平局）。
- `stableJson`：对象键排序后 `JSON.stringify`，拒绝循环引用（payload 已由 zod 校验为 JSON 安全）。
- `op: 'delete'` 对 `reading_progress` 与 `reader_settings` 返回 `unsupported_op`。
- 未知 `entityType`（zod 已拦截，但防御性保留）→ `unknown_entity`。

**逐实体：**
- `reading_progress`：`entityId` 必须等于 `payload.bookId`（否则 `invalid_payload`）；书必须存在（否则 `unknown_entity`）；locator 必须匹配书的格式（否则 `invalid_payload`）。事务内 `upsertProgress`（`updatedAt = now`、`clientUpdatedAt = effective`）并追加日志。
- `annotation` upsert：既有行属于他人 → `not_allowed`；属于自己且更旧 → `skipped`；插入时用客户端 id，`revision = 1`；更新时若 `noteText` 变化，先 `insertAnnotationHistory(旧文字, deviceId)`，`revision += 1`；被软删过的行在更新的 upsert 下复活（`deletedAt = null`）。
- `annotation` delete：行不存在 → `skipped`；他人的 → `not_allowed`；已删 → `skipped`；否则软删并追加 `delete` 日志（payload 为删除前的完整对象）。
- `bookmark`：同批注（无历史）。
- `reader_settings`：LWW 覆盖 `user_settings` 行并追加日志。

**端点**：`POST /api/sync/push`，body `syncPushRequestSchema`；`deviceId` 取 `request.user.deviceId`。返回 `applied`（服务端权威对象）、`skipped`、`rejected`（`{ key, reason }`）、`cursor = 本批最后一条 applied 的 revision`（没有 applied 时为 0；这是回执，不是 pull 游标）。

- [ ] **Step 1: 写失败测试**

```ts
it('applies a progress upsert and returns the canonical envelope', async () => {
  const result = await push([change('reading_progress', bookId, { bookId, locator })]);
  expect(result.applied).toHaveLength(1);
  expect(result.applied[0].payload).toMatchObject({ bookId, percent: locator.percent });
});

it('is idempotent for a replayed batch', async () => {
  await push(batch); const again = await push(batch);
  expect(again.applied).toHaveLength(0);
  expect(again.skipped).toHaveLength(batch.length);
  // and the change log still has exactly batch.length rows
});

it('skips an older client timestamp', async () => {
  await push([annotationChange({ noteText: 'new', at: T2 })]);
  const stale = await push([annotationChange({ noteText: 'old', at: T1 })]);
  expect(stale.skipped).toHaveLength(1);
  // noteText remains 'new'
});

it('archives the replaced note text when a newer edit wins', async () => {
  // push note 'first', then 'second' at a later client time
  // annotation_history has 'first', annotation.noteText === 'second', revision 2
});

it('falls back to the receive time for a clock far in the future', async () => {
  const future = new Date(now.getTime() + 10 * 60 * 1000);
  // stored clientUpdatedAt <= now, not the future value
});

it('rejects writing another user\'s annotation id', async () => {
  // annotation owned by user B; push as A with same id -> not_allowed
});

it('propagates a delete as a tombstone', async () => {
  // delete -> list shows nothing, pull contains op delete, re-upsert with newer time resurrects
});

it('rejects a locator of the wrong kind for the book format', async () => { /* ... */ });
it('rejects more than 100 changes', async () => { /* 400 */ });
it('never logs another user\'s changes in the caller\'s cursor', async () => { /* ... */ });
```

- [ ] **Step 2: 运行确认失败** — `pnpm --filter @bookr/server test -- sync-push` → FAIL

- [ ] **Step 3: 实现 `apply.ts`、`applyPush`、路由**

- [ ] **Step 4: 运行确认通过** — `pnpm --filter @bookr/server test -- sync-push` → PASS

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/sync apps/server/src/reading/repo.ts apps/server/test/sync-push.test.ts
git commit -m "feat(server): idempotent sync push with conflict policies"
```

---

### Task 6: SSE 实时推送

**Files:**
- Modify: `apps/server/src/auth/tokens.ts`
- Create: `apps/server/src/sync/hub.ts`
- Modify: `apps/server/src/app.ts`、`runtime.ts`（注入 `syncHub`）
- Modify: `apps/server/src/sync/service.ts`、`routes.ts`、`reading/*.ts`（提交后发布）
- Test: `apps/server/test/sync-stream.test.ts`

**Interfaces:**
- Produces:

```ts
// auth/tokens.ts
export interface SyncStreamClaims { sub: string; deviceId?: string }
export async function signSyncStreamToken(claims: SyncStreamClaims, secret: string, ttlSeconds?: number): Promise<string>;
export async function verifySyncStreamToken(token: string, secret: string): Promise<SyncStreamClaims>;

// sync/hub.ts
export interface SyncHub {
  publish(userId: string, change: SyncChangeEnvelope): void;
  subscribe(userId: string, listener: (change: SyncChangeEnvelope) => void): () => void;
  subscriberCount(userId: string): number;
}
export function createSyncHub(): SyncHub;

// app.ts 的 AppDeps 增加
syncHub: SyncHub;
```

- stream token：HS256、同一 issuer/audience、`payload.typ = 'sync-stream'`、默认 60 秒；`verifySyncStreamToken` 校验 `typ`，access token 不能当 stream token 用。
- `POST /api/sync/stream-token`（需登录）→ `{ token, expiresIn: 60 }`。
- `GET /api/sync/stream?token=&since=`：
  - 校验 token（失败 401）；`reply.hijack()` 后 `writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' })`。
  - 先按 `pullChanges(userId, since, 200)` 分页补发历史（每页写完再取下一页）；`reset === true` 时发一条 `event: reset` 并结束补发。
  - 每条变更写 `id: <revision>\nevent: change\ndata: <json>\n\n`。
  - 订阅 hub；变更到达即写同一格式。
  - 每 25 秒写一次 `: ping\n\n`。
  - `request.raw.on('close')` 与写入错误都执行清理（取消订阅、清定时器）。
- 发布时机：`applyPush` 对每个 `applied` 变更、以及 `saveProgress`/`createAnnotation`/`updateAnnotation`/`deleteAnnotation`/`createBookmark`/`updateBookmark`/`deleteBookmark` 在**事务提交后**调用 `deps.syncHub.publish(userId, envelope)`。

- [ ] **Step 1: 写失败测试**（需要真实监听端口才能消费流）

```ts
async function startServer() {
  const { app, deps } = await createTestApp();
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, deps, url };
}

it('delivers a change to an open stream within two seconds', async () => {
  const { app, url } = await startServer();
  const token = (await app.inject({ method: 'POST', url: '/api/sync/stream-token', headers: auth })).json().token;
  const controller = new AbortController();
  const response = await fetch(`${url}/api/sync/stream?token=${token}&since=0`, { signal: controller.signal });
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader = response.body!.getReader();
  await pushProgress(app, auth, locator);
  const chunk = await readUntil(reader, 'event: change');
  expect(chunk).toContain('"entityType":"reading_progress"');
  controller.abort();
  await app.close();
});

it('replays the backlog from since', async () => { /* two changes, since=first -> only second arrives */ });
it('rejects a missing or forged token', async () => { /* 401 */ });
it('unsubscribes after the client disconnects', async () => {
  // poll deps.syncHub.subscriberCount(userId) until 0 (bounded)
});
it('does not deliver another user\'s changes', async () => { /* user B stream sees nothing */ });
```

- [ ] **Step 2: 运行确认失败** — `pnpm --filter @bookr/server test -- sync-stream` → FAIL

- [ ] **Step 3: 实现 token、hub、路由与发布点**

- [ ] **Step 4: 运行确认通过** — `pnpm --filter @bookr/server test -- sync-stream` → PASS

- [ ] **Step 5: 提交**

```bash
git add apps/server/src apps/server/test/sync-stream.test.ts
git commit -m "feat(server): push sync changes over SSE"
```

---

### Task 7: 保留期清理与设备管理

**Files:**
- Modify: `apps/server/src/startup.ts`、`apps/server/src/sync/service.ts`
- Create: `apps/server/src/devices/{service,routes}.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/test/sync-retention.test.ts`、`apps/server/test/sync-devices.test.ts`

**Interfaces:**
- Produces:

```ts
// sync/service.ts
export async function pruneSyncLog(deps: AppDeps): Promise<{ pruned: number; through: number }>;
export async function purgeDeletedEntities(deps: AppDeps): Promise<{ annotations: number; bookmarks: number }>;

// devices
export interface DeviceDto {
  id: string; name: string | null; platform: string | null;
  lastSeenAt: string | null; createdAt: string; current: boolean;
}
export async function listDevices(deps: AppDeps, userId: string, currentDeviceId?: string): Promise<DeviceDto[]>;
export async function renameDevice(deps: AppDeps, userId: string, deviceId: string, name: string | null): Promise<DeviceDto>;
export async function revokeDevice(deps: AppDeps, userId: string, deviceId: string, now: Date): Promise<void>;
```

- 清理：删除 `sync_changes.created_at < now - 90d`，把删除批次的最大 `revision` 写入 `sync_meta.pruned_through`（只增不减）；硬删 `annotations`/`bookmarks` 中 `deleted_at < now - 90d` 的行（`annotation_history` 随 cascade 删除）。
- `startDailyCleanup` 里追加这两个步骤（与现有 in-flight 守卫共用）。
- 端点：`GET /api/devices`、`PATCH /api/devices/:id`（body `{ name: string | null }`，trim 后 1..60 或 null）、`DELETE /api/devices/:id`（置 `revoked_at`）。三者都只作用于调用者自己的设备；他人的 id 返回 404。

- [ ] **Step 1: 写失败测试**

```ts
it('prunes the log past the retention window and advances the watermark', async () => {
  // insert an old change (created_at = now - 91d) and a new one
  // pruneSyncLog -> pruned 1, through = old.revision
  // pull since old.revision - 1 -> reset true
});
it('hard-deletes tombstones older than 90 days but keeps newer ones', async () => { /* ... */ });
it('lists only the caller\'s devices and marks the current one', async () => { /* ... */ });
it('renames and revokes a device', async () => { /* ... */ });
it('404s for another user\'s device', async () => { /* ... */ });
```

- [ ] **Step 2: 运行确认失败** — `pnpm --filter @bookr/server test -- sync-retention sync-devices` → FAIL

- [ ] **Step 3: 实现并在 `app.ts` 注册设备路由**

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @bookr/server test -- sync-retention sync-devices`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/server/src apps/server/test/sync-retention.test.ts apps/server/test/sync-devices.test.ts
git commit -m "feat(server): sync retention and device management"
```

---

### Task 8: 客户端本地库、仓储与 outbox

**Files:**
- Modify: `apps/web/package.json`（`dexie`、`dexie-react-hooks`、`fake-indexeddb`）
- Create: `apps/web/src/sync/{types,db,outbox,repository}.ts`
- Modify: `apps/web/test/setup.ts`（`import 'fake-indexeddb/auto'`）
- Test: `apps/web/src/sync/__tests__/{repository,outbox}.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `SyncEntityType`/`SyncOp`/`SyncPushChange`；`newId()`；`AnnotationDto`/`BookmarkDto`/`Locator`
- Produces:

```ts
// types.ts
export interface LocalProgressRow { userId: string; bookId: string; locator: Locator; percent: number; updatedAt: string; clientUpdatedAt: string; dirty: boolean }
export interface LocalAnnotationRow extends AnnotationDto { userId: string; clientUpdatedAt: string; dirty: boolean }
export interface LocalBookmarkRow extends BookmarkDto { userId: string; clientUpdatedAt: string; dirty: boolean }
export interface LocalSettingsRow { userId: string; settings: Record<string, unknown>; clientUpdatedAt: string; dirty: boolean }
export interface OutboxRow { id: string; userId: string; entityType: SyncEntityType; entityId: string; op: SyncOp; payload: unknown; clientUpdatedAt: string; attempts: number; nextAttemptAt: number }
export interface SyncMetaRow { key: string; value: unknown }
export interface OfflineBookRow { bookId: string; userId: string; pinned: boolean; lastReadAt: number; cachedAt: number; bytes: number }
export interface CachedShelfBook { id: string; userId: string; title: string; author: string | null; format: string; coverUrl: string | null; updatedAt: string }

// db.ts
export class BookrDb extends Dexie { /* 上述 8 张表，键类型见下 */ }
export function createSyncDb(name?: string): BookrDb;   // 默认 'bookr-sync'

// outbox.ts
export async function enqueue(db: BookrDb, change: Omit<OutboxRow, 'attempts' | 'nextAttemptAt'>): Promise<void>;
export async function dueOutbox(db: BookrDb, userId: string, now: number, limit: number): Promise<OutboxRow[]>;
export async function acknowledgeOutbox(db: BookrDb, ids: string[]): Promise<void>;
export async function dropOutboxFor(db: BookrDb, userId: string, entityType: SyncEntityType, entityId: string): Promise<void>;
```

```ts
// repository.ts
export interface LocalRepository {
  progressFor(userId: string, bookId: string): Promise<LocalProgressRow | null>;
  saveProgress(userId: string, bookId: string, locator: Locator, at?: number): Promise<LocalProgressRow>;
  listAnnotations(userId: string, bookId: string): Promise<LocalAnnotationRow[]>;
  createAnnotation(userId: string, input: { bookId: string; type: 'highlight' | 'note'; color: AnnotationColor; locator: Locator; selectedText: string; noteText: string | null; tags: string[] }): Promise<LocalAnnotationRow>;
  updateAnnotation(userId: string, bookId: string, id: string, patch: { color?: AnnotationColor; noteText?: string | null; tags?: string[] }): Promise<LocalAnnotationRow | null>;
  deleteAnnotation(userId: string, bookId: string, id: string): Promise<void>;
  listBookmarks(userId: string, bookId: string): Promise<LocalBookmarkRow[]>;
  createBookmark(userId: string, input: { bookId: string; locator: Locator; label: string | null }): Promise<LocalBookmarkRow>;
  updateBookmark(userId: string, bookId: string, id: string, label: string | null): Promise<LocalBookmarkRow | null>;
  deleteBookmark(userId: string, bookId: string, id: string): Promise<void>;
  settingsFor(userId: string): Promise<LocalSettingsRow | null>;
  saveSettings(userId: string, settings: Record<string, unknown>): Promise<void>;
  pendingCount(userId: string): Promise<number>;
  applyServerChange(userId: string, change: SyncChangeEnvelope): Promise<'applied' | 'skipped'>;
  applySnapshot(userId: string, snapshot: SyncSnapshot): Promise<void>;
  getCursor(userId: string): Promise<number>;
  setCursor(userId: string, cursor: number): Promise<void>;
  getLastSyncedAt(userId: string): Promise<number | null>;
  setLastSyncedAt(userId: string, at: number): Promise<void>;
}
export function createRepository(db: BookrDb): LocalRepository;
```

**Dexie 版本 1 的键与索引：**
`progress: '[userId+bookId], userId, bookId, updatedAt'`（Dexie 以声明中的第一项为主键，主键就是 `[userId+bookId]`；若把 `userId` 放前面会跨书覆盖进度）、
`annotations: 'id, userId, bookId, [userId+bookId], dirty'`、
`bookmarks: 'id, userId, bookId, [userId+bookId], dirty'`、
`settings: 'userId'`、`outbox: 'id, userId, [userId+nextAttemptAt]'`、`meta: 'key'`、
`offlineBooks: '[userId+bookId], userId, bookId, pinned, lastReadAt'`、`shelf: '[userId+id], userId, id'`。

缓存表在后续版本重键：Dexie 不能就地修改主键，因此版本 2/3 以删表重建把 `offlineBooks` 迁到 `[userId+bookId]`，版本 4/5 同样把 `shelf` 迁到 `[userId+id]`（缓存数据可重建，不会触碰 outbox 与阅读数据）。

**规则：**
- 每次本地写与 outbox 入队在同一个 `db.transaction('rw', ...)` 内完成；`clientUpdatedAt` 用 `new Date(at ?? Date.now()).toISOString()`，实体 id 用 `newId()`。
- outbox 的 `payload` 是 push 的写入字段（不含 id/createdAt）：批注 `{ bookId, type, color, locator, selectedText, noteText, tags }`、书签 `{ bookId, locator, label }`、进度 `{ bookId, locator }`、设置 `{ settings }`。
- `applyServerChange`：若该实体在 outbox 里还有未确认条目，比较 `clientUpdatedAt`：本地更新 → 返回 `'skipped'`（保留本地与 outbox）；服务器更新 → 覆盖本地并 `dropOutboxFor`。`op: 'delete'` 删除本地行并丢弃该实体的 outbox。
- `applySnapshot`：清空该用户四类实体后整体写入，`dirty: false`；**不得**清空 outbox。
- `pendingCount` 只统计该 `userId` 的 outbox 行。

- [ ] **Step 1: 写失败测试**

```ts
it('writes progress locally and enqueues one outbox row', async () => {
  const row = await repo.saveProgress(userId, bookId, locator);
  expect(row.percent).toBe(locator.percent);
  expect(await repo.pendingCount(userId)).toBe(1);
  const outbox = await db.outbox.where('userId').equals(userId).toArray();
  expect(outbox[0]).toMatchObject({ entityType: 'reading_progress', entityId: bookId, op: 'upsert' });
});
it('creates annotations with a UUIDv7 id and a writable payload', async () => { /* ... */ });
it('updates and deletes bookmarks, enqueuing each mutation', async () => { /* ... */ });
it('keeps local edits when a server change is older', async () => { /* local T2 vs server T1 -> skipped */ });
it('overwrites local rows and drops their outbox when the server is newer', async () => { /* local T1 vs server T2 -> pendingCount 0 */ });
it('applies a snapshot without clearing the outbox', async () => { /* ... */ });
it('isolates users', async () => { /* ... */ });
```

- [ ] **Step 2: 运行确认失败** — `pnpm --filter @bookr/web test -- sync/__tests__/repository` → FAIL

- [ ] **Step 3: 安装依赖并实现**

```bash
pnpm --filter @bookr/web add dexie dexie-react-hooks
pnpm --filter @bookr/web add -D fake-indexeddb
```

- [ ] **Step 4: 运行确认通过** — `pnpm --filter @bookr/web test -- sync/__tests__` → PASS

- [ ] **Step 5: 提交**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/src/sync apps/web/test/setup.ts
git commit -m "feat(web): local-first store with a sync outbox"
```

---

### Task 9: 同步引擎（推送、拉取、SSE、触发）

**Files:**
- Create: `apps/web/src/api/sync.ts`
- Create: `apps/web/src/sync/engine.ts`
- Test: `apps/web/src/sync/__tests__/engine.test.ts`

**Interfaces:**
- Produces:

```ts
// api/sync.ts
export interface SyncApi {
  push(changes: SyncPushChange[]): Promise<SyncPushResult>;
  pull(since: number, limit?: number): Promise<SyncPullResult>;
  snapshot(): Promise<SyncSnapshot>;
  streamToken(): Promise<{ token: string; expiresIn: number }>;
}
export function createSyncApi(): SyncApi;
export function syncStreamUrl(token: string, since: number): string;

// engine.ts
export type SyncStatus = 'synced' | 'syncing' | 'pending' | 'offline' | 'error';
export interface SyncState { status: SyncStatus; pending: number; lastSyncedAt: number | null; conflicts: number }
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  close(): void;
}
export interface SyncEngineOptions {
  userId: string;
  repo: LocalRepository;
  api: SyncApi;
  online?: () => boolean;
  now?: () => number;
  eventSourceFactory?: (url: string) => EventSourceLike;
  onChange?: (state: SyncState, event?: { type: 'applied' | 'conflict'; entityType: SyncEntityType }) => void;
}
export interface SyncEngine {
  start(): void;
  stop(): Promise<void>;
  syncNow(reason?: string): Promise<void>;
  getState(): SyncState;
  subscribe(listener: (state: SyncState) => void): () => void;
}
export function createSyncEngine(options: SyncEngineOptions): SyncEngine;
```

**行为：**
1. `syncNow` 单飞：已有运行中的同步时只排一次补跑；顺序 push → pull（循环到 `hasMore` false）。
2. push 取 `dueOutbox(userId, now, SYNC_PUSH_MAX_CHANGES)`；响应后 `applied` 用服务端信封覆盖本地并 `acknowledgeOutbox`；`skipped` 直接确认；`rejected` 也确认并把计数写入 `meta['syncErrors:<userId>']`。
3. pull：`since = repo.getCursor(userId)`；`reset` → `api.snapshot()` → `applySnapshot` → `setCursor(snapshot.cursor)`；否则逐条 `applyServerChange` 并推进游标，`hasMore` 时继续。
4. SSE：仅在 `online()` 且 `eventSourceFactory` 可得时建立；`token = api.streamToken()`；`message`/`change` 事件应用变更并推进游标；`reset` 事件走快照；`error` 关闭并按 1s/2s/5s/15s/30s 退避重连。
5. 触发：`start()` 立即同步；调用方在写操作后调 `syncNow('write')`（2s 防抖在 `SyncProvider`）；`online`、`visibilitychange`（visible）、60 秒心跳。
6. 状态：离线为 `offline`；进行中 `syncing`；`pending > 0` 为 `pending`；上次失败为 `error`；否则 `synced`。每次变化通知订阅者。
7. `stop()`：关闭 SSE、清定时器、等待进行中的同步结束（不抛错）。

- [ ] **Step 1: 写失败测试**（假 api + 假 EventSource + 可控时钟，不依赖 MSW）

```ts
it('pushes queued changes and clears the outbox', async () => { /* ... */ });
it('pulls to the end and advances the cursor', async () => { /* hasMore true then false */ });
it('rebuilds from a snapshot when the pull reports reset', async () => { /* ... */ });
it('applies a stream event and advances the cursor', async () => { /* fake EventSource emits */ });
it('reconnects with backoff after a stream error', async () => { /* fake timers */ });
it('reports offline without clearing pending changes', async () => { /* online = false */ });
it('runs one sync at a time and re-runs once when triggered mid-flight', async () => { /* ... */ });
it('drops rejected changes from the outbox and counts them', async () => { /* ... */ });
```

- [ ] **Step 2: 运行确认失败** — `pnpm --filter @bookr/web test -- sync/__tests__/engine` → FAIL

- [ ] **Step 3: 实现 `api/sync.ts` 与 `engine.ts`**

`apiFetch` 已处理鉴权与 401 刷新；SSE 不携带 Authorization 头，先用 `streamToken()` 取 60 秒短时 token。

- [ ] **Step 4: 运行确认通过** — `pnpm --filter @bookr/web test -- sync/__tests__/engine` → PASS

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/api/sync.ts apps/web/src/sync/engine.ts apps/web/src/sync/__tests__/engine.test.ts
git commit -m "feat(web): sync engine with push, pull and SSE"
```

---

### Task 10: SyncProvider、状态指示与路由

**Files:**
- Create: `apps/web/src/sync/SyncProvider.tsx`、`apps/web/src/sync/useSyncStatus.ts`、`apps/web/src/features/settings/SyncStatusBadge.tsx`
- Modify: `apps/web/src/app/providers.tsx`（`<SyncProvider>` 放在 `AuthProvider` 内侧）
- Modify: `apps/web/src/app/AppLayout.tsx`（页头徽标）、`apps/web/src/features/reader/ReaderChrome.tsx`（阅读页小徽标）
- Test: `apps/web/src/sync/__tests__/sync-provider.test.tsx`

**Interfaces:**
- Produces:

```ts
// SyncProvider.tsx
export interface SyncContextValue {
  repo: LocalRepository;
  state: SyncState;
  syncNow: (reason?: string) => Promise<void>;
}
export function SyncProvider(props: {
  children: ReactNode;
  /** 测试注入；生产默认为 createSyncDb/createRepository/createSyncEngine。 */
  createEngine?: (userId: string, repo: LocalRepository) => SyncEngine;
  createRepo?: () => LocalRepository;
}): JSX.Element;
export function useSync(): SyncContextValue;

// useSyncStatus.ts
export const SYNC_STATUS_LABELS: Record<SyncStatus, string>; // 已同步 / 同步中 / 离线待同步 / 同步失败 / 待同步
export function useSyncStatus(): SyncState;
export function syncStatusLabel(state: SyncState): string;   // 含待同步条数：`待同步 3 项`
```

**行为：**
- 登录用户变化时：停止旧引擎并清空上下文；新用户创建 `repo`/`engine` 并 `start()`；登出时 `stop()`。
- 引擎 `onChange`：`applied` 时按实体类型 `invalidateQueries`（`['annotations', bookId]` 不可知，直接 `invalidateQueries({ queryKey: ['annotations'] })` 与 `['bookmarks']`、`['progress']`、`['books']`）；`conflict` 时通过 `useToast`（若 ReaderPage 未挂载则忽略）——本任务只把冲突计数暴露在状态里，阅读页的提示在 Task 11 接。
- 写操作触发同步：提供 `requestSync()`，2 秒防抖后 `engine.syncNow('write')`。
- `SyncStatusBadge`：一个圆点 + 文案，带 `role="status"`、`aria-live="polite"`；离线用琥珀色、错误用红色、同步中用中性色。

- [ ] **Step 1: 写失败测试**

```tsx
it('renders 已同步 when there is nothing pending', async () => { /* fake engine state */ });
it('renders 离线待同步 with a pending count', async () => { /* state.status 'offline', pending 3 */ });
it('starts a new engine when the user changes and stops the old one', async () => { /* spy start/stop */ });
it('invalidates annotation queries when the engine reports an applied change', async () => { /* QueryClient spy */ });
```

- [ ] **Step 2: 运行确认失败** — `pnpm --filter @bookr/web test -- sync-provider` → FAIL

- [ ] **Step 3: 实现并接入 providers/layout/chrome**

- [ ] **Step 4: 运行确认通过** — `pnpm --filter @bookr/web test -- sync-provider` → PASS

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/sync apps/web/src/features/settings apps/web/src/app apps/web/src/features/reader/ReaderChrome.tsx
git commit -m "feat(web): sync provider and status indicator"
```

---

### Task 11: 阅读页改为本地优先

**Files:**
- Modify: `apps/web/src/features/reader/progressStore.ts`（改为 Dexie 支撑，保留导出名）
- Modify: `apps/web/src/features/reader/useReaderProgress.ts`
- Modify: `apps/web/src/features/reader/ReaderPage.tsx`
- Modify: `apps/web/src/api/reading.ts`（保留 HTTP 函数供 E2E/管理用途，但阅读页不再调用）
- Test: `apps/web/src/features/reader/__tests__/{reader-progress,reader-annotations,reader-offline}.test.tsx`

**Interfaces:**
- Consumes: `useSync().repo`（Task 10）、`LocalRepository`（Task 8）
- Produces: `readLocalProgress(userId, bookId): Promise<LocalProgress | null>`（签名由同步改为异步）；`writeLocalProgress` 改为 `void repo.saveProgress(...)` 的即发即忘包装。

**行为：**
- `useReaderProgress`：本地落库与 outbox 入队走 `repo.saveProgress`；不再直接调用 HTTP。25 秒/离页时只调用 `requestSync()`，由同步引擎推送；`saveState` 由 `sync` 状态推导（`saved`/`saving`/`error` 映射）。
- `ReaderPage`：
  - 进度、批注、书签的读取改走 `repo`；打开书籍时与统一 URL 获取并行。
  - 进度在**打开书籍时对齐一次**：在线最多等待首轮 pull 1.5 秒后再读本地位置，离线或超时直接使用本地记录；阅读过程中不跟随远端进度实时跳转。批注与书签仍随 SSE 实时更新。
  - 新建/编辑/删除批注与书签走 `repo`，成功后 `invalidateQueries` 并 `requestSync()`。
  - 进度与本地库不存在的旧 localStorage 数据：首次读取时迁移进 Dexie（`dirty: false`，不产生 outbox）。
  - 同步冲突：`reader` 挂载期间监听 `sync` 的 `conflict` 事件，`showToast('此批注已在另一台设备更新，旧版本已保留在历史中')`。
- 现有测试改为注入内存仓储（`apps/web/test/memory-repository.ts`，实现同一 `LocalRepository` 接口），不再用 MSW 模拟批注/书签/进度端点。

- [ ] **Step 1: 写失败测试**

```tsx
it('opens at the locally stored locator before any network call', async () => { /* repo seeded */ });
it('saves progress locally and queues it for sync without calling the HTTP endpoint', async () => { /* msw handler not hit */ });
it('shows annotations from the local repository while offline', async () => { /* ... */ });
it('shows a conflict toast when the sync engine reports one', async () => { /* ... */ });
it('migrates a legacy localStorage position once', async () => { /* ... */ });
```

- [ ] **Step 2: 运行确认失败** — `pnpm --filter @bookr/web test -- reader-progress reader-annotations reader-offline` → FAIL

- [ ] **Step 3: 实现并更新既有 reader 测试**

- [ ] **Step 4: 运行确认通过** — `pnpm --filter @bookr/web test` → PASS（全量 web）

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/features/reader apps/web/src/api/reading.ts apps/web/test
git commit -m "feat(web): read and write reading data through the local store"
```

---

### Task 12: 离线文件存储与 LRU 缓存管理

**Files:**
- Create: `apps/web/src/offline/fileStore.ts`、`apps/web/src/offline/cacheManager.ts`
- Test: `apps/web/src/offline/__tests__/{file-store,cache-manager}.test.ts`

**Interfaces:**
- Consumes: `BookrDb`/`OfflineBookRow`（Task 8）
- Produces:

```ts
export type CacheKind = 'book' | 'reflow';
export interface CachedFileStore {
  put(key: string, data: Blob): Promise<void>;
  get(key: string): Promise<Blob | null>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
  totalBytes(): Promise<number>;
  clear(): Promise<void>;
}
export function createOpfsStore(rootName?: string): CachedFileStore;      // 不可用时抛 Error
export function createIndexedDbStore(name?: string): CachedFileStore;
export function createMemoryStore(): CachedFileStore;
export async function createDefaultStore(): Promise<CachedFileStore>;     // OPFS → IDB → memory
export function cacheKey(userId: string, bookId: string, kind: CacheKind): string;

export const OFFLINE_RECENT_LIMIT = 5;
export interface CacheManager {
  cacheFromUrl(userId: string, bookId: string, kind: CacheKind, url: string): Promise<number>;
  cachedUrl(userId: string, bookId: string, kind: CacheKind): Promise<string | null>;
  touch(userId: string, bookId: string): Promise<void>;
  pin(userId: string, bookId: string): Promise<void>;
  unpin(userId: string, bookId: string): Promise<void>;
  isPinned(userId: string, bookId: string): Promise<boolean>;
  remove(userId: string, bookId: string): Promise<void>;
  enforceLru(userId: string, keepBookId?: string): Promise<string[]>;
  clearUnpinned(userId: string, keepBookId?: string): Promise<string[]>;
  usage(userId: string): Promise<{ bytes: number; books: OfflineBookRow[]; quota: number | null }>;
  revokeUrls(): void;
}
export function createCacheManager(deps: { store: CachedFileStore; db: BookrDb; now?: () => number; fetchImpl?: typeof fetch }): CacheManager;
```

**规则：**
- key 为 `${userId}/${bookId}/${kind}`；`offlineBooks` 行按 `[userId+bookId]` 记录 `bytes`（累加 book+reflow 大小）、`lastReadAt`、`pinned`、`cachedAt`。
- LRU：未固定且不是 `keepBookId` 的书按 `lastReadAt` 升序淘汰，直到只剩 `OFFLINE_RECENT_LIMIT` 本；固定书永不淘汰。
- `remove`/`clearUnpinned` 只删文件与 `offlineBooks` 行，**绝不**碰 `annotations`/`bookmarks`/`progress`/`outbox`。
- `usage.quota` 取 `navigator.storage.estimate().quota`（不可用时 null）。
- 对象 URL 在内存 Map 中复用；`remove`、`clearUnpinned`、`revokeUrls` 时 revoke。
- `cacheFromUrl` 用注入的 `fetchImpl` 下载；非 2xx 抛错；大小等于 `blob.size`。

- [ ] **Step 1: 写失败测试**（全部用 `createMemoryStore()`；jsdom 没有 OPFS）

```ts
it('evicts the sixth unpinned book by last-read time', async () => { /* six books, assert oldest evicted and its files gone */ });
it('never evicts a pinned book or the book being read', async () => { /* ... */ });
it('clearing the cache leaves annotations, bookmarks, progress and outbox intact', async () => {
  // seed all four tables, clearUnpinned, assert row counts unchanged
});
it('sums book and reflow bytes per book', async () => { /* ... */ });
it('returns a reusable object URL for a cached file', async () => { /* ... */ });
it('skips OPFS when unavailable and still works through IndexedDB', async () => { /* createDefaultStore() in jsdom */ });
```

- [ ] **Step 2: 运行确认失败** — `pnpm --filter @bookr/web test -- offline` → FAIL

- [ ] **Step 3: 实现**

OPFS：`navigator.storage.getDirectory()` → `getDirectoryHandle('bookr-cache', { create: true })`，按 key 分段建目录与文件；写入用 `createWritable()` + `write(blob)`。

- [ ] **Step 4: 运行确认通过** — `pnpm --filter @bookr/web test -- offline` → PASS

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/offline
git commit -m "feat(web): offline file cache with LRU and pinning"
```

---

### Task 13: 离线打开书籍与缓存操作

**Files:**
- Create: `apps/web/src/offline/bookSource.ts`
- Modify: `apps/web/src/features/reader/ReaderPage.tsx`（URL 解析）、`ReaderChrome.tsx`（离线徽标）
- Modify: `apps/web/src/features/bookshelf/{BookCard,BookshelfPage}.tsx`（下载/固定/移出）
- Test: `apps/web/src/offline/__tests__/book-source.test.ts`、`apps/web/src/features/bookshelf/__tests__/offline-actions.test.tsx`

**Interfaces:**
- Produces:

```ts
export class OfflineUnavailableError extends Error {}
export interface ResolvedBookSource {
  fileUrl: string;
  reflowUrl: string | null;
  offline: boolean;
}
export interface ResolveBookSourceDeps {
  cache: CacheManager;
  online: () => boolean;
  userId: string;
  bookId: string;
  reflowAvailable: boolean;
  /** 生产传 api/reading 的 fetchReaderFile / fetchReflowFile；测试注入假实现。 */
  fetchFile: (bookId: string) => Promise<{ url: string }>;
  fetchReflow: (bookId: string) => Promise<{ url: string } | null>;
}
export async function resolveBookSource(deps: ResolveBookSourceDeps): Promise<ResolvedBookSource>;
```

**行为：**
- 在线：`fetchReaderFile`/`fetchReflowFile` 成功即用签名 URL；若该书已固定或已在 `offlineBooks` 中，后台 `cacheFromUrl` 刷新缓存。任一网络失败 → 回退缓存。
- 离线：只用 `cachedUrl`；原书缺失抛 `OfflineUnavailableError`（文案 `这本书尚未下载到本机`）；重排包缺失时 `reflowUrl: null`，阅读器自动停留在原版。
- 打开成功即 `cache.touch(userId, bookId)`，随后 `enforceLru`。
- 书架卡片菜单：`下载到本机`（固定）、`取消固定`、`移出本机`；已缓存显示 `离线` 徽标；未固定且不在最近 5 本时只提供 `下载到本机`。
- BookshelfPage 通过 `db.offlineBooks` 查询缓存状态，并在同步事件后刷新。

- [ ] **Step 1: 写失败测试**

```ts
it('uses the signed URL when online and caches the file in the background', async () => { /* ... */ });
it('falls back to the cached blob when the network fails', async () => { /* ... */ });
it('throws OfflineUnavailableError when offline and uncached', async () => { /* ... */ });
it('returns reflowUrl null when the pack is not cached offline', async () => { /* ... */ });
```

```tsx
it('shows 离线 on a cached book and pins it from the menu', async () => { /* ... */ });
it('removing a cached book keeps its annotations', async () => { /* ... */ });
```

- [ ] **Step 2: 运行确认失败** — `pnpm --filter @bookr/web test -- book-source offline-actions` → FAIL

- [ ] **Step 3: 实现**（`ReaderPage` 的错误页对 `OfflineUnavailableError` 显示专用文案）

- [ ] **Step 4: 运行确认通过** — `pnpm --filter @bookr/web test` → PASS

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/offline apps/web/src/features/reader apps/web/src/features/bookshelf
git commit -m "feat(web): read offline from the local cache"
```

---

### Task 14: 设置页（同步、缓存、设备）

**Files:**
- Create: `apps/web/src/api/devices.ts`、`apps/web/src/features/settings/SettingsPage.tsx`、`DeviceList.tsx`、`OfflineCachePanel.tsx`
- Modify: `apps/web/src/app/router.tsx`（`/settings` 放在 `AppLayout` 子路由）、`AppLayout.tsx`（导航入口）
- Test: `apps/web/src/features/settings/__tests__/settings.test.tsx`

**Interfaces:**
- Consumes: `useSync()`（Task 10）、`CacheManager`（Task 12）、`SyncStatusBadge`
- Produces：

```ts
// api/devices.ts
export interface DeviceItem { id: string; name: string | null; platform: string | null; lastSeenAt: string | null; createdAt: string; current: boolean }
export function fetchDevices(): Promise<DeviceItem[]>;
export function renameDevice(id: string, name: string | null): Promise<DeviceItem>;
export function revokeDevice(id: string): Promise<void>;
```

**页面分区：**
1. 同步：状态徽标、待同步条数、`立即同步` 按钮、上次同步时间。
2. 离线缓存：已用空间/配额、已缓存书籍列表（书名、大小、固定开关、移出）、`清理未固定的缓存`。
3. 设备：名称、平台、最近活跃、当前设备标记、重命名、撤销（撤销当前设备后 `logout()`）。

- [ ] **Step 1: 写失败测试**

```tsx
it('shows the sync state and lets the user sync now', async () => { /* spy syncNow */ });
it('lists cached books with sizes and clears unpinned ones', async () => { /* ... */ });
it('renames and revokes a device', async () => { /* msw handlers */ });
it('logs out after revoking the current device', async () => { /* ... */ });
```

- [ ] **Step 2: 运行确认失败** — `pnpm --filter @bookr/web test -- settings` → FAIL

- [ ] **Step 3: 实现并接入路由/导航**

- [ ] **Step 4: 运行确认通过** — `pnpm --filter @bookr/web test` → PASS

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/api/devices.ts apps/web/src/features/settings apps/web/src/app
git commit -m "feat(web): settings page for sync, cache and devices"
```

---

### Task 15: 端到端验收（多设备 / 离线写入 / 离线阅读）

**Files:**
- Create: `apps/web/e2e/sync.spec.ts`
- Modify: `apps/web/e2e/helpers.ts`（如需：`readShelf`、`pinBook`、`loginInNewContext`）
- Modify: `apps/web/tsconfig.e2e.json`（若新文件引入新类型）

**前置：** 复用现有 `helpers.ts` 的邀请注册、上传、登录与清理；测试只连 `E2E_BASE_URL ?? http://localhost:8180`。

- [ ] **Step 1: 写测试**

```ts
test('a highlight on one device appears on the other within 5 seconds', async ({ browser }) => {
  // context A: login, upload fixture PDF, open, select text, create highlight
  // context B: same account, open the same book
  // expect B to show the mark within 5_000 ms without reloading
});

test('an offline annotation is pushed after reconnecting', async ({ browser, context }) => {
  // open book, context.setOffline(true), create bookmark + note
  // expect the local UI to show them while offline
  // context.setOffline(false), trigger visibilitychange
  // a second context sees both within 15 s
});

test('a cached book opens offline and survives a reload', async ({ browser }) => {
  // open book, pin it from the shelf, wait for the 离线 badge
  // context.setOffline(true), reload, open the book -> pages render
  // clear the offline cache -> opening reports 这本书尚未下载到本机
});
```

- [ ] **Step 2: 运行**

```bash
pnpm --filter @bookr/web e2e:fixtures
pnpm --filter @bookr/web e2e
```
Expected: 7 passed（既有 4 + 新增 3）

- [ ] **Step 3: 类型检查**

```bash
pnpm --filter @bookr/web typecheck:e2e
```
Expected: 通过

- [ ] **Step 4: 提交**

```bash
git add apps/web/e2e apps/web/tsconfig.e2e.json
git commit -m "test(e2e): multi-device sync and offline reading"
```

---

### Task 16: 文档与路线图

**Files:**
- Modify: `README.md`、`docs/superpowers/plans/2026-10-18-00-roadmap.md`

- [ ] **Step 1: README 增补**

「同步与离线」一节：本地优先模型、`/api/sync/{push,pull,snapshot,stream-token,stream}`、`/api/devices`、冲突规则、90 天保留期、离线缓存（最近 5 本 + 固定、OPFS、清理不影响未同步数据）、设置页入口，以及“首次登录新设备会先拉快照”。

- [ ] **Step 2: 路线图**

把 04 标记为已交付，补上计划文件链接。

- [ ] **Step 3: 提交**

```bash
git add README.md docs/superpowers/plans/2026-10-18-00-roadmap.md
git commit -m "docs: document sync and offline behavior"
```

---

## Rulings（计划层已决定的取舍）

- **同步实体范围**：本计划只同步「每用户」的四类实体（进度、批注、书签、阅读设置）。图书元数据与分类是书架级共享数据、以服务端为权威，客户端通过 TanStack Query + 离线书架快照读取，不进入每用户变更日志。AI 线程/消息（P5）与阅读会话（P7）在该功能落地时扩展 `SYNC_ENTITY_TYPES`，协议已按开放枚举设计。代价：离线修改图书元数据（P1 本就不支持）不会同步。
- **文字层离线缓存**：`books.text_layer_key` 目前没有任何 UI/阅读路径消费，缓存它没有意义，故不实现。代价：将来若启用文字层，需要补缓存类型。
- **三端联调**：桌面/移动壳复用同一 Web 构建，本计划的同步与离线逻辑（Dexie/OPFS）在壳内同样生效；但本分支只做浏览器 E2E，壳内的 OPFS 与生命周期差异留待 P8 安装包验收。代价：Android WebView 的 OPFS 行为未在分支内实测。
- **设置冲突**：阅读设置作为单文档 LWW，不做字段级合并。代价：两端同时改不同设置项时，较早的一次会整体被覆盖（下次修改即恢复）。

## Final verification checklist

- `pnpm exec turbo run typecheck test --force` → 12/12 任务通过
- `pnpm --filter @bookr/server db:test:reset` 后服务端全量测试通过（新增 5 个测试文件）
- `pnpm --filter @bookr/web e2e` → 7/7；`typecheck:e2e` 通过
- `docker compose up -d --build` 后 4 个服务 healthy、`/healthz` 200
- 手工验收：两台设备 5 秒内同步、断网记笔记后联网合并、断网打开已缓存书籍

## Execution Note

- Task 1 完成后拆两条并行工作流（用户长期要求并发执行）：
  - **服务端流**：Task 2 → 3 → 4 → 5 → 6 → 7，同一实现者顺序执行（共享 `sync/` 与 schema）。
  - **客户端流**：Task 8 → 9 → 10 → 11 → 12 → 13 → 14，另一实现者顺序执行。
- 两条流只在 `packages/shared`（Task 1 已冻结）与 `pnpm-lock.yaml`（仅客户端流改动）交汇；服务端流不得修改 web 文件。
- Task 15/16 由控制者在两条流汇合后派发；E2E 需要重建 Compose 镜像。
- 每任务独立审查；最终整分支审查用最强模型，发现只做一轮修复 + 一次限定范围复审。
