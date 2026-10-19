# 笔记库与 AI 分析（P6）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 在共享书架上做出一个跨书的全局笔记库：全文检索划线原文与批注、按书/标签/类型/时间筛选、按书分组、跳回原文、就地编辑与删除、导出 Markdown；并能在当前筛选范围（或单本书）上调用 `deepseek-reasoner` 做主题归纳、观点梳理、待办提取，结果流式返回并保存为可回看的分析记录。

**Architecture:** 笔记库是服务端权威的只读视图：`annotations` 内连接 `books`，按 `user_id` 隔离，排除回收站图书与软删除笔记；搜索用 `strpos(lower(...), lower(...))` 做字面量匹配，日期筛选用 `updated_at AT TIME ZONE 用户时区` 解释。导出由服务端生成 Markdown 并带 UTF-8 文件名下载。笔记分析复用 P5 的 AI 网关、配额预占/结算与 SSE 管道：服务端按筛选条件取最多 300 条笔记、按 24k token 预算组装提示词、调用 `reasonerModel`、把结果流式转发并持久化到新表 `note_analyses`。Web 端用 TanStack Query 无限列表呈现笔记库，编辑/删除复用现有 REST 批注端点；跳回原文用 `?note=<annotationId>`，阅读器从本地批注表解析定位器并闪烁高亮。笔记库与 AI 分析都要求联网，不进入 P4 同步日志。

**Tech Stack:** TypeScript strict、Fastify 5、PostgreSQL 16 + Drizzle、Zod 4、Node `fetch`/Web Streams、React 19 + TanStack Query、MSW、Playwright、Docker Compose。

**Spec:** `docs/superpowers/specs/2026-10-18-private-book-reader-design.md`（5.4 笔记与书签、5.5 AI 伴读的「笔记分析」、12 安全与隐私、13 验收标准 6）

## Global Constraints

- TypeScript strict，禁止 `any`；共享契约（`packages/shared`）先于使用方定义。
- 所有笔记查询、导出、分析都按 `user_id` 隔离；他人的笔记与回收站图书的笔记一律不可见。访问他人的分析记录返回 404。
- 服务端日志、错误响应、promptVersion 元数据都不得包含笔记正文或搜索词；分析日志只记录 `userId`、`analysisId`、`kind`、token 数与错误名。
- 搜索是字面量匹配：`%`、`_`、反斜杠、引号、中文与空串都不能改变匹配范围，也不能进入 SQL 拼接。
- 日期筛选按用户时区（`users.timezone`）解释，`from` 与 `to` 都是包含边界的自然日。
- 导出最多 `NOTE_EXPORT_MAX_ITEMS = 5000` 条；超出时导出前 5000 条并在正文说明。
- 笔记库与 AI 分析只在联网时可用；离线时给出明确提示，不破坏 P4 的离线阅读与记笔记。
- 笔记分析复用 P5 的 AI 开关、配置、配额与错误码；关闭 AI 的用户不能分析，配额不足不得调用上游。
- 分析只发送筛选结果中必要的笔记摘录（划线、批注、标签、书名、位置），不发送整本书。
- 不新增运行时依赖。
- 每个任务结束必须 `pnpm exec turbo run typecheck test` 通过并提交。
- E2E 是破坏性测试：只允许 localhost；`E2E_ALLOW_REMOTE=1` 仅用于一次性测试环境，永不对生产运行。AI E2E 依赖 `AI_FAKE_PROVIDER=1`。

## Review Focus

- **搜索字面量**：`q = "100%"`、`q = "_"`、`q = "\\"`、纯空格、超长中文只匹配字面内容；不得返回全量或报 500。
- **筛选与分页组合**：切换关键词/书/标签/时间/类型后，列表从第 1 页重新开始，旧筛选的页不会拼接进来；「加载更多」不重复、不跳过。
- **时区边界**：`Asia/Shanghai` 用户在北京时间 10-19 00:30 更新的笔记，`from=2026-10-19` 必须包含，`to=2026-10-18` 必须排除。
- **导出边界**：结果超 5000 条时截断并说明；中文书名进入 `filename*` 后可被浏览器正确命名；划线中的换行、`#`、`>` 不破坏 Markdown 结构；回收站图书与他人笔记不进入导出。
- **分析失败可恢复**：0 条笔记、超预算、上游失败、用户停止、配额不足都有明确提示；停止后已生成内容保留为 `interrupted`，不丢输入、不重复计费。

---

## 文件结构

**共享**
- 创建 `packages/shared/src/notes.ts`、`packages/shared/src/__tests__/notes.test.ts`
- 修改 `packages/shared/src/index.ts`

**服务端**
- 创建 `apps/server/src/notes/{repo,service,export,routes}.ts`
- 创建 `apps/server/src/notes/{analysis-context,analysis-repo,analysis,analysis-routes}.ts`
- 创建 `apps/server/src/ai/availability.ts`、`apps/server/src/ai/sse.ts`、`apps/server/src/reading/locator-label.ts`
- 修改 `apps/server/src/ai/{chat,prompts,routes}.ts`、`apps/server/src/app.ts`
- 修改 `apps/server/src/db/schema.ts`、`drizzle/0006_notes.sql`、`drizzle/meta/*`
- 创建 `apps/server/test/{notes-schema,notes-list,notes-export,notes-analysis-context,notes-analysis}.test.ts`
- 修改 `apps/server/test/helpers.ts`（新增 `seedNoteAnalysis`）

**Web**
- 创建 `apps/web/src/lib/sse.ts`（从 `features/reader/ai/stream.ts` 提取通用 SSE 解析）
- 修改 `apps/web/src/features/reader/ai/stream.ts`、`apps/web/src/api/ai.ts`（改为从 `lib/sse` 导入）
- 创建 `apps/web/src/api/notes.ts`、`apps/web/src/api/__tests__/notes.test.ts`
- 创建 `apps/web/src/features/notes/{NotesPage,NotesFilterBar,NoteCard,NoteEditDialog,NoteAnalysisPanel,useNotes,useNoteAnalysis,position}.tsx|ts`
- 创建 `apps/web/src/features/notes/__tests__/{notes-page,note-analysis}.test.tsx`
- 修改 `apps/web/src/app/{router,AppLayout}.tsx`、`apps/web/src/features/reader/ReaderPage.tsx`
- 创建 `apps/web/src/features/reader/__tests__/reader-note-jump.test.tsx`
- 修改 `apps/web/test/setup.ts`（`/api/notes`、`/api/notes/tags`、`/api/notes/analyses` 默认 MSW 夹具）

**E2E / 文档**
- 创建 `apps/web/e2e/notes.spec.ts`
- 修改 `README.md`、`docs/superpowers/plans/2026-10-18-00-roadmap.md`

---

## 任务依赖与并发波次

同一波次内的任务文件互不重叠，可以并发执行；不同波次必须等前一波全部通过审查。

1. 波次 1：Task 1（共享契约）
2. 波次 2：Task 2（数据库与迁移）
3. 波次 3（并发）：Task 3（笔记查询/标签/导出）、Task 5（Web API 与 SSE 提取）、Task 8（阅读器笔记跳转）
4. 波次 4（并发）：Task 4（服务端笔记分析）、Task 6（笔记库页面）
5. 波次 5：Task 7（AI 分析面板）
6. 波次 6：Task 9（E2E）
7. 波次 7：Task 10（文档与交付记录）

---

### Task 1: 共享笔记契约

**Files:**
- Create: `packages/shared/src/notes.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/notes.test.ts`

**Interfaces:**
- Consumes: `locatorSchema`/`Locator`（`./locators`）、`MAX_TAG_LENGTH`（`./schemas/reading`）、`AiQuotaWindowDto`/`AiStreamErrorPayload`（`./ai`）、`BookFormat`（`./schemas/books`）
- Produces（后续任务逐字使用）:

```ts
export const NOTE_SEARCH_MAX_LENGTH = 200;
export const NOTE_DEFAULT_PAGE_SIZE = 30;
export const NOTE_MAX_PAGE_SIZE = 100;
export const NOTE_TAG_LIMIT = 100;
export const NOTE_EXPORT_MAX_ITEMS = 5_000;
export const NOTE_ANALYSIS_MAX_NOTES = 300;
export const NOTE_ANALYSIS_TITLE_MAX_LENGTH = 80;

export const NOTE_ANALYSIS_KINDS = ['themes', 'viewpoints', 'todos'] as const;
export type NoteAnalysisKind = (typeof NOTE_ANALYSIS_KINDS)[number];
export const NOTE_ANALYSIS_STATUSES = ['streaming', 'complete', 'interrupted', 'failed'] as const;
export type NoteAnalysisStatus = (typeof NOTE_ANALYSIS_STATUSES)[number];

/** Shared by GET /api/notes, /api/notes/export and POST /api/notes/analyses. */
export interface NoteFilters {
  q?: string;
  bookId?: string;
  tag?: string;
  type?: 'highlight' | 'note';
  from?: string; // YYYY-MM-DD, inclusive, interpreted in the user's timezone
  to?: string;   // YYYY-MM-DD, inclusive
}
export const noteFiltersSchema: z.ZodType<NoteFilters>;
export type NoteListQuery = NoteFilters & { page: number; pageSize: number };
export const noteListQuerySchema: z.ZodType<NoteListQuery>; // coerce page/pageSize, defaults 1/30
export const noteAnalysisRequestSchema: z.ZodType<{ kind: NoteAnalysisKind; filters?: NoteFilters }>;

export interface NoteBookRef { id: string; title: string; author: string | null; format: BookFormat }
export interface NoteDto {
  id: string;
  book: NoteBookRef;
  type: 'highlight' | 'note';
  color: 'yellow' | 'green' | 'blue' | 'pink' | 'purple'; // AnnotationColor
  locator: Locator;
  selectedText: string;
  noteText: string | null;
  tags: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface NoteListResponse { items: NoteDto[]; total: number; page: number; pageSize: number }
export interface NoteTagCount { tag: string; count: number }

export interface NoteAnalysisSummaryDto {
  id: string;
  kind: NoteAnalysisKind;
  status: NoteAnalysisStatus;
  title: string;
  noteCount: number;
  analyzedCount: number;
  createdAt: string;
  updatedAt: string;
}
export interface NoteAnalysisDto extends NoteAnalysisSummaryDto {
  content: string;
  model: string | null;
  promptVersion: string | null;
  scope: NoteFilters;
}
export interface NoteAnalysisStreamMeta {
  analysisId: string;
  kind: NoteAnalysisKind;
  model: string;
  promptVersion: string;
  noteCount: number;
  analyzedCount: number;
}
export interface NoteAnalysisStreamDone {
  analysisId: string;
  usage: { promptTokens: number; completionTokens: number };
  quota: { daily: AiQuotaWindowDto; monthly: AiQuotaWindowDto };
}
export const NOTE_ANALYSIS_STREAM_EVENTS = ['meta', 'delta', 'done', 'error'] as const;
```

- `noteFiltersSchema` trims `q`/`tag`, rejects `q` longer than 200 and `tag` longer than `MAX_TAG_LENGTH`, requires `bookId` to be a UUID, validates `from`/`to` with `z.iso.date()`, and rejects `from > to` with the issue path `['to']` and message `'to must not be before from'`.
- `noteListQuerySchema` uses `z.coerce.number()` for `page` (min 1, default 1) and `pageSize` (min 1, max `NOTE_MAX_PAGE_SIZE`, default `NOTE_DEFAULT_PAGE_SIZE`), and applies the same date-range rule.
- `noteAnalysisRequestSchema` = `{ kind: z.enum(NOTE_ANALYSIS_KINDS), filters: noteFiltersSchema.optional() }`.
- `AnnotationColor` is already exported from `./schemas/reading`; import the type rather than re-spelling the union if the export exists.

- [x] **Step 1: Write the failing tests**

`packages/shared/src/__tests__/notes.test.ts`:

```ts
it('accepts an empty filter object and trims search text')
// noteFiltersSchema.parse({}) → {}
// parse({ q: '  张三  ' }) → { q: '张三' }

it('rejects an inverted date range')
// parse({ from: '2026-10-19', to: '2026-10-18' }) throws with path ['to']

it('caps the search term at 200 characters')
// 'a'.repeat(201) throws

it('defaults list paging and coerces query strings')
// noteListQuerySchema.parse({}) → { page: 1, pageSize: 30 }
// parse({ page: '2', pageSize: '50' }) → { page: 2, pageSize: 50 }
// parse({ pageSize: '101' }) throws

it('validates analysis requests')
// { kind: 'themes' } parses; { kind: 'unknown' } throws
// { kind: 'todos', filters: { tag: '方法论' } } parses
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bookr/shared test -- notes`
Expected: FAIL because `../src/notes` does not exist.

- [x] **Step 3: Implement `packages/shared/src/notes.ts` and export it**

Add `export * from './notes';` to `packages/shared/src/index.ts`. Keep the exported names exactly as listed above.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @bookr/shared test -- notes`
Expected: PASS.

- [x] **Step 5: Typecheck and commit**

```bash
pnpm exec turbo run typecheck --filter=@bookr/shared
git add packages/shared/src/notes.ts packages/shared/src/index.ts packages/shared/src/__tests__/notes.test.ts
git commit -m "feat(shared): add notes library contracts"
```

---

### Task 2: 数据库表与索引

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Create: `apps/server/drizzle/0006_notes.sql`（由 `drizzle-kit generate` 生成，并提交 `drizzle/meta/*`）
- Test: `apps/server/test/notes-schema.test.ts`

**Interfaces:**
- Consumes: `NoteAnalysisKind`/`NoteAnalysisStatus`/`NoteFilters`（`@bookr/shared`）
- Produces: `noteAnalyses` 表、`NoteAnalysisRow = typeof noteAnalyses.$inferSelect`，以及 `annotations` 上的两个新索引

新增表（字段名与默认值必须逐字一致）：

```ts
export const noteAnalyses = pgTable(
  'note_analyses',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<NoteAnalysisKind>().notNull(),
    title: text('title').notNull(),
    status: text('status').$type<NoteAnalysisStatus>().notNull(),
    scope: jsonb('scope').$type<NoteFilters>().notNull(),
    noteCount: integer('note_count').notNull(),
    analyzedCount: integer('analyzed_count').notNull(),
    content: text('content').notNull().default(''),
    model: text('model'),
    promptVersion: text('prompt_version'),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('note_analyses_user_created_idx').on(table.userId, table.createdAt)],
);
export type NoteAnalysisRow = typeof noteAnalyses.$inferSelect;
```

`annotations` 的索引数组追加：

```ts
index('annotations_user_updated_idx').on(table.userId, table.updatedAt),
index('annotations_tags_idx').using('gin', table.tags),
```

预期 SQL（生成结果应等价）：

```sql
CREATE TABLE "note_analyses" (
  "id" uuid PRIMARY KEY NOT NULL,
  "user_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "status" text NOT NULL,
  "scope" jsonb NOT NULL,
  "note_count" integer NOT NULL,
  "analyzed_count" integer NOT NULL,
  "content" text DEFAULT '' NOT NULL,
  "model" text,
  "prompt_version" text,
  "prompt_tokens" integer DEFAULT 0 NOT NULL,
  "completion_tokens" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "note_analyses_user_created_idx" ON "note_analyses" USING btree ("user_id","created_at");
CREATE INDEX "annotations_user_updated_idx" ON "annotations" USING btree ("user_id","updated_at");
CREATE INDEX "annotations_tags_idx" ON "annotations" USING gin ("tags");
ALTER TABLE "note_analyses" ADD CONSTRAINT "note_analyses_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
```

- [x] **Step 1: Write the failing test**

`apps/server/test/notes-schema.test.ts`:

```ts
it('stores analysis rows with streaming defaults')
// resetDb(); seedUser + insert noteAnalyses({status:'streaming', kind:'themes', title, scope:{}, noteCount:3, analyzedCount:3})
// row.content === '', row.promptTokens === 0, row.completionTokens === 0, row.createdAt instanceof Date

it('cascades analyses when their owner is deleted')
// insert analysis, then testDb.delete(users).where(eq(users.id, userId))
// select from noteAnalyses → []

it('creates the note search indexes')
// SELECT indexname FROM pg_indexes WHERE schemaname='public'
// contains annotations_user_updated_idx and annotations_tags_idx
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bookr/server test -- notes-schema`
Expected: FAIL because `noteAnalyses` is not exported.

- [x] **Step 3: Add the schema and generate the migration**

```bash
cd apps/server
pnpm exec drizzle-kit generate --name notes
```

提交 `drizzle/0006_notes.sql` 与 `drizzle/meta/0006_snapshot.json`、`drizzle/meta/_journal.json`。生成器超过 2 分钟无输出时，停止它并在报告中标记 BLOCKED；不要手改 snapshot。

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @bookr/server test -- notes-schema`
Expected: PASS.

- [x] **Step 5: Typecheck and commit**

```bash
pnpm exec turbo run typecheck --filter=@bookr/server
git add apps/server/src/db/schema.ts apps/server/drizzle apps/server/test/notes-schema.test.ts
git commit -m "feat(server): add note analyses table and note indexes"
```

---

### Task 3: 笔记查询、标签与 Markdown 导出

**Files:**
- Create: `apps/server/src/reading/locator-label.ts`
- Modify: `apps/server/src/ai/prompts.ts`（改为从 `../reading/locator-label` 导入并重新导出 `describeLocator`）
- Create: `apps/server/src/notes/{repo,service,export,routes}.ts`
- Modify: `apps/server/src/app.ts`（注册 `registerNotesRoutes`）
- Test: `apps/server/test/notes-list.test.ts`、`apps/server/test/notes-export.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `NoteFilters`/`NoteListQuery`/`NoteDto`/`NoteListResponse`/`NoteTagCount`/`NOTE_EXPORT_MAX_ITEMS`/`NOTE_TAG_LIMIT`；Task 2 的 `noteAnalyses`（本任务不用）；现有 `annotations`、`books`、`users` 表与 `makeRequireAuth`
- Produces（Task 4 与 Web 任务使用）:

```ts
// apps/server/src/reading/locator-label.ts
export function describeLocator(locator: Locator | undefined): string;
// pdf → `第 12 页（全书 40%）`；reflow → `源页 7（全书 50%）`；epub → `全书 42%`；undefined → `未提供位置`

// apps/server/src/notes/repo.ts
export interface NoteQueryRow {
  annotation: AnnotationRow;
  book: { id: string; title: string; author: string | null; format: BookFormat };
}
export async function listNotePage(
  db: Database,
  input: { userId: string; timezone: string; filters: NoteFilters; page: number; pageSize: number },
): Promise<{ rows: NoteQueryRow[]; total: number }>;
// 导出排序：books.title ASC, annotations.created_at ASC
export async function listNotesForExport(
  db: Database,
  input: { userId: string; timezone: string; filters: NoteFilters; limit: number },
): Promise<{ rows: NoteQueryRow[]; total: number }>;
// ORDER BY annotations.updated_at DESC, id DESC；供 AI 分析使用
export async function listNotesForAnalysis(
  db: Database,
  input: { userId: string; timezone: string; filters: NoteFilters; limit: number },
): Promise<{ rows: NoteQueryRow[]; total: number }>;
export async function listNoteTagCounts(db: Database, userId: string): Promise<NoteTagCount[]>;
export async function loadUserTimezone(db: Database, userId: string): Promise<string>; // missing user → AppError(404, NOT_FOUND)

// apps/server/src/notes/service.ts
export function toNoteDto(row: NoteQueryRow): NoteDto;
export async function listNotes(deps: AppDeps, userId: string, query: NoteListQuery): Promise<NoteListResponse>;
export async function listNoteTags(deps: AppDeps, userId: string): Promise<NoteTagCount[]>;
export async function exportNotes(
  deps: AppDeps,
  userId: string,
  filters: NoteFilters,
): Promise<{ markdown: string; filename: string; total: number; truncated: boolean }>;

// apps/server/src/notes/export.ts
export function buildNotesMarkdown(input: {
  notes: NoteQueryRow[];
  total: number;
  truncated: boolean;
  generatedAt: Date;
  timezone: string;
}): string;
export function notesExportFilename(input: {
  bookTitle: string | null;
  generatedAt: Date;
  timezone: string;
}): string;
```

**查询规则（逐字实现）：**

- 过滤条件固定包含：`annotations.user_id = userId`、`annotations.deleted_at IS NULL`、`books.deleted_at IS NULL`。
- `q`：`strpos(lower(annotations.selected_text), lower(q)) > 0 OR strpos(lower(coalesce(annotations.note_text, '')), lower(q)) > 0`；trim 后为空字符串时视为未提供。
- `tag`：`annotations.tags @> ARRAY[tag]::text[]`。
- `type`：`annotations.type = type`。
- `from`/`to`：`(annotations.updated_at AT TIME ZONE timezone)::date >= from::date`，`to` 同理用 `<=`。
- 排序：`annotations.updated_at DESC, annotations.id DESC`；分页用 `limit/offset`；`total` 用同一 `WHERE` 的 `count(*)`。
- 导出排序：`books.title ASC, annotations.created_at ASC`；`limit = NOTE_EXPORT_MAX_ITEMS`；`total` 为完整计数；`truncated = total > NOTE_EXPORT_MAX_ITEMS`。
- 标签计数：只统计上述可见笔记；`unnest(tags)` 后 `GROUP BY`，按 `count DESC, tag ASC` 排序，`limit = NOTE_TAG_LIMIT`。

**路由（`registerNotesRoutes(app, deps)`，全部 `preHandler: requireAuth`）：**

- `GET /api/notes` → `noteListQuerySchema.parse(request.query)` → `NoteListResponse`。
- `GET /api/notes/tags` → `{ items: NoteTagCount[] }`。
- `GET /api/notes/export` → `noteFiltersSchema.parse(request.query)`；响应体 `text/markdown; charset=utf-8`，头 `cache-control: no-store`，`content-disposition: attachment; filename="notes-YYYY-MM-DD.md"; filename*=UTF-8''<encoded>`。

**Markdown 格式（`buildNotesMarkdown`，测试按此断言）：**

```markdown
# 笔记库

导出时间：2026-10-19
共 12 条笔记

## 《深入理解计算机系统》 · Randal E. Bryant

### 第 12 页（全书 40%）

> 原文第一行
> 原文第二行

批注文字（没有批注时整段省略）

标签：#历史 #方法论（没有标签时整行省略）

*2026-10-18*

---
```

- 书名行：有作者时 `## 《书名》 · 作者`，无作者时 `## 《书名》`。
- 划线原文按行加 `> `；空行保留为 `>`。
- 每条笔记之间用空行 + `---` + 空行分隔；文件末尾保留一个换行。
- `truncated` 为真时，在「共 N 条笔记」后追加一行：`仅导出前 5000 条（按书名与阅读时间排序）。`
- 日期用 `Intl.DateTimeFormat('en-CA', { timeZone: timezone, year:'numeric', month:'2-digit', day:'2-digit' })` 生成 `YYYY-MM-DD`（`en-CA` 输出即 ISO 形式；若运行时输出顺序不同，用 `formatToParts` 拼接）。
- 文件名：单本筛选（`filters.bookId` 且能读到书名）为 `笔记-<书名>-YYYYMMDD.md`，否则 `笔记库-YYYYMMDD.md`。书名中的 `[\\/:*?"<>|]` 与控制字符替换为 `_`，压缩空白，截断到 50 字符；结果为空则用 `笔记库`。`filename*` 用 `encodeURIComponent` 后再把 `'()*` 转成百分号编码。

- [x] **Step 1: Write the failing list tests**

`apps/server/test/notes-list.test.ts`，至少覆盖：

```ts
it("lists only the caller's live notes on live books, newest first")
// alice 两条、bob 一条；alice 一条 deletedAt 非空；一本书 deletedAt 非空
// GET /api/notes as alice → items 只含 alice 的两条可见笔记，book.title 正确，按 updatedAt 降序

it('searches selected text and note text literally')
// 笔记 A selectedText '进度 100% 完成'，笔记 B selectedText '进度 1000 完成'
// q=100% → 只返回 A；q=_ → 0 条；q='  '（被 trim 成空）→ 返回全部；q='PROGRESS' 命中 selectedText 'progress'

it('filters by book, tag and type')
// bookId、tag='方法论'、type='note' 分别与组合生效

it('interprets date filters in the user timezone')
// 用户 timezone Asia/Shanghai，笔记 updatedAt = 2026-10-18T16:30:00Z（北京 10-19 00:30）
// from=2026-10-19 → 命中；from=2026-10-18&to=2026-10-18 → 不命中

it('paginates without duplicates')
// 5 条笔记，pageSize=2：page1/page2/page3 的 id 并集为 5 且互不重复，total=5

it('returns tag counts ordered by frequency')
// GET /api/notes/tags → [{ tag:'方法论', count:2 }, ...]，排除他人/回收站笔记
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bookr/server test -- notes-list`
Expected: FAIL（路由 404）。

- [x] **Step 3: Implement repo/service/routes and register them**

在 `apps/server/src/app.ts` 的 `registerReadingRoutes` 之后加入 `registerNotesRoutes(app, deps);`。注意 `describeLocator` 移动后，`apps/server/test/ai-context.test.ts` 里从 `../src/ai/prompts` 的导入必须仍然可用（`prompts.ts` 重新导出）。

- [x] **Step 4: Run list tests to verify they pass**

Run: `pnpm --filter @bookr/server test -- notes-list`
Expected: PASS.

- [x] **Step 5: Write the failing export tests**

`apps/server/test/notes-export.test.ts`：

```ts
it('exports grouped Markdown with book, position, quote, note, tags and date')
// GET /api/notes/export：断言 content-type 含 text/markdown
// 正文含 `## 《书名》`、`### 第 12 页（全书 40%）`、`> 原文`、批注、`标签：#历史 #方法论`、`*2026-10-18*`

it('applies filters and excludes other members and trashed books')
// q/tag/bookId 组合；bob 的笔记与回收站图书的笔记不出现

it('caps the export and says so')
// 直接测 buildNotesMarkdown({ notes: 2 条, total: 6000, truncated: true, ... })
// 含 `仅导出前 5000 条`

it('sets a UTF-8 filename in content-disposition')
// 单本筛选且书名 '深入 理解/系统' → filename*=UTF-8''... 解码后为 `笔记-深入 理解_系统-20261019.md`
// ASCII 回退 filename="notes-2026-10-19.md"

it('requires authentication')
// 无 token → 401
```

- [x] **Step 6: Run export tests to verify they fail**

Run: `pnpm --filter @bookr/server test -- notes-export`
Expected: FAIL.

- [x] **Step 7: Implement the export builder, route and headers**

- [x] **Step 8: Run both test files to verify they pass**

Run: `pnpm --filter @bookr/server test -- notes-list notes-export`
Expected: PASS.

- [x] **Step 9: Typecheck and commit**

```bash
pnpm exec turbo run typecheck --filter=@bookr/server
git add apps/server/src/notes apps/server/src/reading/locator-label.ts apps/server/src/ai/prompts.ts apps/server/src/app.ts apps/server/test/notes-list.test.ts apps/server/test/notes-export.test.ts
git commit -m "feat(server): add notes library query, tags and markdown export"
```

---

### Task 4: 服务端笔记分析

**Files:**
- Create: `apps/server/src/notes/analysis-context.ts`
- Create: `apps/server/src/notes/analysis-repo.ts`
- Create: `apps/server/src/notes/analysis.ts`
- Create: `apps/server/src/notes/analysis-routes.ts`
- Create: `apps/server/src/ai/availability.ts`
- Create: `apps/server/src/ai/sse.ts`（把 `chat.ts` 的 `writeFrame` 与 `ai/routes.ts` 的 `SSE_HEADERS` 移入）
- Modify: `apps/server/src/ai/{chat,routes}.ts`、`apps/server/src/app.ts`
- Modify: `apps/server/test/helpers.ts`（新增 `seedNoteAnalysis`）
- Test: `apps/server/test/notes-analysis-context.test.ts`、`apps/server/test/notes-analysis.test.ts`

**Interfaces:**
- Consumes: Task 1 的分析 DTO/常量；Task 2 的 `noteAnalyses`/`NoteAnalysisRow`；Task 3 的 `listNotesForAnalysis`、`NoteQueryRow`、`describeLocator`；P5 的 `readAiConfig`、`estimateTokens`、`reserveQuota`/`settleQuota`/`releaseQuota`、`AppError`、`deps.aiClientFactory`、`deps.clock`
- Produces（Web 端按此实现）:

```ts
// apps/server/src/ai/availability.ts
export interface AiActor { userId: string; timezone: string; limits: QuotaLimits }
export async function requireAiActor(deps: AppDeps, userId: string): Promise<AiActor>;
// 用户不存在 → AppError(404, NOT_FOUND)；ai_enabled=false → AppError(403, AI_DISABLED)
export async function requireAiConfig(deps: AppDeps): Promise<AiRuntimeConfig>;
// 无可用配置/密钥 → AppError(503, AI_NOT_CONFIGURED, { reason: 'missing_config' })

// apps/server/src/notes/analysis-context.ts
export const NOTE_ANALYSIS_PROMPT_VERSION = 'p6.1';
export const NOTE_ANALYSIS_TOKEN_BUDGET = 24_000;
export const NOTE_ANALYSIS_MAX_OUTPUT_TOKENS = 4_096;
export interface AnalysisSourceNote {
  bookTitle: string;
  bookAuthor: string | null;
  locator: Locator;
  selectedText: string;
  noteText: string | null;
  tags: string[];
  createdAt: Date;
}
export function buildAnalysisPrompt(input: {
  kind: NoteAnalysisKind;
  notes: AnalysisSourceNote[]; // 最新在前
  total: number;
}): { messages: AiChatMessage[]; promptTokens: number; analyzedCount: number };
export function analysisSystemPrompt(kind: NoteAnalysisKind): string;
export function analysisTitle(kind: NoteAnalysisKind, bookTitle: string | null): string;

// apps/server/src/notes/analysis-repo.ts
export async function insertAnalysis(tx: Transaction, input: {
  userId: string; kind: NoteAnalysisKind; title: string; scope: NoteFilters;
  noteCount: number; analyzedCount: number; model: string; promptVersion: string; now: Date;
}): Promise<NoteAnalysisRow>;
// status 固定写 'streaming'，content 为空，token 默认为 0
export async function updateAnalysis(tx: Transaction, id: string, patch: {
  content?: string; status?: NoteAnalysisStatus; promptTokens?: number; completionTokens?: number;
}, now: Date): Promise<void>;
export async function listAnalysisRows(db: Database, userId: string, limit: number): Promise<NoteAnalysisRow[]>;
// WHERE status <> 'streaming'，ORDER BY created_at DESC，默认 limit 20
export async function findAnalysisRow(db: Database, userId: string, id: string): Promise<NoteAnalysisRow | undefined>;
export async function deleteAnalysisRow(db: Database, userId: string, id: string): Promise<boolean>;

// apps/server/src/notes/analysis.ts
export interface NoteAnalysisSink {
  meta(meta: NoteAnalysisStreamMeta): Promise<void>;
  delta(text: string): Promise<void>;
  done(done: NoteAnalysisStreamDone): Promise<void>;
  error(payload: AiStreamErrorPayload): Promise<void>;
}
export async function prepareNoteAnalysis(
  deps: AppDeps, userId: string,
  body: { kind: NoteAnalysisKind; filters?: NoteFilters },
): Promise<PreparedNoteAnalysis>;
export interface PreparedNoteAnalysis {
  userId: string; analysisId: string; kind: NoteAnalysisKind; model: string; promptVersion: string;
  client: AiClient; messages: AiChatMessage[]; promptTokens: number;
  reservation: QuotaReservation; timezone: string; limits: QuotaLimits;
  noteCount: number; analyzedCount: number;
}
export async function executeNoteAnalysis(
  deps: AppDeps, prepared: PreparedNoteAnalysis, sink: NoteAnalysisSink,
  signal: AbortSignal, logger?: { info(f: Record<string, unknown>, m: string): void; error(f: Record<string, unknown>, m: string): void },
): Promise<void>;
```

**端点（`registerNoteAnalysisRoutes(app, deps)`，全部 `preHandler: requireAuth`）：**

- `POST /api/notes/analyses`：body `noteAnalysisRequestSchema`；`bodyLimit: 262_144`；SSE 头与 P5 一致；`reply.hijack()`；`raw.on('close')` 与 `request.raw.on('aborted')` 触发 `AbortController.abort()`；`finally` 中若未结束则 `raw.end()`。
- `GET /api/notes/analyses` → `{ items: NoteAnalysisSummaryDto[] }`（仅 `complete`/`interrupted`/`failed`，最多 20 条）。
- `GET /api/notes/analyses/:id` → `{ analysis: NoteAnalysisDto }`；他人或不存在 → 404。
- `DELETE /api/notes/analyses/:id` → 204；他人或不存在 → 404。

**上下文与提示词规则：**

- 取数：`listNotesForAnalysis(db, { userId, timezone, filters: body.filters ?? {}, limit: NOTE_ANALYSIS_MAX_NOTES })`，结果按 `updated_at DESC`，即最新在前；`noteCount = total`。`total === 0` → `AppError(400, VALIDATION_FAILED, { reason: 'no_notes' })`，不预占配额。
- 每条笔记渲染：

```text
[n] 《书名》 · 第 12 页（全书 40%）
划线：<selectedText 最多 600 字，超出加 …>
批注：<noteText 最多 400 字，无则省略该行>
标签：历史、方法论（无则省略该行）
时间：2026-10-18
```

- 预算：系统提示词先计入 `promptTokens`；随后按「最新在前」逐条加入，直到再加一条会超过 `NOTE_ANALYSIS_TOKEN_BUDGET`；`analyzedCount` 为实际条数；把入选笔记反转为时间正序后重新编号（`[1]` 是最早的一条）。
- 用户消息开头：`共 ${total} 条笔记，以下按阅读时间顺序列出 ${analyzedCount} 条。`；`analyzedCount < total` 时追加 `较早的其余笔记因篇幅未列入。`
- 三种 `kind` 的系统提示词都必须：只依据给定笔记、引用书名与编号、使用中文 Markdown、不要编造、不要复述全部原文。具体分工：
  - `themes`（主题归纳）：3–7 个主题，每个主题下列出对应编号与一句话概括，最后指出贯穿主线。
  - `viewpoints`（观点梳理）：区分「原文观点」与「我的批注」，列出分歧、疑问与可继续追问的点。
  - `todos`（待办提取）：提取可执行行动，每条含理由与关联编号；没有待办时明确说「这批笔记里没有可执行的待办」。
- 标题：`analysisTitle('themes', '深入理解计算机系统')` → `《深入理解计算机系统》主题归纳`；无书名 → `笔记主题归纳`；三种标签分别为 `主题归纳`、`观点梳理`、`待办提取`；总长截断到 `NOTE_ANALYSIS_TITLE_MAX_LENGTH`。
- 模型：`aiConfig.reasonerModel`；`maxTokens = NOTE_ANALYSIS_MAX_OUTPUT_TOKENS`，`temperature = 0.3`。
- 配额：`estimate = promptTokens + NOTE_ANALYSIS_MAX_OUTPUT_TOKENS`；`reserveQuota` 失败直接抛 429，不写 `note_analyses`。插入 `status='streaming'`、`content=''`；插入失败要 `releaseQuota`。

**执行规则（与 P5 `executeChat` 同构）：**

- 先发 `meta`；随后逐 delta 累积并下发 `delta`。
- 正常结束：`settleQuota` 一次 → 事务更新行 `content/status='complete'/promptTokens/completionTokens` → 发 `done`。
- 上游失败：信号已 abort 记 `interrupted`，否则记 `failed`；两种情况都保存已生成内容、结算一次；未 abort 时下发固定文案的 `error` 帧（复用 P5 的 `AI_TIMEOUT`/`AI_UPSTREAM_FAILED` 判定与文案）。
- 日志只含 `userId`、`analysisId`、`kind`、`promptTokens`、`completionTokens`、`aborted`、`errorName`。
- `ai/sse.ts` 导出 `SSE_HEADERS` 与 `writeSseFrame(raw, event, data, onBackpressure?)`；`chat.ts` 改为导入它们，行为不变（P5 的 `ai-chat.test.ts` 必须继续通过），并改用 `requireAiActor`/`requireAiConfig` 做前置校验。

- [x] **Step 1: Write the failing context tests**

`apps/server/test/notes-analysis-context.test.ts`：

```ts
it('numbers notes chronologically and reports the analyzed count')
// 3 条最新在前的笔记 → 用户消息中 [1] 是最早的一条，analyzedCount=3

it('drops the oldest notes when the token budget is exceeded')
// 构造超预算的笔记（每条约 1500 字中文），budget=24k
// analyzedCount < total；用户消息含 `较早的其余笔记因篇幅未列入。`
// estimateTokens(所有 messages 内容之和) <= NOTE_ANALYSIS_TOKEN_BUDGET + 400（系统提示词余量）

it('asks for the right output per kind')
// themes 含 `主题归纳`；viewpoints 含 `原文观点` 与 `我的批注`；todos 含 `待办`
// 三者都含 `只依据` 或等价的「不要编造」约束

it('builds a bounded title')
// analysisTitle('themes', '一本书'.repeat(60)).length === 80
```

- [x] **Step 2: Run context tests to verify they fail**

Run: `pnpm --filter @bookr/server test -- notes-analysis-context`
Expected: FAIL.

- [x] **Step 3: Implement analysis-context.ts and make the context tests pass**

Run: `pnpm --filter @bookr/server test -- notes-analysis-context`
Expected: PASS.

- [x] **Step 4: Write the failing analysis route tests**

`apps/server/test/notes-analysis.test.ts`，使用 `createTestApp(..., { aiClientFactory: () => fake })` + 真实监听（同 `ai-chat.test.ts`）：

```ts
it('streams an analysis and persists it')
// 用户 + 书 + 2 条笔记；POST { kind:'themes' }
// SSE: meta(noteCount=2, analyzedCount=2, model='deepseek-reasoner', promptVersion='p6.1') → delta... → done
// 响应正文拼接包含 FakeAiClient 默认回复
// note_analyses 行 status='complete'、content 等于回复、title='《书名》主题归纳'、promptTokens>0

it('only analyses notes inside the requested filters')
// 两条笔记不同 tag；filters { tag:'方法论' } → meta.noteCount=1，且 fake.lastRequest 的消息只含该笔记的原文

it('rejects an empty scope before reserving quota')
// 无笔记 → 400 VALIDATION_FAILED，details.reason='no_notes'；ai_usage 表无行

it('enforces the AI switch and configuration')
// ai_enabled=false → 403 AI_DISABLED；无配置 → 503 AI_NOT_CONFIGURED

it('refuses before calling upstream when quota is exhausted')
// 用户 daily limit 0 → 429 AI_QUOTA_EXCEEDED；fake.lastRequest === null

it('keeps partial content when the client aborts')
// FakeAiClient({ delayMs: 20 })，读取一帧后 AbortController.abort()
// 行 status='interrupted' 且 content 非空；ai_usage 有结算

it("hides another member's analyses")
// bob GET/DELETE alice 的 id → 404；GET /api/notes/analyses 列表只含自己的
```

- [x] **Step 5: Run analysis tests to verify they fail**

Run: `pnpm --filter @bookr/server test -- notes-analysis`
Expected: FAIL.

- [x] **Step 6: Implement availability, sse extraction, analysis repo/service/routes, and register**

在 `app.ts` 中 `registerNotesRoutes` 之后加入 `registerNoteAnalysisRoutes(app, deps);`。在 `helpers.ts` 增加：

```ts
export async function seedNoteAnalysis(input: {
  userId: string; kind?: NoteAnalysisKind; status?: NoteAnalysisStatus;
  title?: string; content?: string; noteCount?: number; analyzedCount?: number;
  createdAt?: Date; updatedAt?: Date;
}): Promise<NoteAnalysisRow>;
```

- [x] **Step 7: Run the full AI + notes server suites**

Run: `pnpm --filter @bookr/server test -- notes-analysis ai-chat`
Expected: PASS（证明 SSE 提取没有破坏 P5）。

- [x] **Step 8: Typecheck and commit**

```bash
pnpm exec turbo run typecheck --filter=@bookr/server
git add apps/server/src/notes apps/server/src/ai apps/server/src/app.ts apps/server/test/notes-analysis-context.test.ts apps/server/test/notes-analysis.test.ts apps/server/test/helpers.ts
git commit -m "feat(server): add streaming note analysis with quota and persistence"
```

---

### Task 5: Web API 客户端与 SSE 提取

**Files:**
- Create: `apps/web/src/lib/sse.ts`
- Modify: `apps/web/src/features/reader/ai/stream.ts`（改为从 `../../lib/sse` 导入并重新导出）
- Modify: `apps/web/src/api/ai.ts`（从 `../../lib/sse` 导入解析器）
- Create: `apps/web/src/api/notes.ts`
- Test: `apps/web/src/api/__tests__/notes.test.ts`

**Interfaces:**
- Consumes: Task 1 的所有笔记契约；现有 `apiFetch`、`authorizedFetch`、`errorFromResponse`
- Produces（Task 6/7 使用）:

```ts
// apps/web/src/lib/sse.ts
export interface SseFrame { event: string; data: string }
export class SseProtocolError extends Error { name = 'SseProtocolError' }
export function createSseParser(onFrame: (frame: SseFrame) => void): { push(chunk: string): void; flush(): void };
export async function readSseStream(stream: ReadableStream<Uint8Array>, onFrame: (frame: SseFrame) => void): Promise<void>;

// apps/web/src/api/notes.ts
export function notesQueryKey(filters: NoteFilters): readonly ['notes', NoteFilters];
export function buildNotesQueryString(query: NoteFilters & { page?: number; pageSize?: number }): string;
export async function fetchNotes(query: NoteFilters & { page?: number; pageSize?: number }): Promise<NoteListResponse>;
export async function fetchNoteTags(): Promise<NoteTagCount[]>;
export async function downloadNotesExport(filters: NoteFilters): Promise<{ blob: Blob; filename: string }>;
export function filenameFromDisposition(header: string | null): string | null; // 优先解析 filename*，其次 filename

export interface NoteAnalysisStreamHandlers {
  onMeta(meta: NoteAnalysisStreamMeta): void;
  onDelta(text: string): void;
  onDone(done: NoteAnalysisStreamDone): void;
  onError(payload: AiStreamErrorPayload): void;
}
export async function streamNoteAnalysis(
  body: { kind: NoteAnalysisKind; filters?: NoteFilters },
  handlers: NoteAnalysisStreamHandlers,
  options?: { signal?: AbortSignal },
): Promise<void>;
export async function fetchNoteAnalyses(): Promise<NoteAnalysisSummaryDto[]>;
export async function fetchNoteAnalysis(id: string): Promise<NoteAnalysisDto>;
export async function deleteNoteAnalysis(id: string): Promise<void>;
```

**规则：**

- `buildNotesQueryString` 省略空字符串/undefined 的 `q`、`bookId`、`tag`、`type`、`from`、`to`；`q` 先 trim；只有传入非空 `page`/`pageSize` 时才带分页参数。
- `downloadNotesExport` 用 `authorizedFetch('/api/notes/export?...')`，返回 `response.blob()` 与 `filenameFromDisposition(response.headers.get('content-disposition')) ?? '笔记库.md'`。
- `streamNoteAnalysis` 与 `streamAiChat` 同构：POST JSON、非 ok 已由 `authorizedFetch` 抛出；无 `response.body` 或流结束时没有收到 `done`/`error` 帧都抛 `SseProtocolError('AI 流意外结束')`；`error` 帧交给 `onError` 后正常返回；abort 的 `AbortError` 原样抛出。
- 事件名只处理 `meta`/`delta`/`done`/`error`，未知事件忽略。
- 把 SSE 解析器移到 `lib/sse.ts` 后，`features/reader/ai/stream.ts` 保留 `AiStreamProtocolError` 这个类名作为 `SseProtocolError` 的别名导出，避免改动 P5 的调用方与测试。

- [x] **Step 1: Write the failing tests**

`apps/web/src/api/__tests__/notes.test.ts`（使用 MSW 或 `vi.stubGlobal('fetch')`，与现有 API 测试保持一致）：

```ts
it('omits blank filters and trims the search term')
// buildNotesQueryString({ q:' 狐狸 ', bookId:'', tag:undefined }) → 'q=%E7%8B%90%E7%8B%B8'

it('includes paging only when asked')
// buildNotesQueryString({ page: 2, pageSize: 30 }) → 'page=2&pageSize=30'

it('parses the UTF-8 export filename')
// filenameFromDisposition(`attachment; filename="notes.md"; filename*=UTF-8''%E7%AC%94%E8%AE%B0.md`)
// → '笔记.md'

it('downloads the export as a blob with its filename')
// MSW 返回 markdown + content-disposition；断言 blob.text() 与 filename

it('streams analysis frames in order')
// 构造 ReadableStream，按 meta/delta/delta/done 分块推送
// handlers 调用顺序正确，最后正常 resolve

it('delivers an error frame without throwing')
// error 帧 → onError 收到 code/message/retryable，Promise resolve

it('rejects an incomplete stream')
// 只收到 meta 后流结束 → rejects with SseProtocolError('AI 流意外结束')
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bookr/web test -- notes.test`
Expected: FAIL.

- [x] **Step 3: Extract the SSE parser and implement `api/notes.ts`**

- [x] **Step 4: Run the notes and AI stream tests**

Run: `pnpm --filter @bookr/web test -- notes.test stream.test`
Expected: PASS（证明提取没有破坏 P5 的解析器）。

- [x] **Step 5: Typecheck and commit**

```bash
pnpm exec turbo run typecheck --filter=@bookr/web
git add apps/web/src/lib/sse.ts apps/web/src/features/reader/ai/stream.ts apps/web/src/api/ai.ts apps/web/src/api/notes.ts apps/web/src/api/__tests__/notes.test.ts
git commit -m "feat(web): add notes api client and shared sse parser"
```

---

### Task 6: 笔记库页面

**Files:**
- Create: `apps/web/src/features/notes/NotesPage.tsx`
- Create: `apps/web/src/features/notes/NotesFilterBar.tsx`
- Create: `apps/web/src/features/notes/NoteCard.tsx`
- Create: `apps/web/src/features/notes/NoteEditDialog.tsx`
- Create: `apps/web/src/features/notes/useNotes.ts`
- Create: `apps/web/src/features/notes/position.ts`
- Modify: `apps/web/src/app/router.tsx`（`{ path: 'notes', element: <NotesPage /> }`）
- Modify: `apps/web/src/app/AppLayout.tsx`（导航项 `{ to: '/notes', label: '笔记', end: true }`，位于书架与回收站之间）
- Modify: `apps/web/test/setup.ts`（默认 MSW 夹具）
- Test: `apps/web/src/features/notes/__tests__/notes-page.test.tsx`

**Interfaces:**
- Consumes: Task 5 的 `fetchNotes`/`fetchNoteTags`/`downloadNotesExport`；现有 `useBooks`、`updateAnnotation`/`deleteAnnotation`（`api/reading.ts`）、`formatDate`、`messageForApiError`、`Dialog`/`Button`/`Input`/`EmptyState`
- Produces:
  - `useNotesList(filters)`、`useNoteTags()`、`useUpdateNote()`、`useDeleteNote()`、`useOnlineStatus()` 于 `useNotes.ts`。`useOnlineStatus` 返回 `navigator.onLine !== false` 的当前值，并监听 `window` 的 `online`/`offline` 事件。
  - `describeNotePosition(locator: Locator): string`：pdf → `第 N 页`；reflow → `原书第 N 页`；epub → `全书 X%`
  - `NotesPage` 在测试中不接受额外 props（Task 7 再加 `analysisApi` 可选 prop）

**页面行为：**

- 标题「笔记库」，副标题「你写在所有书里的划线与批注」。
- 搜索框 `aria-label="搜索笔记"`，输入后 300ms 防抖写入 `filters.q`。
- 筛选：`按书筛选`（`useBooks({ pageSize: 100 })` 的选项，值是 book id，显示书名）、`按标签筛选`（`fetchNoteTags`）、`按类型筛选`（全部/划线/批注）、`按时间筛选`（全部/近 7 天/近 30 天/近 1 年）。
- 时间预设转成 `from`：`7d` → 今天往前 6 天，`30d` → 29 天，`1y` → 364 天；用浏览器本地日期生成 `YYYY-MM-DD`；`all` 不带 `from`。
- 列表：`useInfiniteQuery` + 「加载更多」按钮；筛选变化时 `queryKey` 变化自动回到第 1 页。空状态显示「还没有笔记」与链接「去书架挑一本书」。
- 视图切换按钮「列表」/「按书分组」；分组视图按当前已加载条目的 book id 分组，组标题为 `《书名》 · N 条`。
- 卡片内容：书名、`describeNotePosition`、划线原文（最多 160 字）、批注、标签、`formatDate(updatedAt)`。
- 卡片操作：
  - `跳回原文` → `<Link to={`/books/${note.book.id}/read?note=${note.id}`}>`。
  - `编辑` → 打开 `NoteEditDialog`：批注文本、标签（逗号分隔，`normalizeTags` 规范化，最多 20 个、每个 30 字）、颜色（5 色，复用 `@bookr/reader-core` 的 `HIGHLIGHT_HEX` 与 reader 的 `ANNOTATION_COLOR_OPTIONS` 或本地同值列表）。`type === 'note'` 时批注不能为空。提交 `updateAnnotation(note.book.id, note.id, { revision: note.revision, noteText, tags, color })`；成功后 `invalidateQueries({ queryKey: ['notes'] })`；`conflict: true` 时提示「这条笔记已在另一台设备更新，已显示最新版本」。
  - `删除` → 两步确认（再点一次「确认删除？」3 秒后复位），调用 `deleteAnnotation(note.book.id, note.id)`，成功后失效 `['notes']`。
- 导出按钮「导出 Markdown」：用当前筛选（不含分页）调用 `downloadNotesExport`，创建对象 URL 与临时 `<a download>` 触发下载，随后 `revokeObjectURL`；失败时显示 `messageForApiError`。
- 离线：`navigator.onLine === false` 时显示 `role="status"` 提示「离线时无法浏览笔记库，联网后会自动恢复。」，导出按钮禁用；列表仍展示已有缓存数据（若有）。
- 顶部工具栏右侧为 Task 7 预留的位置：本任务先渲染一个空的 `<div className="notes-analysis-slot" />`，Task 7 用 `<NoteAnalysisPanel …/>` 替换。

**测试夹具（`apps/web/test/setup.ts`）：**

- 新增 `note(overrides): NoteDto`，默认 `book: { id:'book-csapp', title:'深入理解计算机系统', author:'Randal E. Bryant', format:'pdf' }`、`type:'note'`、`color:'yellow'`、`locator:{kind:'pdf',page:12,percent:0.4}`、`selectedText:'程序的运行'`、`noteText:'指令与数据的边界'`、`tags:['方法论']`。
- 默认 `GET /api/notes` 返回两条夹具；`GET /api/notes/tags` 返回 `[{ tag:'方法论', count:2 }]`；`/api/books` 已存在。
- 默认 `PATCH`/`DELETE /api/books/:id/annotations/:id` 返回成功（`PATCH` 返回 `{ annotation: note({...}), conflict: false }`）。

- [x] **Step 1: Write the failing page tests**

`apps/web/src/features/notes/__tests__/notes-page.test.tsx`：

```ts
it('renders notes with their book, position, quote, note and tags')
// initialEntries ['/notes']，经 AppLayout 导航渲染
// 断言书名、`第 12 页`、划线、批注、`方法论`

it('searches after the debounce and restarts the list')
// 输入 `狐狸`，await waitFor 请求 URL 含 q=狐狸；旧条目不与新结果混排

it('sends book, tag, type and time filters')
// 依次选择筛选项，断言最后一次请求包含 bookId/tag/type/from

it('groups the loaded notes by book')
// 点击「按书分组」→ 出现 `《深入理解计算机系统》 · 2 条`

it('edits a note inline and refreshes the list')
// 点击编辑 → 改批注与标签 → 保存；断言 PATCH body 含 revision 与 normalizeTags 后的标签；列表重新请求

it('confirms before deleting a note')
// 第一次点删除只出现「确认删除？」；第二次点调用 DELETE

it('links each note back to its reader position')
// 链接 href === `/books/book-csapp/read?note=note-1`

it('exports with the active filters')
// 点击导出 → 断言请求 URL 含当前 q/tag；创建了 <a download="…">（可 spy createElement/click 或 URL.createObjectURL）

it('shows the empty and offline states')
// 空列表 → 空状态；渲染后 Object.defineProperty(navigator,'onLine',{value:false})
// 并 window.dispatchEvent(new Event('offline')) → 提示可见且导出禁用
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bookr/web test -- notes-page`
Expected: FAIL（路由不存在）。

- [x] **Step 3: Implement the hooks, filters, cards, dialog, page and navigation**

编辑/删除后除了失效 `['notes']`，还失效 `['annotations', bookId]`，让本地阅读器在下一次同步后刷新；不要直接写 Dexie。

- [x] **Step 4: Run page tests and the existing bookshelf tests**

Run: `pnpm --filter @bookr/web test -- notes-page bookshelf`
Expected: PASS（导航新增不影响既有用例）。

- [x] **Step 5: Typecheck and commit**

```bash
pnpm exec turbo run typecheck --filter=@bookr/web
git add apps/web/src/features/notes apps/web/src/app/router.tsx apps/web/src/app/AppLayout.tsx apps/web/test/setup.ts
git commit -m "feat(web): add cross-book notes library page"
```

---

### Task 7: AI 笔记分析面板

**Files:**
- Create: `apps/web/src/features/notes/useNoteAnalysis.ts`
- Create: `apps/web/src/features/notes/NoteAnalysisPanel.tsx`
- Modify: `apps/web/src/features/notes/NotesPage.tsx`（用面板替换 `notes-analysis-slot`，并传给页面当前筛选）
- Modify: `apps/web/test/setup.ts`（`/api/notes/analyses` 默认夹具）
- Test: `apps/web/src/features/notes/__tests__/note-analysis.test.tsx`

**Interfaces:**
- Consumes: Task 1 的分析 DTO/常量；Task 5 的 `streamNoteAnalysis`/`fetchNoteAnalyses`/`fetchNoteAnalysis`/`deleteNoteAnalysis`；`messageForApiError`；`formatDateTime`
- Produces:

```ts
export interface NoteAnalysisApi {
  list(): Promise<NoteAnalysisSummaryDto[]>;
  get(id: string): Promise<NoteAnalysisDto>;
  remove(id: string): Promise<void>;
  stream(
    body: { kind: NoteAnalysisKind; filters?: NoteFilters },
    handlers: NoteAnalysisStreamHandlers,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
}
export const noteAnalysisApi: NoteAnalysisApi; // 默认实现，包装 api/notes.ts
export function useNoteAnalysis(api: NoteAnalysisApi, filters: NoteFilters): {
  kind: NoteAnalysisKind;
  setKind(kind: NoteAnalysisKind): void;
  running: boolean;
  content: string;
  status: 'idle' | 'streaming' | 'complete' | 'interrupted' | 'failed';
  error: string | null;
  noteCount: number | null;
  analyzedCount: number | null;
  run(): void;
  stop(): void;
  reset(): void;
};
export interface NoteAnalysisPanelProps {
  filters: NoteFilters;
  online: boolean;
  api?: NoteAnalysisApi; // 测试注入
  onClose(): void;
}
export function NoteAnalysisPanel(props: NoteAnalysisPanelProps): JSX.Element;
```

**面板行为：**

- `<aside aria-label="AI 笔记分析">`，标题「AI 笔记分析」，关闭按钮「关闭」；Escape 关闭。
- 三种分析类型按钮：「主题归纳」「观点梳理」「待办提取」，当前项 `aria-pressed="true"`；默认 `themes`。
- 「开始分析」按钮：离线时禁用并显示「离线时无法使用 AI 分析」；运行中变成「停止」。
- 运行中状态文案：`正在分析 ${noteCount ?? '…'} 条笔记（实际纳入 ${analyzedCount ?? '…'} 条）…`。
- 内容区 `white-space: pre-wrap`，`data-status` 反映状态；`interrupted` 时显示「已停止，已生成的部分已保存」；`failed` 时显示错误文案。
- 错误映射：
  - `ApiError` 且 `code === 'VALIDATION_FAILED'` 且 `details.reason === 'no_notes'` → 「当前筛选下没有可分析的笔记」。
  - 其余用 `messageForApiError`。
  - 流内 `error` 帧用 `payload.message`。
- 历史：「最近分析」列表（`list()`），每项显示标题与 `formatDateTime(createdAt)`，点击 `get(id)` 把内容加载进内容区（`noteCount`/`analyzedCount` 同步显示），删除按钮两步确认后 `remove(id)` 并刷新列表。
- `done` 后刷新历史；`interrupted`/`failed` 同样刷新历史（服务端已落库）。
- 运行期间切换筛选不自动重跑；面板保留当前结果，由用户再次点击开始。
- `NotesPage` 增加 `analysisApi?: NoteAnalysisApi` 可选 prop 并透传给面板；默认用 `noteAnalysisApi`。

- [x] **Step 1: Write the failing tests**

`apps/web/src/features/notes/__tests__/note-analysis.test.tsx`（直接渲染 `<NotesPage analysisApi={fake} />`，外套 memory router 与 providers；MSW 提供 `/api/notes`、`/api/notes/tags`、`/api/books`）：

```ts
it('runs an analysis and streams the answer')
// 点击「分析笔记」→ 面板可见；点击「开始分析」
// fake.stream 依次调用 onMeta({noteCount:2, analyzedCount:2,...})、onDelta('主题一')、onDelta('、主题二')、onDone(...)
// 内容区出现 `主题一、主题二`；list() 被重新调用

it('shows the empty-scope error')
// fake.stream 抛 ApiError(400, VALIDATION_FAILED, { reason:'no_notes' })
// 出现「当前筛选下没有可分析的笔记」

it('stops a running analysis and keeps partial text')
// fake.stream 等待 abort；点击「停止」→ signal.aborted 为 true
// 保留已出现的部分文本，状态显示「已停止，已生成的部分已保存」

it('opens and deletes a saved analysis')
// list() 返回一条；点击标题 → get() 内容出现
// 点击删除两次 → remove(id) 被调用，列表刷新

it('disables analysis while offline')
// 渲染后 Object.defineProperty(navigator,'onLine',{value:false})
// 并 window.dispatchEvent(new Event('offline')) → 开始按钮禁用，提示可见
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bookr/web test -- note-analysis`
Expected: FAIL.

- [x] **Step 3: Implement the hook, panel and NotesPage integration**

- [x] **Step 4: Run note tests**

Run: `pnpm --filter @bookr/web test -- note-analysis notes-page`
Expected: PASS.

- [x] **Step 5: Typecheck and commit**

```bash
pnpm exec turbo run typecheck --filter=@bookr/web
git add apps/web/src/features/notes apps/web/test/setup.ts
git commit -m "feat(web): add streaming ai note analysis panel"
```

---

### Task 8: 阅读器笔记跳转

**Files:**
- Modify: `apps/web/src/features/reader/ReaderPage.tsx`
- Test: `apps/web/src/features/reader/__tests__/reader-note-jump.test.tsx`

**Interfaces:**
- Consumes: 现有 `annotationsQuery`（本地仓储 `repo.listAnnotations`）、`engine.goTo(locator, { flash: true })`、`showToast`、`useSearchParams`
- Produces: 阅读器支持 `?note=<annotationId>`：在文档就绪且本地批注列表包含该 id 时跳转并闪烁；找不到时提示一次并停留原进度

**规则：**

- `useSearchParams()` 读取 `note`；只有匹配 UUID 形状（`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`）才视为有效目标，其余忽略。
- 条件：`engine !== null`、`status === 'ready'`、`annotations` 已加载、尚未对该 id 执行过（用 ref 记录）。
- 找到：`ignoreRejection(() => engine.goTo(target.locator, { flash: true }))`；同一个 id 只跳一次（切换重排模式后由现有位置映射负责）。
- 找不到且 `annotationsQuery.isSuccess`：只提示一次「没有找到这条笔记，已回到上次位置」，不阻塞阅读。
- 不改 URL（保留 `note` 参数），不改变既有的进度加载优先级。

- [x] **Step 1: Write the failing tests**

`apps/web/src/features/reader/__tests__/reader-note-jump.test.tsx`，复用 `createFakeEngine`、`createMemoryRepository`、`renderWithSync`：

```ts
it('jumps to the note locator and flashes it')
// repo.createAnnotation(userId, bookId, {...}) 得到 id（或直接写入夹具）
// initialEntries [`/books/book-csapp/read?note=${id}`]
// waitFor：engine.goTo 以该 locator 与 { flash:true } 被调用

it('ignores an unknown note and warns once')
// ?note=<随机 uuid> → goTo 未被调用；出现「没有找到这条笔记，已回到上次位置」

it('does not jump without the note parameter')
// 普通打开 → 不以 flash 调用 goTo
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bookr/web test -- reader-note-jump`
Expected: FAIL。

- [x] **Step 3: Implement the effect in `ReaderPage.tsx`**

- [x] **Step 4: Run reader tests**

Run: `pnpm --filter @bookr/web test -- reader-note-jump reader-ai`
Expected: PASS（不影响既有阅读器行为）。

- [x] **Step 5: Typecheck and commit**

```bash
pnpm exec turbo run typecheck --filter=@bookr/web
git add apps/web/src/features/reader/ReaderPage.tsx apps/web/src/features/reader/__tests__/reader-note-jump.test.tsx
git commit -m "feat(web): open the reader at a linked note"
```

---

### Task 9: 端到端验收

**Files:**
- Create: `apps/web/e2e/notes.spec.ts`
- Modify: `apps/web/e2e/helpers.ts`（仅在需要时新增导出）

**Interfaces:**
- Consumes: `registerFreshReader`、`uploadAndRename`、`readerAuth`、`deleteE2EBooks`、`openBook`、`revealChrome`、`E2E_BASE_URL`；Task 6/7/8 的 UI 与 `?note=` 跳转
- Produces: 3 个验收用例，覆盖检索/筛选/跳转、导出、AI 分析

**前置：** `test.beforeAll` 用管理员 token 请求 `GET /api/ai/usage`，断言 `fakeProvider === true`（与 `ai.spec.ts` 相同，失败信息提示需要 `AI_FAKE_PROVIDER=1`）；`test.afterEach` 调 `deleteE2EBooks(request)`。

- [x] **Step 1: Write the spec**

```ts
const TITLE = '端到端笔记库';
const FIXTURE = 'e2e/fixtures/reader.pdf';

async function createNoteViaApi(request, username, bookId, data): Promise<string>
// POST /api/books/:id/annotations，headers 用 readerAuth(request, username)
// 断言 201，返回 annotation.id

it('searches, filters and jumps back to the source note')
// 注册读者、上传、openBook 取 bookId
// API 建两条：note（selectedText 'quick brown fox'，noteText '狐狸与狗', tags ['端到端']）、highlight（'程序由指令组成'）
// 点击导航「笔记」→ 两条可见
// 搜索 `狐狸` → 只剩 note；清空搜索
// 标签筛选「端到端」→ 只剩 note
// 点击「跳回原文」→ URL 含 `?note=` 且进入阅读器；revealChrome 后看到 `第 1 / ` 页；返回 `/notes`

it('exports the filtered notes as markdown')
// 注：过滤到 tag 后点击「导出 Markdown」
// 等待 download 事件，读取文件内容
// 含书名、`> quick brown fox`、批注、`标签：#端到端`；文件名为 `笔记-端到端笔记库-<日期>.md`

it('runs a note analysis and keeps it in history')
// `/notes` → 按书筛选选择「端到端笔记库」→ 「分析笔记」→ 「开始分析」
// 等待 FakeAiClient 文案「已收到上下文」出现在内容区
// 刷新页面 → 打开「分析笔记」→ 「最近分析」第一项标题为 `《端到端笔记库》主题归纳`
// 点击该项，内容仍包含「已收到上下文」
```

- [x] **Step 2: Run the E2E suite against the local stack**

```bash
# 前提：docker compose up -d --build，服务端 AI_FAKE_PROVIDER=1，E2E 管理员已 bootstrap
pnpm --filter @bookr/web exec playwright test e2e/notes.spec.ts
```

Expected: 3 passed。

- [x] **Step 3: Run the full E2E suite**

```bash
pnpm --filter @bookr/web exec playwright test
```

Expected: 既有 13 条 + 新增 3 条全部通过（失败先修，不得跳过）。

- [x] **Step 4: Commit**

```bash
git add apps/web/e2e/notes.spec.ts apps/web/e2e/helpers.ts
git commit -m "test(e2e): cover notes library, export and analysis"
```

---

### Task 10: 文档与交付记录

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-10-18-00-roadmap.md`
- Modify: `docs/superpowers/plans/2026-10-19-06-notes-library.md`（勾选任务，写入最终数字与残留边界）
- Modify: `.superpowers/sdd/2026-10-19-06-notes-library/progress.md`（由控制者维护，本任务只读）

- [x] **Step 1: README**

新增「笔记库与 AI 分析」小节：

- 全局笔记库：全文检索（划线原文 + 批注）、按书/标签/类型/时间筛选、按书分组、跳回原文、就地编辑/删除、Markdown 导出。
- 导出格式与上限（5000 条）说明。
- AI 分析：三种类型、最多 300 条、24k token 上下文、使用 `reasonerModel`、结果保存在服务端（`note_analyses`），沿用 AI 开关与日/月配额。
- 隐私：只发送筛选后的笔记摘录（划线、批注、标签、书名、位置），不发送整本书；日志不记录笔记内容。
- 离线限制：笔记库与 AI 分析需要联网；离线阅读与记笔记不受影响。
- 管理/运维：无新增环境变量；分析记录随用户删除级联清理。

- [x] **Step 2: Roadmap**

把 06 行标记为「已交付」，加入计划文件链接；保持 07/08 未开始。

- [x] **Step 3: 全量验证**

```bash
pnpm exec turbo run typecheck test --force
docker compose ps
curl -fsS http://localhost:8180/healthz
pnpm --filter @bookr/web exec playwright test
```

记录 Server / Web / Reader-core / Shared 各自测试数、E2E 通过数与耗时、Compose 健康情况。

- [x] **Step 4: 更新计划交付记录并提交**

在计划末尾追加「交付记录」：最终测试数字、合并提交、复审结论、残留边界（笔记库需联网；书签不进入笔记库；EPUB 位置只有百分比；分析超过 300 条时取最新 300 条；崩溃后可能残留 `streaming` 行且历史列表不可见；笔记库编辑走 REST 而非本地队列）。

```bash
git add README.md docs/superpowers/plans/2026-10-18-00-roadmap.md docs/superpowers/plans/2026-10-19-06-notes-library.md
git commit -m "docs: record notes library delivery"
```

---

## 验收映射

| 验收标准 | 覆盖任务 |
|---|---|
| 笔记库可全文搜索（划线原文与批注） | Task 3（查询）、Task 6（UI） |
| 按书/标签筛选 | Task 3、Task 6 |
| 按时间筛选（用户时区） | Task 3、Task 6 |
| 跳回原文并高亮 | Task 8、Task 9 |
| 导出 Markdown（书名/位置/划线/批注/时间） | Task 3、Task 6、Task 9 |
| 笔记分析（主题归纳/观点梳理/待办提取） | Task 4、Task 7、Task 9 |
| 隐私与用户隔离 | Task 3、Task 4、Task 9 |

---

## 交付记录

- **分支**：`feat/p6-notes-library`（从 `95ce541` 起；期间合并了 Web UI 响应式改造 `3182f49`）。
- **主要提交**：共享契约与迁移 `8631ead`/`a51e9e5`/`41d8f88`；查询与导出 `bb75320`/`988f9b8`/`d6c2077`；Web 客户端与 SSE `a452a7e`/`bbed9a2`；阅读器跳转 `7a5ec98`/`7d3388c`；分析服务端 `e47d346`/`c42aa3b`；笔记库页面 `d38a9e0`/`44b2ec1`；分析面板 `dbbae55`/`cfda903`/`c271b74`；E2E `24fe9eb`；终审修复 `b9884fd`/`e54fdec`；交付文档 `815cabe`。
- **最终验证**：`turbo run typecheck test --force` 12/12；Server 43 文件 / 311 用例；Web 43 文件 / 375 用例；Reader-core 18 文件 / 149 用例；Shared 9 文件 / 57 用例；Playwright 16/16（46.5s，其中笔记库 3 条）；Compose 4/4 healthy，`/healthz` 200。
- **审查结论**：每个任务均经过独立复审；终审（Opus 全分支）提出 3 个阻断项——请求日志泄漏搜索词/标签、跨源部署未暴露 `Content-Disposition`、停止分析后历史刷新与服务端落库竞争——均已修复并补测试；另修掉大写 `?note=` 误判、导出代码围栏/标签换行、极端分页/NUL 输入与编辑框超长输入。
- **残留边界**：
  - 笔记库需要联网；离线仍可阅读已缓存的书并在阅读器内记笔记，联网后同步汇入。
  - 笔记删除为软删除并保留墓碑；没有独立的“笔记回收站”恢复界面。
  - 书签不进入笔记库，仍在阅读器内管理。
  - EPUB 位置以全书百分比展示；PDF 显示页码。
  - 分析最多取最近编辑的 300 条、24k token；更早的笔记不进入该次分析。
  - 分析记录是服务端权威数据，不进入 P4 的 `sync_changes`；离线不可用。
  - 崩溃可能遗留 `streaming` 分析行（历史列表隐藏），配额预占由每日清理在 1 小时后回收。
  - 笔记库编辑/删除走 REST；本机阅读器的本地副本需等下一次同步才更新。
