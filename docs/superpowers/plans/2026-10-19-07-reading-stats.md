# 阅读统计与坚持（P7）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 如实记录阅读时间：阅读器在前台且可见时按 30 秒打点计时、无操作 2 分钟暂停；会话经 P4 同步通道离线排队、联网补传；服务端按用户时区把会话拆到自然日并聚合出 `daily_stats`；统计页展示连续坚持天数、累计有效天数、今日/本周/本月阅读时长、最近 30 天柱状图、读完的书与最常读的书。

**Architecture:** 会话由客户端生成 UUIDv7，作为 `reading_session` 实体进入现有 LWW 同步通道（只写实体：快照不包含它，其他设备拉到后仅更新本地缓存）。服务端在同步事务内把受影响自然日从 `reading_sessions` 重新聚合到 `daily_stats`（按墙钟重叠比例拆分跨午夜的会话），聚合只发生在写入会话时，统计读取是纯只读查询。统计口径按 `users.timezone` 解释自然日；时区变更时整表重建。Web 用一个纯状态机 `createReadingClock()` 负责计时，React Hook 只负责事件绑定与持久化。

**Tech Stack:** TypeScript strict、Fastify 5、PostgreSQL 16 + Drizzle、Zod 4、Intl API、React 19 + TanStack Query、Dexie、Vitest、MSW、Playwright。

**Spec:** `docs/superpowers/specs/2026-10-18-private-book-reader-design.md`（5.6 阅读统计与坚持天数、5.7 同步、7 数据模型、13 验收标准 5）

## Global Constraints

- TypeScript strict，禁止 `any`；共享契约（`packages/shared`）先于使用方定义。
- 所有会话与统计严格按 `user_id` 隔离；统计接口只返回调用者自己的数据。
- 计时口径：阅读器可见且处于前台才累计；无操作超过 2 分钟暂停；每 30 秒打点一次。
- 有效阅读日：当天累计有效阅读 ≥ `EFFECTIVE_READING_SECONDS = 600` 秒。
- 坚持天数：截至今天；今天尚未达标时截至昨天。跨天、跨时区不重复、不丢失。
- 会话是只写同步实体：`reading_session` 不进入 `SyncSnapshot`，不改变现有快照结构与离线缓存。
- 统计读取是只读的：`GET /api/stats` 不写库；聚合只在会话写入或时区变更时发生。
- 日志不得记录书籍正文或笔记内容；会话日志最多记录 userId、sessionId、错误名。
- 不新增运行时依赖（图表用 CSS 绘制）。
- 每个任务结束必须 `pnpm exec turbo run typecheck test` 通过并提交。
- E2E 是破坏性测试：只允许 localhost；`E2E_ALLOW_REMOTE=1` 仅用于一次性测试环境，永不对生产运行。
- 并发执行的服务端测试各自使用独立的 `TEST_DATABASE_URL`，避免共享 `bookr_test` 时的 TRUNCATE 竞争。

## Review Focus

- **计时边界**：页面隐藏、窗口失焦、无操作 2 分钟都不能计时；重新操作后只计新时间，不回补空闲区间；30 分钟分段不丢最后一秒。
- **跨午夜拆分**：23:50–00:20 的 30 分钟会话按墙钟比例拆到两天；DST 的 23 小时/25 小时自然日边界正确；两条时区下总量守恒。
- **坚持天数锚点**：今天已达标从今天数；今天未达标但昨天达标从昨天数；昨天也未达标为 0；中间断一天即停止。
- **离线与重放**：断网时每个会话只在 outbox 保留一行（合并心跳），联网后补传只计一次；重复推送与乱序心跳不重复计时、不回退已有时长。
- **统计页移动端**：360px 宽下英雄数字、四张卡片、30 根柱子不溢出、不横向滚动页面；柱状图有可读的无障碍标签；离线/空/错误状态明确。

---

## 文件结构

**共享**
- 创建 `packages/shared/src/stats.ts`、`packages/shared/src/__tests__/stats.test.ts`
- 修改 `packages/shared/src/sync.ts`（实体类型与载荷 schema）
- 修改 `packages/shared/src/schemas/auth.ts`（时区更新 schema）
- 修改 `packages/shared/src/index.ts`

**服务端**
- 修改 `apps/server/src/db/schema.ts`、新增 `apps/server/drizzle/0007_reading_stats.sql` 与 `drizzle/meta/*`
- 创建 `apps/server/src/stats/{time,repo,aggregate,service,routes}.ts`
- 修改 `apps/server/src/sync/{apply,service}.ts`、`apps/server/src/app.ts`、`apps/server/src/auth/routes.ts`
- 创建 `apps/server/test/{stats-time,stats-aggregate,sync-session,stats-service,stats-routes,profile-timezone}.test.ts`

**Web**
- 创建 `apps/web/src/features/reader/{readingClock.ts,useReadingSession.ts}`
- 创建 `apps/web/src/features/reader/__tests__/{reading-clock.test.ts,use-reading-session.test.tsx}`
- 修改 `apps/web/src/sync/{db,types,repository,outbox}.ts`、`apps/web/src/features/reader/ReaderPage.tsx`
- 创建 `apps/web/src/api/stats.ts`、`apps/web/src/lib/useOnlineStatus.ts`
- 创建 `apps/web/src/features/stats/{StatsPage,DailyChart,format}.tsx|ts`
- 创建 `apps/web/src/features/stats/__tests__/stats-page.test.tsx`
- 修改 `apps/web/src/app/{router,AppLayout}.tsx`、`apps/web/src/features/notes/useNotes.ts`
- 修改 `apps/web/src/api/auth.ts`、`apps/web/src/features/settings/{SettingsPage.tsx,timezones.ts}`
- 创建 `apps/web/src/features/settings/__tests__/timezone-setting.test.tsx`
- 修改 `apps/web/test/setup.ts`（`/api/stats`、`PATCH /api/auth/me` 默认夹具）

**E2E / 文档**
- 创建 `apps/web/e2e/stats.spec.ts`
- 修改 `README.md`、`docs/superpowers/plans/2026-10-18-00-roadmap.md`

---

## 任务依赖与并发波次

同一波次内任务的文件互不重叠，可以并发执行；不同波次必须等前一波全部通过审查。

1. 波次 1：Task 1（共享契约）
2. 波次 2：Task 2（数据库与统计日期基础）
3. 波次 3（并发）：Task 3（会话入库与日聚合）、Task 4（统计读取服务与接口）、Task 5（Web 计时与同步）、Task 6（统计页）
4. 波次 4：Task 7（时区设置）
5. 波次 5：Task 8（E2E、文档与交付记录）

服务端并发任务（Task 3、Task 4）在验证时分别使用
`TEST_DATABASE_URL=postgres://bookr:bookr@localhost:5432/bookr_stats_ingest_test` 与
`.../bookr_stats_read_test`（测试进程会自行迁移）；控制器负责先创建这两个空库。

---

### Task 1: 共享统计契约与阅读会话载荷

**Files:**
- Create: `packages/shared/src/stats.ts`
- Create: `packages/shared/src/__tests__/stats.test.ts`
- Modify: `packages/shared/src/sync.ts`
- Modify: `packages/shared/src/schemas/auth.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `z`（zod）、现有 `syncPayloadSchemaFor` 分支结构
- Produces（后续任务逐字使用）:

```ts
// packages/shared/src/stats.ts
export const READING_SESSION_TICK_SECONDS = 30;
export const READING_IDLE_PAUSE_SECONDS = 120;
export const READING_SESSION_MAX_SEGMENT_SECONDS = 1_800;
export const READING_SESSION_MAX_ACTIVE_SECONDS = 14_400;
export const READING_SESSION_MAX_SPAN_SECONDS = 86_400;
export const READING_SESSION_MAX_PAGES = 100_000;
export const EFFECTIVE_READING_SECONDS = 600;
export const STATS_DAILY_DAYS = 30;

/** Payload of a `reading_session` sync upsert; the entity id is the session id. */
export interface ReadingSessionPayload {
  bookId: string;
  startedAt: string; // ISO 8601
  endedAt: string;   // ISO 8601
  activeSeconds: number;
  pagesRead: number;
}
export const syncReadingSessionPayloadSchema: z.ZodType<ReadingSessionPayload>;

export interface DailyReadingStatDto {
  date: string; // YYYY-MM-DD in the user's timezone
  activeSeconds: number;
  qualified: boolean;
}

export interface TopBookStatDto {
  id: string;
  title: string;
  author: string | null;
  activeSeconds: number;
}

export interface ReadingStatsDto {
  timezone: string;
  today: string;
  streakDays: number;
  effectiveDays: number;
  todaySeconds: number;
  weekSeconds: number;
  monthSeconds: number;
  finishedBooks: number;
  topBook: TopBookStatDto | null;
  /** Oldest first, exactly STATS_DAILY_DAYS entries, ending today. */
  daily: DailyReadingStatDto[];
}

/** Whether `Intl` accepts the zone; used by both the API schema and the UI. */
export function isValidTimeZone(timezone: string): boolean;
```

```ts
// packages/shared/src/sync.ts — add at the end of SYNC_ENTITY_TYPES
export const SYNC_ENTITY_TYPES = [
  'reading_progress', 'annotation', 'bookmark', 'reader_settings', 'reading_session',
] as const;
// syncPayloadSchemaFor gains: case 'reading_session': return syncReadingSessionPayloadSchema;
```

```ts
// packages/shared/src/schemas/auth.ts
export const updateProfileSchema = z.object({
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine(isValidTimeZone, { message: 'invalid timezone' }),
});
export interface ProfileUpdateDto { timezone: string }
```

- [x] **Step 1: 写失败的 shared 测试**

在 `packages/shared/src/__tests__/stats.test.ts` 覆盖：
- 合法载荷通过；`endedAt < startedAt`、跨度超过 24h、`activeSeconds` 超过 4h、`activeSeconds > 墙钟秒数 + 5`、`pagesRead` 超上限、非 ISO 时间全部失败。
- `isValidTimeZone('Asia/Shanghai')`、`'UTC'`、`'America/New_York'` 为真；`''`、`'Mars/Olympus'`、`'+08:00'` 为假。
- `updateProfileSchema` 去掉首尾空格后接受 `' Asia/Tokyo '`，拒绝无效时区。
- `SYNC_ENTITY_TYPES` 包含 `'reading_session'`，且 `syncPayloadSchemaFor('reading_session')` 解析上述载荷。

- [x] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @bookr/shared test -- stats`
Expected: FAIL（`stats.ts` 不存在 / 导出缺失）

- [x] **Step 3: 实现契约**

`stats.ts` 中 `syncReadingSessionPayloadSchema` 用 `z.object({...})`（`bookId: z.uuid()`、时间 `z.iso.datetime({ offset: true })`（同时接受 `Z` 与 `+08:00` 偏移）、两个整数字段）加 `superRefine` 校验顺序、跨度与活动时长上限；`isValidTimeZone` 用 `try { new Intl.DateTimeFormat('en-US', { timeZone }).format(0); return true } catch { return false }`，并拒绝空串。`sync.ts` 增加类型与 schema 分支。`schemas/auth.ts` 从 `../stats` 导入 `isValidTimeZone`。`index.ts` 导出 `stats.ts` 的全部内容。

- [x] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @bookr/shared test -- stats`
Expected: PASS；随后 `pnpm --filter @bookr/shared typecheck` 通过。

- [x] **Step 5: 提交**

```bash
git add packages/shared/src/stats.ts packages/shared/src/sync.ts packages/shared/src/schemas/auth.ts packages/shared/src/index.ts packages/shared/src/__tests__/stats.test.ts
git commit -m "feat(shared): add reading stats contracts and session payload"
```

---

### Task 2: 数据库表与统计日期基础

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Create: `apps/server/drizzle/0007_reading_stats.sql`（以 drizzle-kit 生成为准）与 `drizzle/meta/0007_snapshot.json`、`drizzle/meta/_journal.json`
- Create: `apps/server/src/stats/time.ts`
- Create: `apps/server/test/stats-time.test.ts`

**Interfaces:**
- Consumes: `users`、`books`、`devices` 表定义与现有 `uuid`/索引习惯
- Produces:

```ts
export const readingSessions = pgTable('reading_sessions', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  bookId: uuid('book_id').notNull().references(() => books.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }).notNull(),
  activeSeconds: integer('active_seconds').notNull(),
  pagesRead: integer('pages_read').notNull().default(0),
  clientUpdatedAt: timestamp('client_updated_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('reading_sessions_user_started_idx').on(table.userId, table.startedAt),
]);
export type ReadingSessionRow = typeof readingSessions.$inferSelect;

export const dailyStats = pgTable('daily_stats', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  localDate: date('local_date').notNull(),
  activeSeconds: integer('active_seconds').notNull(),
  qualified: boolean('qualified').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.userId, table.localDate] })]);
export type DailyStatsRow = typeof dailyStats.$inferSelect;
```

```ts
// apps/server/src/stats/time.ts
/** YYYY-MM-DD of `instant` in `timezone`. */
export function localDateOf(instant: Date, timezone: string): string;
/** First UTC instant whose local date is `localDate`. */
export function localDayStart(localDate: string, timezone: string): Date;
/** First UTC instant of the next local date. */
export function localDayEnd(localDate: string, timezone: string): Date;
/** Calendar arithmetic on YYYY-MM-DD strings (no timezone involved). */
export function addLocalDays(localDate: string, days: number): string;
/** Monday of the week containing `localDate`. */
export function startOfLocalWeek(localDate: string): string;
/** First day of the month of `localDate`. */
export function startOfLocalMonth(localDate: string): string;
```

- [x] **Step 1: 写失败的时间测试**

`apps/server/test/stats-time.test.ts`：
- `localDateOf(new Date('2026-10-18T16:30:00Z'), 'Asia/Shanghai') === '2026-10-19'`；同一时刻 `'America/New_York'` 为 `'2026-10-18'`。
- 上海：`localDayStart('2026-10-19','Asia/Shanghai')` = `2026-10-18T16:00:00Z`，`localDayEnd` = `2026-10-19T16:00:00Z`。
- 纽约 DST 开始：`localDayStart('2026-03-08','America/New_York')` = `2026-03-08T05:00:00Z`，`localDayEnd` = `2026-03-09T04:00:00Z`（23 小时）。
- 柏林 DST 结束：`localDayStart('2026-10-25','Europe/Berlin')` = `2026-10-24T22:00:00Z`，`localDayEnd` = `2026-10-25T23:00:00Z`（25 小时）。
- `Australia/Lord_Howe` 2026-04-05（30 分钟 DST 偏移）：`localDateOf(localDayStart('2026-04-05','Australia/Lord_Howe')) === '2026-04-05'`，该日长度为 24.5 小时。
- `addLocalDays('2026-12-31', 1) === '2027-01-01'`，`addLocalDays('2026-03-01', -1) === '2026-02-28'`。
- `startOfLocalWeek('2026-10-19') === '2026-10-19'`（周一），`startOfLocalWeek('2026-10-25') === '2026-10-19'`，`startOfLocalMonth('2026-10-19') === '2026-10-01'`。

- [x] **Step 2: 运行确认失败**

Run: `pnpm --filter @bookr/server test -- stats-time`
Expected: FAIL（模块不存在）

- [x] **Step 3: 生成表与迁移**

在 `schema.ts` 中加入两张表（放在 `bookmarks` 之后、`syncChanges` 之前）。运行：

```bash
pnpm --filter @bookr/server exec drizzle-kit generate --name reading_stats
```

确认生成 `0007_reading_stats.sql` 含 `CREATE TABLE reading_sessions`、`CREATE TABLE daily_stats`、主键、外键与索引。测试迁移由 `test/helpers.ts` 自动执行。

- [x] **Step 4: 实现日期工具**

`localDateOf` 用 `Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })`（时区非法时直接抛错，调用方已校验）。`localDayStart` 用 `timeZoneName: 'longOffset'` 解析 `GMT±HH:MM` 偏移求候选 UTC 时刻，再 `localDateOf` 回验；不匹配时按 15 分钟步长最多校正 8 次（覆盖 Lord Howe 等 30 分钟 DST 偏移），仍不匹配抛 `RangeError`。`localDayEnd(date) = localDayStart(addLocalDays(date, 1))`。日历运算用 `Date.UTC(y, m-1, d) + days*86_400_000` 再格式化，不经过时区。

- [x] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @bookr/server test -- stats-time`
Expected: PASS

- [x] **Step 6: 提交**

```bash
git add apps/server/src/db/schema.ts apps/server/drizzle apps/server/src/stats/time.ts apps/server/test/stats-time.test.ts
git commit -m "feat(server): add reading session tables and timezone date helpers"
```

---

### Task 3: 会话入库、幂等与日聚合

**Files:**
- Create: `apps/server/src/stats/repo.ts`
- Create: `apps/server/src/stats/aggregate.ts`
- Modify: `apps/server/src/sync/apply.ts`
- Modify: `apps/server/src/sync/service.ts`（导出载荷构造）
- Create: `apps/server/test/stats-aggregate.test.ts`
- Create: `apps/server/test/sync-session.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `syncReadingSessionPayloadSchema`、`ReadingSessionPayload`、`EFFECTIVE_READING_SECONDS`；Task 2 的表与 `localDateOf`/`localDayStart`/`localDayEnd`/`addLocalDays`；现有 `lockUserChanges`、`appendChange`、`findBookById`、`effectiveClientTime`、`samePayload`
- Produces:

```ts
// apps/server/src/stats/repo.ts
export interface UpsertReadingSessionInput {
  id: string;
  userId: string;
  bookId: string;
  deviceId: string | null;
  startedAt: Date;
  endedAt: Date;
  activeSeconds: number;
  pagesRead: number;
  clientUpdatedAt: Date;
  updatedAt: Date;
}
export async function findReadingSession(tx: Transaction, id: string): Promise<ReadingSessionRow | null>;
export async function upsertReadingSession(tx: Transaction, input: UpsertReadingSessionInput): Promise<ReadingSessionRow>;
export async function readUserTimezone(db: Database, userId: string): Promise<string>;
export async function listSessionsOverlapping(tx: Transaction, userId: string, from: Date, to: Date): Promise<ReadingSessionRow[]>;
export async function listAllSessions(tx: Transaction, userId: string): Promise<ReadingSessionRow[]>;
export async function replaceDailyStat(tx: Transaction, input: { userId: string; localDate: string; activeSeconds: number; qualified: boolean; updatedAt: Date }): Promise<void>;
export async function deleteDailyStat(tx: Transaction, userId: string, localDate: string): Promise<void>;
export async function deleteAllDailyStats(tx: Transaction, userId: string): Promise<void>;

// apps/server/src/stats/aggregate.ts
/** Local dates touched by a session, inclusive; at most 25 entries. */
export function sessionLocalDates(startedAt: Date, endedAt: Date, timezone: string): string[];
/** Active seconds this session contributes to one local date (wall-clock overlap). */
export function splitSessionSeconds(row: Pick<ReadingSessionRow, 'startedAt' | 'endedAt' | 'activeSeconds'>, localDate: string, timezone: string): number;
/** Recomputes the given local dates from raw sessions; zero rows are deleted. */
export async function recomputeDailyStats(tx: Transaction, userId: string, timezone: string, dates: string[]): Promise<void>;
/** Drops and rebuilds every daily_stats row for a user, used after a timezone change. */
export async function rebuildDailyStats(db: Database, userId: string, timezone: string): Promise<void>;

// apps/server/src/sync/service.ts
export function sessionChangePayload(row: ReadingSessionRow, clientUpdatedAt: Date): Record<string, unknown>;
// { bookId, startedAt: ISO, endedAt: ISO, activeSeconds, pagesRead, clientUpdatedAt: ISO }
```

- [x] **Step 1: 写失败的聚合测试**

`apps/server/test/stats-aggregate.test.ts`（使用 `testDb`、`seedUser`/`seedBook` 现有 helper，必要时新增本地 seed）：
- 上海 23:50–00:20、`activeSeconds=1500`：`sessionLocalDates` 为两天；`splitSessionSeconds` 分别 500 与 1000；`recomputeDailyStats` 后两天的 `daily_stats` 之和为 1500，10-18 不达标、10-19 达标（如有其它会话则按实际断言）。
- 0 长度会话把全部秒数记在开始日。
- 600 秒恰好 `qualified=true`，599 秒为 `false`。
- 同一批会话分别在 `Asia/Shanghai` 与 `America/New_York` 重建：两次所有自然日秒数总和都等于会话秒数总和（守恒、不重复、不丢失）。
- 纽约 DST 开始日（2026-03-08）与柏林 DST 结束日（2026-10-25）的跨界会话拆分使用实际日边界。

- [x] **Step 2: 写失败的同步测试**

`apps/server/test/sync-session.test.ts`：
- 通过 `applyPush` 推入合法会话 → 返回 `applied`，`reading_sessions` 有行，`daily_stats` 当天秒数正确。
- 完全相同载荷重放 → `skipped`，秒数不变（不翻倍）。
- 心跳增长（同一 id，`activeSeconds` 600→1200、`endedAt` 后移）→ 应用，当天仍为 1200。
- `activeSeconds` 变小的较新心跳 → `skipped`，保留较长时间。
- 非法载荷（`endedAt < startedAt`、跨度 >24h、活动秒数 > 墙钟+5）→ `rejected`/`invalid_payload`。
- 未知或被回收的 book → `rejected`/`unknown_entity`；同 id 属于他人 → `rejected`/`not_allowed`。
- delete 操作 → `rejected`/`unsupported_op`。

- [x] **Step 3: 运行确认失败**

Run: `TEST_DATABASE_URL=postgres://bookr:bookr@localhost:5432/bookr_stats_ingest_test pnpm --filter @bookr/server test -- stats-aggregate sync-session`
Expected: FAIL（模块不存在 / 未知实体）

- [x] **Step 4: 实现 repo 与 aggregate**

- `recomputeDailyStats`：对 `dates` 去重排序，取 `from = localDayStart(最小日期)`、`to = localDayEnd(最大日期)`，一次 `listSessionsOverlapping` 后对每个日期求和 `splitSessionSeconds`；`> 0` 则 `replaceDailyStat`（`qualified = seconds >= EFFECTIVE_READING_SECONDS`），否则 `deleteDailyStat`。
- `splitSessionSeconds`：`duration = endedAt - startedAt`；`duration <= 0` 时只在开始日返回全部秒数；否则 `round(activeSeconds * overlap / duration)`，`overlap` 是会话与 `[localDayStart, localDayEnd)` 的交集毫秒。
- `rebuildDailyStats`：事务内 `deleteAllDailyStats`，读取全部会话，取所有涉及日期，调用同一拆分逻辑写回。
- `sessionLocalDates`：从 `localDateOf(startedAt)` 逐日 `addLocalDays(+1)` 到 `localDateOf(endedAt)`，最多 25 天（schema 已限制跨度 24h）。

- [x] **Step 5: 接入同步**

`applyChange` 增加 `case 'reading_session': return applyReadingSessionChange(...)`。实现要点：
- 仅接受 `upsert`；解析载荷；`findBookById(includeDeleted:false)` 缺失 → `unknown_entity`。
- `deps.db.transaction` 内先 `lockUserChanges(tx, actor.id)`，再 `findReadingSession`（repo 内 `.for('update')`）。
- 他人行 → `rejected('not_allowed')`。
- 错序/相同：`clientTime < stored.clientUpdatedAt` → `skipped`；相同时间且写字段相同 → `skipped`。
- 单调保护：`stored && parsed.activeSeconds < stored.activeSeconds` → `skipped`。
- `upsertReadingSession` 写 `deviceId: actor.deviceId ?? null`、`updatedAt: now`、`clientUpdatedAt: clientTime`。
- 聚合日期 = 旧行日期 ∪ 新行日期（都按用户时区），调用 `recomputeDailyStats`。时区用 `readUserTimezone(tx, actor.id)`。
- `appendChange` 使用 `sessionChangePayload(row, clientTime)`，`entityType: 'reading_session'`、`entityId` 为会话 id。
- 跳过路径不得写 `daily_stats`。

- [x] **Step 6: 运行测试确认通过**

Run: `TEST_DATABASE_URL=postgres://bookr:bookr@localhost:5432/bookr_stats_ingest_test pnpm --filter @bookr/server test -- stats-aggregate sync-session sync`
Expected: PASS

- [x] **Step 7: 提交**

```bash
git add apps/server/src/stats/repo.ts apps/server/src/stats/aggregate.ts apps/server/src/sync/apply.ts apps/server/src/sync/service.ts apps/server/test/stats-aggregate.test.ts apps/server/test/sync-session.test.ts
git commit -m "feat(server): ingest reading sessions and aggregate daily stats"
```

---

### Task 4: 统计读取服务与接口

**Files:**
- Create: `apps/server/src/stats/service.ts`
- Create: `apps/server/src/stats/routes.ts`
- Modify: `apps/server/src/app.ts`
- Create: `apps/server/test/stats-service.test.ts`
- Create: `apps/server/test/stats-routes.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ReadingStatsDto`/`STATS_DAILY_DAYS`；Task 2 的时间工具与 `dailyStats`/`readingSessions`/`books` 表；`AppDeps`（含 `clock`）
- Produces:

```ts
// apps/server/src/stats/service.ts
export async function getReadingStats(deps: AppDeps, userId: string): Promise<ReadingStatsDto>;
// apps/server/src/stats/routes.ts
export function registerStatsRoutes(app: FastifyInstance, deps: AppDeps): void;
// GET /api/stats → ReadingStatsDto
```

- [x] **Step 1: 写失败的服务测试**

`apps/server/test/stats-service.test.ts`（直接向 `daily_stats`/`reading_sessions`/`books` seed，注入固定 clock，例如 `2026-10-19T04:00:00Z` = 上海 12:00）：
- 无数据：`streakDays=0`、全部时长为 0、`daily` 恰好 30 条且最后一条是 `today`、`topBook=null`。
- 今天达标 → `streakDays=1`；今天+昨天+前天达标 → `3`。
- 今天未达标、昨天+前天达标 → `2`（锚点回退到昨天）。
- 今天未达标、昨天未达标、前天达标 → `0`。
- 今天达标、昨天缺失、前天达标 → `1`（断档停止）。
- `effectiveDays` = 所有 `qualified=true` 的天数；`todaySeconds` 取今天行。
- `weekSeconds` 只汇总本周一至今天；`monthSeconds` 只汇总本月 1 日至今天（种入上月末数据验证排除）。
- `daily` 严格升序、零填充，`qualified` 与行一致。
- `topBook`：按 `reading_sessions.active_seconds` 全时汇总最大者；被回收的 book 排除；`author` 一并返回。
- `finishedBooks` 只统计 `deleted_at IS NULL AND status='finished'`。
- 同一批会话把用户时区从 `Asia/Shanghai` 换成 `America/New_York`：`today`、`streakDays`、`daily` 的日期边界随之时区变化。

- [x] **Step 2: 写失败的路由测试**

`apps/server/test/stats-routes.test.ts`：
- 未登录 → 401。
- 用户 A seed 会话并聚合，用户 B 请求 → 全为 0，看不到 A 的数据。
- 响应符合 `ReadingStatsDto` 字段；`daily.length === 30`。

- [x] **Step 3: 运行确认失败**

Run: `TEST_DATABASE_URL=postgres://bookr:bookr@localhost:5432/bookr_stats_read_test pnpm --filter @bookr/server test -- stats-service stats-routes`
Expected: FAIL

- [x] **Step 4: 实现 `getReadingStats`**

读取 `users.timezone`（缺失回退 `Asia/Shanghai`），`now = deps.clock.now()`，`today = localDateOf(now, timezone)`：
- `daily`：查询 `[addLocalDays(today, -(STATS_DAILY_DAYS-1)), today]` 的 `daily_stats`，零填充升序。
- `weekSeconds`/`monthSeconds`：分别对 `[startOfLocalWeek(today), today]`、`[startOfLocalMonth(today), today]` 用 SQL `sum(active_seconds)`。
- `effectiveDays`：`count(*) where qualified`。
- `streakDays`：查询 `qualified=true` 的 `local_date desc`，按锚点（今天达标取今天，否则昨天达标取昨天，否则 0）用 `addLocalDays(anchor, -1)` 逐日比对，遇到缺口停止。
- `finishedBooks`：`count(books) where status='finished' and deleted_at is null`。
- `topBook`：`reading_sessions` 按 `book_id` 汇总 `active_seconds` 降序，`innerJoin books` 且 `books.deleted_at is null`，取第一条；无则 `null`。
- `todaySeconds` 从 `daily` 中今天的行取。

- [x] **Step 5: 注册路由**

`stats/routes.ts` 用 `makeRequireAuth(deps)`：

```ts
app.get('/api/stats', { preHandler: requireAuth }, async (request) =>
  getReadingStats(deps, request.user!.id),
);
```

在 `app.ts` 的 `registerNoteAnalysisRoutes` 之后调用 `registerStatsRoutes(app, deps)`。

- [x] **Step 6: 运行测试确认通过**

Run: `TEST_DATABASE_URL=postgres://bookr:bookr@localhost:5432/bookr_stats_read_test pnpm --filter @bookr/server test -- stats-service stats-routes`
Expected: PASS

- [x] **Step 7: 提交**

```bash
git add apps/server/src/stats/service.ts apps/server/src/stats/routes.ts apps/server/src/app.ts apps/server/test/stats-service.test.ts apps/server/test/stats-routes.test.ts
git commit -m "feat(server): expose read-only reading statistics"
```

---

### Task 5: Web 阅读计时、本地会话与同步

**Files:**
- Create: `apps/web/src/features/reader/readingClock.ts`
- Create: `apps/web/src/features/reader/useReadingSession.ts`
- Create: `apps/web/src/features/reader/__tests__/reading-clock.test.ts`
- Create: `apps/web/src/features/reader/__tests__/use-reading-session.test.tsx`
- Modify: `apps/web/src/sync/db.ts`（version 6）
- Modify: `apps/web/src/sync/types.ts`
- Modify: `apps/web/src/sync/repository.ts`
- Modify: `apps/web/src/sync/outbox.ts`（合并 `reading_session` 心跳）
- Modify: `apps/web/src/features/reader/ReaderPage.tsx`（接线与冲突文案表）
- Modify: `apps/web/test/memory-repository.ts`（实现 `saveReadingSession` 与 `reading_session` 本地应用）

**Interfaces:**
- Consumes: Task 1 的 `READING_SESSION_TICK_SECONDS`/`READING_IDLE_PAUSE_SECONDS`/`READING_SESSION_MAX_SEGMENT_SECONDS`；现有 `LocalRepository`、`SyncContextValue.requestSync`、`ReaderEngine.on('relocated')`、`newId()`
- Produces:

```ts
// readingClock.ts
export interface ReadingSessionSnapshot {
  startedAt: number; // epoch ms
  endedAt: number;
  activeSeconds: number;
  pagesRead: number;
}
export interface ReadingClockTick {
  /** Open session's cumulative state, when active seconds or pages changed. */
  snapshot?: ReadingSessionSnapshot;
  /** A session that ended during this tick; persist as final. */
  closed?: ReadingSessionSnapshot;
}
export interface ReadingClockOptions {
  now?: () => number;
  idleMs?: number;           // default 120_000
  maxSegmentMs?: number;     // default 1_800_000
}
export interface ReadingClock {
  activity(at?: number): void;
  pageTurn(at?: number): void;
  setVisible(visible: boolean, at?: number): void;
  setFocused(focused: boolean, at?: number): void;
  tick(at?: number): ReadingClockTick;
  close(at?: number): ReadingSessionSnapshot | null;
  isActive(at?: number): boolean;
  current(): ReadingSessionSnapshot | null;
}
export function createReadingClock(options?: ReadingClockOptions): ReadingClock;

// useReadingSession.ts
export interface UseReadingSessionOptions {
  userId: string | null;
  bookId: string | null;
  enabled: boolean;
  engine: ReaderEngine | null;
  repo: LocalRepository;
  requestSync: (reason?: string) => void;
}
export function useReadingSession(options: UseReadingSessionOptions): void;

// sync/repository.ts
saveReadingSession(
  userId: string,
  input: {
    id: string;
    bookId: string;
    startedAt: string; // ISO
    endedAt: string;   // ISO
    activeSeconds: number;
    pagesRead: number;
  },
): Promise<void>;

// sync/types.ts
export interface LocalReadingSessionRow {
  id: string;
  userId: string;
  bookId: string;
  startedAt: string;
  endedAt: string;
  activeSeconds: number;
  pagesRead: number;
  clientUpdatedAt: string;
  dirty: boolean;
}
```

- [x] **Step 1: 写失败的计时器测试**

`reading-clock.test.ts`（注入可变 `now`，不依赖 fake timers）：
- 可见+聚焦，t=0 记录活动，t=30s tick → `snapshot.activeSeconds=30`。
- 无新活动，t=120s tick → `closed.activeSeconds=120`（2 分钟空闲边界结束会话，`endedAt=120s`）；t=150s tick 无快照。
- t=200s 重新活动、t=210s tick → 新会话的 `snapshot.activeSeconds=10`（只加新 10 秒，不回补空闲；会话 id 由 Hook 换新）。
- 隐藏期间不计：t=30s tick（30s），隐藏，t=60s tick（仍 30），可见，t=90s tick → 60。
- 失焦同隐藏。
- 30 分钟分段：连续活动与 30s tick，到 1800s 时 `closed.activeSeconds=1800`，随后新会话从 0 开始；`startedAt` 连续。
- `close()` 返回最终快照并清空；0 秒会话不产生快照。
- `pageTurn()` 增加 `pagesRead` 并触发 snapshot。

- [x] **Step 2: 写失败的 Hook 测试**

`use-reading-session.test.tsx`（fake timers + fake engine + fake repo）：
- 30 秒后 `repo.saveReadingSession` 被调用一次，携带 `bookId`、同一会话 id、累计秒数；`requestSync('reading_session')` 被调用。
- 再次 30 秒调用同一 id（不是新会话）；累计秒数增长。
- 会话关闭后下一次开始使用新的 id。
- `enabled=false` 或 `userId=null` 时不保存；可见性变为 hidden 时立即 flush 最终值。
- `engine.on('relocated')` 触发 `pagesRead` 增长。

- [x] **Step 3: 运行确认失败**

Run: `pnpm --filter @bookr/web test -- reading-clock use-reading-session`
Expected: FAIL（模块不存在）

- [x] **Step 4: 实现计时器**

严格遵守上述语义：
- 只有 `visible && focused` 且 `now - lastActivityAt <= idleMs` 的区间计入；tick 时累加 `max(0, min(at, lastActivityAt + idleMs) - lastTickAt)`。
- `activity(at)`：若距上次活动 ≥ idle 且已有会话，先把 `lastTickAt` 推到 `at`（跳过空闲区间）；若无会话且可见+聚焦则开始会话。
- `setVisible(false)` / `setFocused(false)`：把 `lastTickAt` 设为 `at`，停止累计。
- 恢复可见/聚焦时同样把 `lastTickAt` 设为 `at`。
- `tick` 每 30 秒由 Hook 调用；累计达到 `maxSegmentMs` 时先产出 `closed`（`endedAt=at`），若仍活跃立即以 `at` 开始新会话。
- 空闲结束：tick 时若 `at >= lastActivityAt + idleMs` 且会话已有有效秒数，产出 `closed`（`endedAt = lastActivityAt + idleMs`），会话清空；之后重新活动会开始新会话。会话跨度因此不会超过 30 分钟 + 2 分钟。
- `activeSeconds = Math.round(activeMs / 1000)`；只有 `activeSeconds > 0` 的会话才产出快照。
- `endedAt` 为本次 tick/close 的时间（空闲结束取空闲边界）。

- [x] **Step 5: 实现 Hook 与持久化**

Hook：
- `createReadingClock()` 保持单例；`setInterval(30_000)` 调用 `tick()`。
- 监听 `visibilitychange`（`document.visibilityState === 'visible'`）、`window.focus`/`blur`；活动事件 `pointerdown`、`pointermove`、`keydown`、`wheel`、`scroll`、`touchstart`（`{ passive: true }`），以 1 秒节流调用 `activity()`。
- `engine.on('relocated')` → `pageTurn()`。
- 每个 `snapshot`/`closed` 都调用 `saveReadingSession`；`closed` 后会话 id 置空；`snapshot` 与 `closed` 同帧时先存 closed 再存 snapshot。
- `pagehide`、卸载与 `enabled` 变为 false 时执行 `tick()` + `close()` 并同步保存；`visibilitychange` 变为 hidden 时同样立即 `tick()` + `close()`，回到前台后由新的活动开始新会话。
- 每次保存后 `requestSync('reading_session')`。
- 会话 id 用 `newId()`；`closed` 保存后置空。

Repository/Dexie：
- `version(6).stores({ readingSessions: 'id, userId, bookId, startedAt' })`，新增 `readingSessions!: Table<LocalReadingSessionRow, string>`。
- `saveReadingSession` 写入本地行（`dirty: true`，`clientUpdatedAt = new Date().toISOString()`），并以 `entityType:'reading_session'`、`op:'upsert'`、载荷 `{bookId, startedAt, endedAt, activeSeconds, pagesRead}` 入 outbox。
- `outbox.enqueue` 的就地合并条件扩展为 `reading_progress` 与 `reading_session` 的 upsert（同一实体只保留最新累计值）。
- `applyServerChange` 增加 `reading_session` 分支：读取载荷，`serverWins` 后更新本地行（`dirty:false`）并 `dropOutboxFor`；`delete` 删除本地行。`applySnapshot` 不动会话表。
- `markLocalClean` 增加 `reading_session` 分支（清除 dirty）。
- ReaderPage 增加 `SYNC_CONFLICT_MESSAGES.reading_session` 文案（如 `'阅读时长正在同步'`），并在 `useReaderProgress` 附近调用 `useReadingSession({ userId, bookId, enabled: <引擎已就绪>, engine, repo, requestSync })`。
- `apps/web/test/memory-repository.ts` 同步实现 `saveReadingSession`（写入 `readingSessions` 映射与 outbox）及 `applyServerChange` 的 `reading_session` 分支，保持 `MemoryRepository extends LocalRepository` 可编译。

- [x] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @bookr/web test -- reading-clock use-reading-session`
Expected: PASS；`pnpm --filter @bookr/web typecheck` 通过。

- [x] **Step 7: 提交**

```bash
git add apps/web/src/features/reader/readingClock.ts apps/web/src/features/reader/useReadingSession.ts apps/web/src/features/reader/__tests__ apps/web/src/features/reader/ReaderPage.tsx apps/web/src/sync apps/web/test/memory-repository.ts
git commit -m "feat(web): track reading time and sync sessions offline"
```

---

### Task 6: 统计页与每日柱状图

**Files:**
- Create: `apps/web/src/api/stats.ts`
- Create: `apps/web/src/lib/useOnlineStatus.ts`
- Create: `apps/web/src/features/stats/format.ts`
- Create: `apps/web/src/features/stats/DailyChart.tsx`
- Create: `apps/web/src/features/stats/StatsPage.tsx`
- Create: `apps/web/src/features/stats/__tests__/stats-page.test.tsx`
- Modify: `apps/web/src/features/notes/useNotes.ts`（改为从 `lib/useOnlineStatus` 重导出）
- Modify: `apps/web/src/app/router.tsx`、`apps/web/src/app/AppLayout.tsx`
- Modify: `apps/web/test/setup.ts`（`/api/stats` 默认夹具）

**Interfaces:**
- Consumes: Task 1 的 `ReadingStatsDto`/`DailyReadingStatDto`；`apiFetch`；`messageForApiError`
- Produces:

```ts
// api/stats.ts
export const statsQueryKey = ['stats'] as const;
export function fetchStats(): Promise<ReadingStatsDto>;

// lib/useOnlineStatus.ts
export function useOnlineStatus(): boolean;

// features/stats/format.ts
/** 0 → '0 分钟'；59 → '不足 1 分钟'；90 → '1 分钟'；3_600 → '1 小时'；5_400 → '1 小时 30 分钟'。 */
export function formatDuration(seconds: number): string;
/** 柱状图用：0 → '0 分钟'，45 → '不足 1 分钟'，600 → '10 分钟'。 */
export function formatChartDuration(seconds: number): string;
```

- [x] **Step 1: 写失败的页面测试**

`apps/web/src/features/stats/__tests__/stats-page.test.tsx`（沿用 notes 页的 `renderWithProviders` + `createMemoryRouter(routes)` 模式）：
- 默认夹具渲染：标题「统计」、连续天数数字、今日/本周/本月/累计有效/读完的书、最常读的书、时区说明「按 Asia/Shanghai 时区统计」。
- 柱状图有 30 个 `listitem`，每个有无障碍名称（日期 + 分钟），今天那根有「今天」标记。
- 全零夹具显示引导文案「打开一本书，读满 10 分钟就会记下第一天。」但仍显示 30 根柱子。
- `/api/stats` 500 时显示 `role="alert"` 的错误与「重试」按钮；点击后重新请求。
- 离线（`navigator.onLine=false` + offline 事件）显示「离线：显示上次同步的统计」，有缓存数据时继续展示。
- `formatDuration` 边界（0、59、60、3599、3600、3660、5400）。

- [x] **Step 2: 运行确认失败**

Run: `pnpm --filter @bookr/web test -- stats-page`
Expected: FAIL

- [x] **Step 3: 实现 API 与在线状态**

- `fetchStats()` 使用 `apiFetch<ReadingStatsDto>('/api/stats')`（按现有 `apiFetch` 签名调用）。
- 把 `useNotes.ts` 里的 `useOnlineStatus` 原样迁到 `lib/useOnlineStatus.ts`，`useNotes.ts` 改为 `export { useOnlineStatus } from '../../lib/useOnlineStatus';`，避免破坏现有导入。

- [x] **Step 4: 实现统计页**

页面结构（沿用纸墨书房 token：`font-serif`、`text-ink`、`bg-surface`、`border-border`、`text-accent`）：
- 容器 `mx-auto w-full max-w-4xl`，与笔记页一致的内边距。
- 页头：`<h1>统计</h1>` + 副标题「你读过的每一段安静时光」。
- 英雄区：巨大衬线数字 `streakDays` + 「天连续阅读」；下方一行「单日有效阅读满 10 分钟计为一天 · 按 Asia/Shanghai 时区统计」并附 `Link` 到 `/settings`（文案「修改时区」）。
- 统计卡：今日、本周、本月时长；累计有效天数；读完的书。两列（360px）→ 五列（sm+）。
- `DailyChart`：`<figure>` + `<figcaption>`「最近 30 天」；`<ol aria-label="每日阅读时长">`，每项 `<li aria-label="10月19日，23 分钟">`，柱高按 `activeSeconds / max` 计算（非零最小 2px，最大 100%），达标柱 `bg-accent`、未达标 `bg-accent/30`、今天额外描边；底部左侧最早日期、右侧「今天」。
- 最常读的书：书名 + 累计时长；无数据时「还没有最常读的书」。
- 离线、错误、空数据三态如测试所述；`prefers-reduced-motion` 下不加过渡动画。
- 移动端 360px 不出现横向滚动：柱子 `flex-1 min-w-0`，数字用 `text-4xl sm:text-5xl`。

- [x] **Step 5: 路由与夹具**

- `router.tsx` 增加 `{ path: 'stats', element: <StatsPage /> }`。
- `AppLayout.tsx` 的 `NAV_ITEMS` 在「笔记」后加 `{ to: '/stats', label: '统计', end: true }`。
- `test/setup.ts` 增加默认 `GET /api/stats` 夹具（上海、连续 3 天、今日 12 分钟、30 天序列、最常读「深入理解计算机系统」）。

- [x] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @bookr/web test -- stats-page`
Expected: PASS；`pnpm --filter @bookr/web typecheck` 通过。

- [x] **Step 7: 提交**

```bash
git add apps/web/src/api/stats.ts apps/web/src/lib/useOnlineStatus.ts apps/web/src/features/stats apps/web/src/features/notes/useNotes.ts apps/web/src/app apps/web/test/setup.ts
git commit -m "feat(web): add reading statistics page with daily chart"
```

---

### Task 7: 统计时区设置

**Files:**
- Modify: `apps/server/src/auth/routes.ts`
- Create: `apps/web/src/features/settings/timezones.ts`
- Modify: `apps/web/src/api/auth.ts`
- Modify: `apps/web/src/features/settings/SettingsPage.tsx`
- Create: `apps/web/src/features/settings/__tests__/timezone-setting.test.tsx`
- Create: `apps/server/test/profile-timezone.test.ts`
- Modify: `apps/web/test/setup.ts`（`PATCH /api/auth/me` 默认处理器）

**Interfaces:**
- Consumes: Task 1 的 `updateProfileSchema`/`ProfileUpdateDto`；Task 3 的 `rebuildDailyStats(db, userId, timezone)`；`useAuth().refreshUser`；`statsQueryKey`
- Produces:
  - `PATCH /api/auth/me`，请求体 `{ timezone: string }`，成功返回 `ProfileUpdateDto`。
  - `apps/web/src/api/auth.ts`: `export function updateTimezone(timezone: string): Promise<ProfileUpdateDto>`。
  - `apps/web/src/features/settings/timezones.ts`: `export const TIMEZONE_OPTIONS: ReadonlyArray<{ value: string; label: string }>`。

- [x] **Step 1: 写失败的服务端测试**

`apps/server/test/profile-timezone.test.ts`：
- 未登录 401；非法时区 400 `VALIDATION_FAILED`；空白时区 400。
- 合法 `America/New_York` → 200、返回 `{ timezone }`、`users.timezone` 已更新。
- 更新前种入上海时区下的会话与 `daily_stats`；更新为新时区后，`daily_stats` 被按新时区重建（日期/秒数与直接 `rebuildDailyStats` 一致，总量守恒）。

- [x] **Step 2: 运行确认失败**

Run: `TEST_DATABASE_URL=postgres://bookr:bookr@localhost:5432/bookr_stats_read_test pnpm --filter @bookr/server test -- profile-timezone`
Expected: FAIL（404 或校验缺失）

- [x] **Step 3: 实现服务端**

在 `registerAuthRoutes` 中：

```ts
app.patch('/api/auth/me', { preHandler: makeRequireAuth(deps) }, async (request): Promise<ProfileUpdateDto> => {
  const { timezone } = updateProfileSchema.parse(request.body);
  await deps.db.update(users).set({ timezone }).where(eq(users.id, request.user!.id));
  await rebuildDailyStats(deps.db, request.user!.id, timezone);
  return { timezone };
});
```

（`request.user` 的 id 取法与现有 `GET /api/auth/me` 一致。）

- [x] **Step 4: 写失败的设置页测试**

`timezone-setting.test.tsx`：
- 设置页显示「统计时区」与当前值（默认夹具 `Asia/Shanghai`）。
- 选择 `America/New_York` → `PATCH /api/auth/me` 请求体 `{ timezone: 'America/New_York' }`；成功后显示已保存提示并调用 `refreshUser`。
- 保存失败显示 `role="alert"`，选择框保留用户选择以便重试。

- [x] **Step 5: 实现 Web 设置**

- `timezones.ts` 提供至少：`Asia/Shanghai`、`Asia/Hong_Kong`、`Asia/Taipei`、`Asia/Tokyo`、`Asia/Seoul`、`Asia/Singapore`、`Asia/Kolkata`、`Europe/London`、`Europe/Paris`、`Europe/Berlin`、`America/New_York`、`America/Chicago`、`America/Los_Angeles`、`Australia/Sydney`、`UTC`；中文标签。若当前用户时区不在列表，追加一项。
- `SettingsPage` 增加「阅读统计」区：`<label>`「统计时区」+ `<select>`，变更即保存（mutation），成功 `refreshUser()` 与 `invalidateQueries({ queryKey: statsQueryKey })`，并显示「已保存」；失败显示错误。说明文案：「统计按此时区划分自然日，跨时区旅行不会重复计时。」
- `test/setup.ts` 增加默认 `PATCH /api/auth/me` 处理器，回显请求时区。

- [x] **Step 6: 运行测试确认通过**

Run: `TEST_DATABASE_URL=postgres://bookr:bookr@localhost:5432/bookr_stats_read_test pnpm --filter @bookr/server test -- profile-timezone` 与 `pnpm --filter @bookr/web test -- timezone-setting`
Expected: PASS

- [x] **Step 7: 提交**

```bash
git add apps/server/src/auth/routes.ts apps/server/test/profile-timezone.test.ts apps/web/src/features/settings apps/web/src/api/auth.ts apps/web/test/setup.ts
git commit -m "feat: let users choose the timezone used for reading stats"
```

---

### Task 8: E2E、文档与交付记录

**Files:**
- Create: `apps/web/e2e/stats.spec.ts`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-10-18-00-roadmap.md`
- Modify: 本计划（勾选任务、追加交付记录）

**Interfaces:**
- Consumes: `registerFreshReader`、`readerAuth`、`uploadAndRename`、`deleteE2EBooks`、`waitForPdfReady`；`POST /api/sync/push`
- Produces: 统计页的端到端验收。

- [x] **Step 1: 写 E2E**

`stats.spec.ts` 两个用例，均只对 localhost：
1. 注册新读者、上传 `e2e/fixtures/reader.pdf` 并等待就绪；用 `readerAuth` 调 `POST /api/sync/push`，推入今天上海时间 12:00–12:20、`activeSeconds=1200` 的会话；打开 `/stats`，断言「1 天连续阅读」、「今日 20 分钟」、柱状图 30 项、累计有效 1 天。
2. 推入昨天、前天各 15 分钟 + 今天 20 分钟（三个不同会话 id），断言连续 3 天、累计有效 3 天；最常读的书为刚上传的书名。
- `afterEach` 调用 `deleteE2EBooks`。
- 会话构造：用 `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' })` 取今天日期，时间写 `T12:00:00+08:00`；`clientUpdatedAt` 用当前 ISO 时间。
- 失败时截图由 Playwright 默认处理；断言文案与统计页实现一致。

- [x] **Step 2: 运行 E2E**

Run（仅 localhost，按 README 的 E2E 流程）：
`pnpm --filter @bookr/web exec playwright test e2e/stats.spec.ts`
Expected: 2 passed。若栈未启动，按 README 启动 Docker Compose 后再跑。

- [x] **Step 3: 更新文档**

- `README.md` 新增「阅读统计与坚持」：计时口径（可见+前台、2 分钟空闲暂停、30 秒打点）、有效阅读日阈值、时区设置、`GET /api/stats`、`PATCH /api/auth/me`、`reading_session` 同步实体、隐私说明（统计只属于本人）。
- 路线图把 07 标记为「已交付」，补充计划文件链接。
- 在本计划末尾追加「交付记录」：最终测试数字、提交列表、遗留事项。

- [x] **Step 4: 全量验证**

Run:
```bash
pnpm exec turbo run typecheck test
pnpm --filter @bookr/web exec playwright test
```
Expected: turbo 全绿；Playwright 全部通过（含新增 2 条）。

- [x] **Step 5: 提交**

```bash
git add apps/web/e2e/stats.spec.ts README.md docs/superpowers/plans/2026-10-18-00-roadmap.md docs/superpowers/plans/2026-10-19-07-reading-stats.md
git commit -m "test(e2e): cover reading stats and document the P7 delivery"
```

---

## 交付记录

**完成日期：** 2026-10-19

**最终验证：** `pnpm exec turbo run typecheck test` 12/12 成功（Server 360、Web 401、Shared 78、Reader-core 149）；Playwright 18/18（46.4 秒，含新增 2 条统计 E2E）；Docker Compose 四个服务 healthy；`/healthz` 返回 200。

**提交：**

- `a551dd9` feat(shared): add reading stats contracts and session payload
- `b1ffbf7` fix(web): handle reading_session sync entity exhaustively
- `30d05ce` fix(shared): accept ISO timestamps with timezone offsets in reading sessions
- `2ed4e25` feat(server): add reading session tables and timezone date helpers
- `cf7d1ae` fix(server): resolve stat day boundaries for quarter-hour DST offsets
- `3318251` feat(server): ingest reading sessions and aggregate daily stats
- `0685bd7` feat(server): expose read-only reading statistics
- `41408ba` feat(web): track reading time and sync sessions offline
- `e3897d0` feat(web): add reading statistics page with daily chart
- `627f2cd` feat: let users choose the timezone used for reading stats
- 最后一个提交：E2E、README、路线图与本交付记录

**终审修复：** 终审发现并修复 6 项：设备时钟回拨导致会话余量永久丢失（改为累计秒数单调判据）、时区切换与重建非原子（同事务 + 用户锁）、会话 skip 被误计为冲突、跨午夜拆分舍入误差、回收站硬删除后聚合不重算、本地会话回声分支不可达。

**实现要点：** 纯状态机计时（可见+聚焦、2 分钟空闲关闭、30 分钟分段）；`reading_session` 作为只写同步实体，outbox 就地合并心跳；服务端在同步事务内按墙钟比例拆分跨午夜会话并重算受影响自然日；时区变更整表重建；统计接口只读；统计页用 CSS 绘制 30 根无障碍柱。

**遗留与取舍：**

- 子代理账户在波次 3 因 `402 Insufficient Balance` 全部失败，任务改为控制器顺序内联实现；未使用独立子代理做逐任务审查，改为逐任务自检 + 全量回归 + 最终全仓检查。
- `pages_read` 记录的是位置变更次数，仅作原始数据保留，当前统计页不展示。
- 「读完的书」沿用书架的手动状态 `books.status='finished'`。
- 会话心跳每 30 秒写入一次同步日志；90 天保留策略会随日志一起清理，符合预期。
