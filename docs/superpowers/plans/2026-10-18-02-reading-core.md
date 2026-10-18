# 私人书房 — 计划 2：阅读内核 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让共享书架上的每本书都能真正打开阅读：PDF 原版模式（文字层选中/复制、划线/批注、目录、缩放与夜间模式）、EPUB（流式重排、字体主题、划线/批注、目录）、用户级进度自动保存与恢复、书签，以及 Tauri 桌面壳与 Android Capacitor 壳的接入。

**Architecture:** 新增框架无关的 `packages/reader-core`，以统一 `ReaderEngine` 接口封装 pdf.js 与 epub.js；Web 端新增全屏阅读页和纸墨书房阅读控制层；服务端新增书签/划线/批注/进度 API 与阅读文件预签名端点；三端共用同一 Web 构建产物，原生壳只负责宿主。大文件仍通过预签名 URL 直取，应用服务器不中转文件内容。

**Tech Stack:** 既有 Node.js 22 / Fastify 5 / Drizzle / PostgreSQL 16 / React 19 / Vite / TanStack Query / Vitest / Playwright；新增 pdfjs-dist 6.4.299、epubjs 0.3.93、Tauri 2、Capacitor 7。

**Spec:** `docs/superpowers/specs/2026-10-18-private-book-reader-design.md`

**Plan set:** 本项目共 8 份计划，见 `2026-10-18-00-roadmap.md`。本计划覆盖 P2，不包含重排（计划 3）、同步与离线（计划 4）、AI（计划 5）、笔记库（计划 6）、统计（计划 7）。

## Global Constraints

- PDF 原版模式使用 pdf.js（canvas + 文字层）；EPUB 使用 epub.js；MOBI/AZW3 阅读服务端转换后的 EPUB，原始文件保留。
- 定位器唯一契约（括号内为必填）：PDF `{ kind:'pdf', page, percent, rect?, rects?, charOffset? }`；EPUB `{ kind:'epub', cfi, percent, href? }`；重排 `{ kind:'reflow', sourcePage, percent, blockId?, charRange? }`。`percent` 为 0–1；PDF 矩形为页内归一化坐标（左上角原点，0–1）。
- 阅读进度：本地最多每 5 秒写一次；服务端每 30 秒或离开页面时保存；服务端时间为 UTC；`reading_progress.percent` 为 0–1，`BookDto.progressPercent` 为 0–100 的整数（四舍五入）。
- 划线/批注/书签严格按 `user_id` 隔离；同一本书的其他成员永远看不到。划线/批注软删除，`deleted_at` 保留 30 天（清理在计划 6 实现）。
- 划线颜色固定五种：`yellow | green | blue | pink | purple`。
- 输入上限：`selectedText` 10000 字符；`noteText` 10000 字符；标签最多 20 个、每个 30 字符；书签备注 200 字符；EPUB CFI 1024 字符。
- 阅读文件 URL 有效期 3600 秒；只对未删除图书签发；转换未完成/失败的 MOBI/AZW3 返回 409 `BOOK_NOT_READY`。
- 阅读器设置默认值：主题 `paper`，亮度 `1`，PDF 连续滚动 + 适应宽度 + 自动裁边，EPUB 分页 + 衬线 + 18px + 行距 1.8 + 左右留白 6% + 单栏。设置保存在 `localStorage` 键 `bookr.reader.settings.v1`。
- PDF 裁边：默认自动检测第一页白边（每边最多 15%），可关闭并手动微调每边 0–10%；裁边通过缩放页面内层实现，定位器仍相对完整页面坐标。
- PDF 目录：有 outline 用 outline；没有时回退为按页目录（每页一项）。
- `packages/reader-core` 不得依赖 React/DOM 框架；只通过 `ReaderEngine` 暴露能力。
- 阅读界面沿用纸墨书房：纸色背景、衬线书名、控制栏按需浮现，阅读区不出现常驻工具栏。
- API 前缀 `/api`，错误统一为 `{ "error": { "code": string, "message": string, "details"?: object } }`；代码/变量/注释用英文，界面文案用简体中文。
- 所有新增表主键 UUIDv7；时间 `timestamptz`；用户私有行必须同时校验 `user_id`。
- 共享 `books.status`（未读/在读/读完）保持书架级人工标签，本计划不因阅读自动改写它；`progressPercent` 与阅读进度按用户。
- 本计划不做 AI、重排包、跨设备实时同步、离线缓存、阅读时长统计。

## Review Focus

以下五类输入/故障最可能伤害真实用户，对应测试必须在所属任务中实现：

1. 成员 B 读取、修改、删除成员 A 的划线/批注/书签/进度 → 返回 404（不泄露存在性），A 的数据保持不变（Task 4–6）。
2. PDF 跨行选择后，归一化矩形与 `charOffset` 在缩放、滚动、刷新后仍落在同一段文字上（Task 8、13）。
3. EPUB 换字体/字号/主题/单双栏后，CFI 位置与划线不丢失，刷新后仍能回到同一位置（Task 9、12、13）。
4. 进度恢复与自动保存：本地缓存较新时优先本地；服务器较新时优先服务器；切换账号不串进度；已进回收站的书不能保存（Task 4、10）。
5. 失败路径：转换未完成、文件缺失、EPUB/PDF 损坏、纯扫描 PDF（无文字层）都给出可读提示且不崩溃；无文字层 PDF 的选择菜单不出现（Task 3、10、11、13）。

## File Structure

```
packages/shared/
  src/locators.ts                 定位器 schema、颜色、readerKind 映射
  src/schemas/reading.ts          进度/划线/书签输入与 DTO
  src/errors.ts                   + BOOK_NOT_READY / FILE_MISSING
  src/index.ts                    导出
  src/__tests__/locators.test.ts
  src/__tests__/reading-schemas.test.ts

packages/reader-core/
  package.json, tsconfig.json, vitest.config.ts
  src/types.ts                    ReaderEngine、事件、设置、DTO
  src/settings.ts                 默认值、合并、主题色
  src/locator.ts                  百分比/矩形工具
  src/emitter.ts                  类型化事件发射器
  src/factory.ts                  createReaderEngine(kind)
  src/pdf/engine.ts               PDF 原版阅读引擎
  src/pdf/layout.ts               缩放/单双页/滚动定位纯函数
  src/pdf/text-layer.ts           文字层构建、字符偏移
  src/pdf/selection.ts            选区 → 归一化矩形
  src/pdf/outline.ts              目录解析
  src/epub/engine.ts              EPUB 阅读引擎
  src/epub/navigation.ts          目录扁平化、定位器构造
  src/epub/theme.ts               主题/字体 CSS
  src/__tests__/*.test.ts

apps/server/
  src/db/schema.ts                + reading_progress / annotations / annotation_history / bookmarks
  src/auth/guards.ts              AuthUser 增加 deviceId
  src/reading/progress.ts
  src/reading/annotations.ts
  src/reading/bookmarks.ts
  src/reading/repo.ts
  src/reading/dto.ts
  src/reading/routes.ts
  src/books/reader-file.ts
  src/books/routes.ts             + /file
  src/books/dto.ts                进度注入
  src/books/service.ts            按查看者取进度
  src/books/repo.ts               recent 排序按本人最后阅读
  src/app.ts                      注册 reading 路由
  drizzle/0002_reading.sql
  test/reading-*.test.ts
  test/reader-file.test.ts
  test/helpers.ts                 seedProgress / seedAnnotation / seedBookmark

apps/web/
  src/api/reading.ts              阅读文件、进度、划线、书签 API
  src/features/reader/ReaderPage.tsx
  src/features/reader/ReaderChrome.tsx
  src/features/reader/ReaderContent.tsx
  src/features/reader/TocPanel.tsx
  src/features/reader/SettingsPanel.tsx
  src/features/reader/SelectionMenu.tsx
  src/features/reader/AnnotationDialog.tsx
  src/features/reader/AnnotationsPanel.tsx
  src/features/reader/BookmarkDialog.tsx
  src/features/reader/BookmarksPanel.tsx
  src/features/reader/readerSettings.ts
  src/features/reader/progressStore.ts
  src/features/reader/useReaderProgress.ts
  src/features/reader/colors.ts
  src/features/reader/reader.css
  src/app/router.tsx              新增全屏阅读路由
  src/features/bookshelf/BookCard.tsx  阅读入口
  src/api/client.ts               VITE_API_BASE_URL
  vite.config.ts                  pdf.js cmaps/standard_fonts 静态复制
  e2e/reader.spec.ts
  e2e/global-setup.ts             生成 PDF/EPUB fixtures
  scripts/make-reader-fixtures.mjs
  test/reader-*.test.tsx
  test/setup.ts                   + 阅读 API handlers

apps/desktop/
  package.json, src-tauri/{Cargo.toml,build.rs,tauri.conf.json,src/main.rs,capabilities/default.json,icons/*}
  README.md

apps/mobile/
  package.json, capacitor.config.ts, android/（cap add android 生成）
  README.md

docker-compose.yml                MINIO_API_CORS_ALLOW_ORIGIN
.env.example                      VITE_API_BASE_URL / CORS_ORIGIN 多来源说明
README.md                         阅读器、桌面/Android 构建说明
```

---

### Task 1: Shared locator and reading contracts

**Files:**
- Create: `packages/shared/src/locators.ts`
- Create: `packages/shared/src/schemas/reading.ts`
- Modify: `packages/shared/src/errors.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/locators.test.ts`, `packages/shared/src/__tests__/reading-schemas.test.ts`

**Interfaces:**
- Produces: `ReaderKind = 'pdf' | 'epub'`; `readerKindForFormat(format: BookFormat): ReaderKind`（pdf→pdf，epub/mobi/azw3→epub）。
- Produces: `locatorSchema`, `Locator`, `PdfLocator`, `EpubLocator`, `ReflowLocator`, `LocatorRect`, `rectSchema`。
- Produces: `ANNOTATION_COLORS`, `AnnotationColor`。
- Produces: `updateProgressSchema`, `createAnnotationSchema`, `updateAnnotationSchema`, `createBookmarkSchema`, `updateBookmarkSchema`。
- Produces: `ReadingProgressDto`, `AnnotationDto`, `AnnotationMutationResult`, `BookmarkDto`。
- Produces errors `BOOK_NOT_READY`, `FILE_MISSING` in `ERROR_CODES`。

- [ ] **Step 1: Write the failing contract tests**

`packages/shared/src/__tests__/locators.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { locatorSchema, readerKindForFormat, unionRects } from '../locators';

describe('locator contract', () => {
  it('accepts the three documented locator shapes', () => {
    expect(locatorSchema.safeParse({ kind: 'pdf', page: 1, percent: 0 }).success).toBe(true);
    expect(locatorSchema.safeParse({ kind: 'epub', cfi: 'epubcfi(/6/4!/2)', percent: 0.6 }).success).toBe(true);
    expect(locatorSchema.safeParse({
      kind: 'reflow', sourcePage: 3, blockId: 'b_1', charRange: [2, 8], percent: 0.2,
    }).success).toBe(true);
  });

  it('rejects impossible positions', () => {
    expect(locatorSchema.safeParse({ kind: 'pdf', page: 0, percent: 0 }).success).toBe(false);
    expect(locatorSchema.safeParse({ kind: 'pdf', page: 1, percent: 1.2 }).success).toBe(false);
    expect(locatorSchema.safeParse({
      kind: 'pdf', page: 1, percent: 0.2,
      rect: { x: 0.9, y: 0.1, w: 0.2, h: 0.1 },
    }).success).toBe(false);
    expect(locatorSchema.safeParse({ kind: 'epub', cfi: '', percent: 0 }).success).toBe(false);
    expect(locatorSchema.safeParse({
      kind: 'reflow', sourcePage: 1, charRange: [9, 2], percent: 0.1,
    }).success).toBe(false);
  });

  it('maps every book format to the engine that actually reads it', () => {
    expect(readerKindForFormat('pdf')).toBe('pdf');
    expect(readerKindForFormat('epub')).toBe('epub');
    expect(readerKindForFormat('mobi')).toBe('epub');
    expect(readerKindForFormat('azw3')).toBe('epub');
  });

  it('unions highlight rectangles into one bounding rect', () => {
    expect(unionRects([
      { x: 0.1, y: 0.2, w: 0.3, h: 0.05 },
      { x: 0.2, y: 0.4, w: 0.4, h: 0.1 },
    ])).toEqual({ x: 0.1, y: 0.2, w: 0.5, h: 0.3 });
  });
});
```

`packages/shared/src/__tests__/reading-schemas.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  createAnnotationSchema, createBookmarkSchema, normalizeTags, updateAnnotationSchema,
  updateProgressSchema,
} from '../schemas/reading';

describe('reading input schemas', () => {
  it('accepts locator-only progress updates', () => {
    expect(updateProgressSchema.parse({
      locator: { kind: 'pdf', page: 3, percent: 0.12 },
    })).toEqual({ locator: { kind: 'pdf', page: 3, percent: 0.12 } });
  });

  it('requires note text for a note and allows a bare highlight', () => {
    const base = {
      color: 'yellow', locator: { kind: 'pdf', page: 1, percent: 0 },
      selectedText: '一段原文',
    };
    expect(createAnnotationSchema.safeParse({ ...base, type: 'highlight' }).success).toBe(true);
    expect(createAnnotationSchema.safeParse({ ...base, type: 'note', noteText: '   ' }).success).toBe(false);
    expect(createAnnotationSchema.safeParse({ ...base, type: 'note', noteText: '我的想法' }).success).toBe(true);
  });

  it('requires a base revision on updates and normalizes tags', () => {
    expect(updateAnnotationSchema.safeParse({ noteText: '改' }).success).toBe(false);
    expect(updateAnnotationSchema.safeParse({ noteText: '改', revision: 1 }).success).toBe(true);
    expect(normalizeTags(['  历史 ', '历史', '', '军事'])).toEqual(['历史', '军事']);
  });

  it('accepts an empty bookmark label and rejects an over-long one', () => {
    expect(createBookmarkSchema.parse({
      locator: { kind: 'epub', cfi: 'epubcfi(/6/2!/4)', percent: 0.1 }, label: '',
    })).toMatchObject({ label: null });
    expect(createBookmarkSchema.safeParse({
      locator: { kind: 'epub', cfi: 'epubcfi(/6/2!/4)', percent: 0.1 },
      label: 'x'.repeat(201),
    }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bookr/shared test`
Expected: FAIL — cannot resolve `../locators` / `../schemas/reading`.

- [ ] **Step 3: Implement the contracts**

`packages/shared/src/locators.ts` exports the schemas above. Rect validation must ensure `x + w <= 1` and `y + h <= 1` via `.superRefine`. `reflowLocatorSchema.charRange` is a two-number tuple with first ≤ second. `locatorSchema` is `z.discriminatedUnion('kind', [...])`. `unionRects` returns the bounding rect, or `null` for an empty array.

`packages/shared/src/schemas/reading.ts`:
- `updateProgressSchema = z.object({ locator: locatorSchema })`.
- `createAnnotationSchema`: `type: z.enum(['highlight','note'])`, `color: z.enum(ANNOTATION_COLORS)`, `locator`, `selectedText` trimmed min 1 max 10000, `noteText` trimmed max 10000 nullable optional, `tags` array max 20, each trimmed min 1 max 30, default `[]`. Super-refine: `type === 'note'` requires non-empty `noteText`.
- `updateAnnotationSchema`: `revision` required int ≥1; at least one of `color`, `noteText`, `tags`; `noteText` nullable. Super-refine at least one editable field.
- `createBookmarkSchema`: `locator`, `label` trimmed max 200 nullable optional default null; empty string → null.
- `updateBookmarkSchema`: `label` max 200 nullable (empty → null).
- `normalizeTags(tags: string[]): string[]` trims, drops empties, dedupes case-sensitively, caps at 20.
- DTO interfaces exactly:
```ts
export interface ReadingProgressDto {
  bookId: string;
  locator: Locator;
  percent: number;
  updatedAt: string;
}
export interface AnnotationDto {
  id: string; bookId: string;
  type: 'highlight' | 'note'; color: AnnotationColor;
  locator: Locator; selectedText: string; noteText: string | null;
  tags: string[]; revision: number;
  createdAt: string; updatedAt: string;
}
export interface AnnotationMutationResult { annotation: AnnotationDto; conflict: boolean }
export interface BookmarkDto {
  id: string; bookId: string; locator: Locator;
  label: string | null; createdAt: string; updatedAt: string;
}
```

Add `BOOK_NOT_READY: 'BOOK_NOT_READY'` and `FILE_MISSING: 'FILE_MISSING'` to `ERROR_CODES`; both have Chinese messages in Task 10's `errorMessages.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bookr/shared test && pnpm --filter @bookr/shared typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src
git commit -m "feat(shared): define locator and reading contracts"
```

---

### Task 2: Reading tables and seed helpers

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Create: `apps/server/drizzle/0002_reading.sql` (generated), `drizzle/meta/0002_snapshot.json`
- Modify: `apps/server/test/helpers.ts`
- Test: `apps/server/test/reading-schema.test.ts`

**Interfaces:**
- Produces tables `readingProgress`, `annotations`, `annotationHistory`, `bookmarks` and types `ReadingProgressRow`, `AnnotationRow`, `BookmarkRow`.
- Produces test helpers `seedProgress`, `seedAnnotation`, `seedBookmark`.

- [ ] **Step 1: Write the failing schema test**

```ts
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { annotations, bookmarks, readingProgress } from '../src/db/schema';
import {
  resetDb, seedAnnotation, seedBook, seedBookmark, seedProgress, seedUser, testDb,
} from './helpers';

it('stores per-user progress, annotations and bookmarks', async () => {
  await resetDb();
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id });
  await seedProgress({ userId: user.id, bookId: book.id, percent: 0.42, page: 12 });
  await seedAnnotation({ userId: user.id, bookId: book.id, noteText: '想法' });
  await seedBookmark({ userId: user.id, bookId: book.id, label: '此处' });

  expect((await testDb.select().from(readingProgress)).length).toBe(1);
  expect((await testDb.select().from(annotations)).length).toBe(1);
  expect((await testDb.select().from(bookmarks)).length).toBe(1);
});

it('allows one progress row per user and book', async () => {
  await resetDb();
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id });
  await seedProgress({ userId: user.id, bookId: book.id, percent: 0.1 });
  await seedProgress({ userId: user.id, bookId: book.id, percent: 0.7 });
  const rows = await testDb.select().from(readingProgress)
    .where(eq(readingProgress.bookId, book.id));
  expect(rows).toHaveLength(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bookr/server test reading-schema`
Expected: FAIL — missing exports/helpers.

- [ ] **Step 3: Implement schema and helpers**

Add to `schema.ts`:
- `readingProgress`: `userId` + `bookId` composite primary key; `locator jsonb` typed `Locator`; `percent doublePrecision`; `deviceId uuid` nullable referencing devices with `onDelete: 'set null'`; `updatedAt`; index `(bookId)`.
- `annotations`: id; userId/bookId FKs `onDelete: 'cascade'`; `type text $type<'highlight'|'note'>`; `color text $type<AnnotationColor>`; locator jsonb; selectedText text; noteText text nullable; tags `text('tags').array().notNull().default(sql\`'{}'::text[]\`)`; revision integer default 1; deletedAt; createdAt/updatedAt; index `(userId, bookId, updatedAt)`.
- `annotationHistory`: id; annotationId FK cascade; noteText; editedAt; deviceId nullable set null.
- `bookmarks`: id; userId/bookId cascade; locator; label nullable; deletedAt; createdAt/updatedAt; index `(userId, bookId, createdAt)`.

Run `pnpm --filter @bookr/server db:generate` and confirm it writes `0002_*.sql`; inspect that it only adds the four tables and indexes.

Test helpers: `seedProgress({ userId, bookId, locator?, percent?, page?, deviceId? })` upserts using `onConflictDoUpdate` (so the second call in the test replaces, never duplicates); default locator `{kind:'pdf',page: page ?? 1, percent}`. `seedAnnotation` inserts with defaults `type:'note'`, `color:'yellow'`, `selectedText:'引用'`, `tags:[]`, `revision:1`. `seedBookmark` inserts with default locator. All return the row.

- [ ] **Step 4: Run test and migration checks**

Run: `pnpm --filter @bookr/server test reading-schema`
Expected: PASS on a fresh test schema (reset via `resetDb`).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db/schema.ts apps/server/drizzle apps/server/test/helpers.ts apps/server/test/reading-schema.test.ts
git commit -m "feat(server): add reading progress and annotation tables"
```

---

### Task 3: Reader file URL endpoint

**Files:**
- Create: `apps/server/src/books/reader-file.ts`
- Modify: `apps/server/src/books/routes.ts`
- Test: `apps/server/test/reader-file.test.ts`

**Interfaces:**
- Consumes: `StorageService.presignGet(key, expiresInSeconds)`; `findBookById`.
- Produces: `getReaderFile(deps: AppDeps, bookId: string): Promise<ReaderFile>` and `ReaderFile = { url: string; format: ReaderKind; expiresIn: number }`.
- Produces: `GET /api/books/:id/file` → 200 `{ url, format, expiresIn }`.

- [ ] **Step 1: Write the failing endpoint tests**

```ts
import { expect, it } from 'vitest';
import { resetDb, seedBook, seedUser, buildTestApp, authHeader, fakeStorage } from './helpers';

it('signs the original PDF for any member', async () => {
  await resetDb();
  const app = await buildTestApp();
  const owner = await seedUser('member', 'owner');
  const reader = await seedUser('member', 'reader');
  const book = await seedBook({ uploadedBy: owner.id, format: 'pdf', fileKey: 'books/a.pdf' });
  fakeStorage.objects.set('books/a.pdf', Buffer.from('%PDF'));
  const res = await app.inject({
    method: 'GET', url: `/api/books/${book.id}/file`, headers: await authHeader(reader),
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({
    url: 'https://fake-s3.local/bookr/books/a.pdf?X-Amz-Expires=3600',
    format: 'pdf', expiresIn: 3600,
  });
});

it('reads MOBI through the converted EPUB and refuses before conversion', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const pending = await seedBook({ uploadedBy: user.id, format: 'mobi', fileKey: 'books/a.mobi' });
  const refused = await app.inject({
    method: 'GET', url: `/api/books/${pending.id}/file`, headers: await authHeader(user),
  });
  expect(refused.statusCode).toBe(409);
  expect(refused.json().error).toMatchObject({
    code: 'BOOK_NOT_READY', details: { conversionStatus: 'none' },
  });

  const converted = await seedBook({
    uploadedBy: user.id, format: 'azw3', fileKey: 'books/b.azw3',
    epubKey: 'books/b.epub', conversionStatus: 'done',
  });
  const ok = await app.inject({
    method: 'GET', url: `/api/books/${converted.id}/file`, headers: await authHeader(user),
  });
  expect(ok.statusCode).toBe(200);
  expect(ok.json()).toMatchObject({ format: 'epub' });
  expect(ok.json().url).toContain('books/b.epub');
});

it('404s for a missing object key and for a trashed book', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const missing = await seedBook({ uploadedBy: user.id, format: 'pdf', fileKey: null });
  const missingRes = await app.inject({
    method: 'GET', url: `/api/books/${missing.id}/file`, headers: await authHeader(user),
  });
  expect(missingRes.statusCode).toBe(404);
  expect(missingRes.json().error.code).toBe('FILE_MISSING');

  const trashed = await seedBook({
    uploadedBy: user.id, format: 'pdf', fileKey: 'books/c.pdf', deletedAt: new Date(),
  });
  const trashedRes = await app.inject({
    method: 'GET', url: `/api/books/${trashed.id}/file`, headers: await authHeader(user),
  });
  expect(trashedRes.statusCode).toBe(404);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bookr/server test reader-file`
Expected: FAIL — 404 route not found.

- [ ] **Step 3: Implement `getReaderFile` and the route**

`reader-file.ts`: load the book with `findBookById(db, id, { includeDeleted: false })`; 404 when absent. Choose `kind = readerKindForFormat(book.format)`. For `kind === 'pdf'` use `book.fileKey`; for EPUB use `book.epubKey` when the original format is `mobi`/`azw3` (even if `conversionStatus` says done), otherwise `book.fileKey`. If the chosen key is null: MOBI/AZW3 → 409 `BOOK_NOT_READY` with `details: { conversionStatus: book.conversionStatus }`; otherwise 404 `FILE_MISSING`. Sign for 3600 seconds.

Register `GET /api/books/:id/file` in `books/routes.ts` with the same UUID param schema and `requireAuth`; any authenticated member may read any live shelf book.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bookr/server test reader-file`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/books/reader-file.ts apps/server/src/books/routes.ts apps/server/test/reader-file.test.ts
git commit -m "feat(server): sign reader file URLs"
```

---

### Task 4: Progress API, DTO wiring and per-user recent order

**Files:**
- Create: `apps/server/src/reading/repo.ts`, `apps/server/src/reading/dto.ts`, `apps/server/src/reading/progress.ts`, `apps/server/src/reading/routes.ts`
- Modify: `apps/server/src/auth/guards.ts`, `apps/server/src/books/dto.ts`, `apps/server/src/books/service.ts`, `apps/server/src/books/repo.ts`, `apps/server/src/books/routes.ts`, `apps/server/src/uploads/service.ts`, `apps/server/src/app.ts`, `apps/server/test/helpers.ts`
- Test: `apps/server/test/reading-progress.test.ts`

**Interfaces:**
- Consumes: Task 1 `ReadingProgressDto`, `updateProgressSchema`, `readerKindForFormat`; Task 2 `readingProgress` row.
- Produces: `ReadingActor = { id: string; deviceId?: string }` (structurally compatible with `BookActor`).
- Produces: `getProgress(deps, userId, bookId): Promise<ReadingProgressDto | null>`.
- Produces: `saveProgress(deps, actor, bookId, locator): Promise<ReadingProgressDto>`.
- Produces: `findProgressForBooks(db, userId, bookIds): Promise<Map<string, ReadingProgressRow>>`.
- Produces: `GET /api/books/:id/progress` → 200 `{ progress: ReadingProgressDto | null }`; `PUT /api/books/:id/progress` body `{ locator }` → 200 `{ progress }`.
- Changes: `AuthUser` gains `deviceId?: string`, copied from the access-token claim.
- Changes: `toBookDto(deps, book, categories, uploaderDisplayName?, progress?)`; `listBooks(deps, query, viewerId)`, `getBook(deps, id, viewerId)`, `listTrash(deps, viewerId)`, `listBooksPage(db, query, viewerId)`.
- Extend `seedProgress` with optional `updatedAt?: Date`.

- [ ] **Step 1: Write the failing progress tests**

```ts
import { expect, it } from 'vitest';
import { readingProgress } from '../src/db/schema';
import {
  authHeader, buildTestApp, resetDb, seedBook, seedProgress, seedUser, testDb,
} from './helpers';

const pdfLocator = { kind: 'pdf' as const, page: 3, percent: 0.4, charOffset: 10 };

it('saves a locator and exposes only the viewer progress in shelf DTOs', async () => {
  await resetDb();
  const app = await buildTestApp();
  const alice = await seedUser('member', 'alice');
  const bob = await seedUser('member', 'bob');
  const book = await seedBook({ uploadedBy: alice.id, format: 'pdf' });

  const put = await app.inject({
    method: 'PUT', url: `/api/books/${book.id}/progress`,
    headers: await authHeader(alice), payload: { locator: pdfLocator },
  });
  expect(put.statusCode).toBe(200);
  expect(put.json().progress).toMatchObject({ bookId: book.id, percent: 0.4, locator: pdfLocator });

  const own = await app.inject({
    method: 'GET', url: `/api/books/${book.id}/progress`, headers: await authHeader(alice),
  });
  expect(own.json().progress.percent).toBe(0.4);

  const other = await app.inject({
    method: 'GET', url: `/api/books/${book.id}/progress`, headers: await authHeader(bob),
  });
  expect(other.json().progress).toBeNull();

  const aliceShelf = await app.inject({ method: 'GET', url: '/api/books', headers: await authHeader(alice) });
  const bobShelf = await app.inject({ method: 'GET', url: '/api/books', headers: await authHeader(bob) });
  expect(aliceShelf.json().items[0].progressPercent).toBe(40);
  expect(bobShelf.json().items[0].progressPercent).toBe(0);
});

it('upserts one row and records the issuing device', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id, format: 'pdf' });
  const headers = await authHeader(user);
  await app.inject({ method: 'PUT', url: `/api/books/${book.id}/progress`, headers, payload: { locator: pdfLocator } });
  await app.inject({
    method: 'PUT', url: `/api/books/${book.id}/progress`, headers,
    payload: { locator: { ...pdfLocator, page: 9, percent: 0.8 } },
  });
  const rows = await testDb.select().from(readingProgress);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ percent: 0.8, deviceId: user.deviceId });
});

it('rejects a locator of the wrong engine and a trashed book', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const epub = await seedBook({ uploadedBy: user.id, format: 'epub' });
  const wrong = await app.inject({
    method: 'PUT', url: `/api/books/${epub.id}/progress`,
    headers: await authHeader(user), payload: { locator: pdfLocator },
  });
  expect(wrong.statusCode).toBe(400);
  expect(wrong.json().error.details).toEqual({ expectedKind: 'epub' });

  const trashed = await seedBook({ uploadedBy: user.id, format: 'pdf', deletedAt: new Date() });
  const refused = await app.inject({
    method: 'PUT', url: `/api/books/${trashed.id}/progress`,
    headers: await authHeader(user), payload: { locator: pdfLocator },
  });
  expect(refused.statusCode).toBe(404);
});

it('orders recent books by the viewer last read, falling back to import time', async () => {
  await resetDb();
  const app = await buildTestApp();
  const alice = await seedUser('member', 'alice');
  const bob = await seedUser('member', 'bob');
  const old = await seedBook({
    uploadedBy: alice.id, title: '旧书', createdAt: new Date('2026-01-01T00:00:00Z'),
  });
  const fresh = await seedBook({
    uploadedBy: alice.id, title: '新书', createdAt: new Date('2026-02-01T00:00:00Z'),
  });
  await seedProgress({
    userId: alice.id, bookId: old.id, percent: 0.3,
    updatedAt: new Date('2026-03-01T00:00:00Z'),
  });

  const aliceItems = (await app.inject({
    method: 'GET', url: '/api/books?sort=recent', headers: await authHeader(alice),
  })).json().items.map((item: { id: string }) => item.id);
  const bobItems = (await app.inject({
    method: 'GET', url: '/api/books?sort=recent', headers: await authHeader(bob),
  })).json().items.map((item: { id: string }) => item.id);

  expect(aliceItems).toEqual([old.id, fresh.id]);
  expect(bobItems).toEqual([fresh.id, old.id]);
});
```

`authHeader(user)` must include a device-bound token after this task: extend `SeededUser` with `deviceId: string`; `seedUser` creates a `devices` row and `authHeader` signs with that `deviceId`. Existing tests continue to work.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bookr/server test reading-progress`
Expected: FAIL — route not found / `deviceId` missing.

- [ ] **Step 3: Implement the guard, repo, service and routes**

`auth/guards.ts`: `AuthUser` becomes `{ id: string; role: Role; deviceId?: string }`; assign `deviceId: claims.deviceId`. No route behavior changes.

`reading/repo.ts`:
```ts
export async function findProgressRow(db, userId, bookId): Promise<ReadingProgressRow | undefined>;
export async function findProgressForBooks(db, userId, bookIds): Promise<Map<string, ReadingProgressRow>>;
export async function upsertProgress(db, input): Promise<ReadingProgressRow>;
```
`upsertProgress` uses `.onConflictDoUpdate({ target: [readingProgress.userId, readingProgress.bookId], set: { locator, percent, deviceId, updatedAt } })`.

`reading/dto.ts`: `toProgressDto(row): ReadingProgressDto` (ISO timestamps); `toBookProgress(row | undefined): { percent: number } | undefined` for the shelf.

`reading/progress.ts`: `requireLiveBook` → 404; `getProgress` returns `null` when no row; `saveProgress` validates `locator.kind === readerKindForFormat(book.format)` (400 `VALIDATION_FAILED`, `details: { expectedKind }`), derives `percent = locator.percent`, upserts with `deps.clock.now()`, returns the DTO.

`reading/routes.ts`: `registerReadingRoutes(app, deps)` registers the two progress routes now; Tasks 5–6 add annotation/bookmark routes to the same function. Register it in `app.ts` after book routes.

`books/dto.ts`: add the optional `progress` argument; `progressPercent = Math.round((progress?.percent ?? 0) * 100)`.

`books/service.ts`: `toBookDtos(deps, rows, viewerId)` loads `findProgressForBooks` once; `listBooks(deps, query, viewerId)`, `getBook(deps, id, viewerId)`, `listTrash(deps, viewerId)`; `uploads/service.ts` keeps the no-progress call. `books/routes.ts` passes `request.user!.id`.

`books/repo.ts`: `listBooksPage(db, query, viewerId)` always left-joins `reading_progress` on `(book_id, user_id = viewerId)` and selects only `getTableColumns(books)`. For `sort=recent`, order by `coalesce(readingProgress.updatedAt, books.createdAt) DESC, books.id DESC`; other sorts unchanged. Existing list tests must still pass.

`test/helpers.ts`: `seedUser` also inserts a `devices` row with a hashed placeholder refresh token and returns `deviceId`; `authHeader` signs with `{ sub, role, deviceId }`.

- [ ] **Step 4: Run the progress tests and the existing book suite**

Run: `pnpm --filter @bookr/server test reading-progress books`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src apps/server/test
git commit -m "feat(server): persist per-user reading progress"
```

---

### Task 5: Annotations API with edit history

**Files:**
- Create: `apps/server/src/reading/annotations.ts`
- Modify: `apps/server/src/reading/repo.ts`, `apps/server/src/reading/dto.ts`, `apps/server/src/reading/routes.ts`
- Test: `apps/server/test/reading-annotations.test.ts`

**Interfaces:**
- Consumes: Task 1 `createAnnotationSchema`, `updateAnnotationSchema`, `AnnotationDto`, `AnnotationMutationResult`.
- Produces:
  - `listAnnotations(deps, userId, bookId): Promise<AnnotationDto[]>`
  - `createAnnotation(deps, actor, bookId, input): Promise<AnnotationDto>`
  - `updateAnnotation(deps, actor, bookId, annotationId, input): Promise<AnnotationMutationResult>`
  - `deleteAnnotation(deps, actor, bookId, annotationId): Promise<void>`
- Produces routes: `GET|POST /api/books/:id/annotations`, `PATCH|DELETE /api/books/:id/annotations/:annotationId`.
- Status codes: list/create 200/201; update 200 `{ annotation, conflict }`; delete 204; another user's row and missing row both 404.

- [ ] **Step 1: Write the failing annotation tests**

```ts
import { expect, it } from 'vitest';
import { annotationHistory, annotations } from '../src/db/schema';
import {
  authHeader, buildTestApp, resetDb, seedAnnotation, seedBook, seedUser, testDb,
} from './helpers';

const locator = { kind: 'pdf' as const, page: 2, percent: 0.2, charOffset: 5 };
const highlight = {
  type: 'highlight', color: 'yellow', locator, selectedText: '原文', tags: [' 历史 ', '历史'],
};

it('creates and lists only the caller annotations', async () => {
  await resetDb();
  const app = await buildTestApp();
  const alice = await seedUser('member', 'alice');
  const bob = await seedUser('member', 'bob');
  const book = await seedBook({ uploadedBy: alice.id, format: 'pdf' });

  const created = await app.inject({
    method: 'POST', url: `/api/books/${book.id}/annotations`,
    headers: await authHeader(alice), payload: highlight,
  });
  expect(created.statusCode).toBe(201);
  expect(created.json().annotation).toMatchObject({ tags: ['历史'], revision: 1, type: 'highlight' });

  const aliceList = await app.inject({
    method: 'GET', url: `/api/books/${book.id}/annotations`, headers: await authHeader(alice),
  });
  expect(aliceList.json().items).toHaveLength(1);
  const bobList = await app.inject({
    method: 'GET', url: `/api/books/${book.id}/annotations`, headers: await authHeader(bob),
  });
  expect(bobList.json().items).toEqual([]);
});

it("never exposes or mutates another member's annotation", async () => {
  await resetDb();
  const app = await buildTestApp();
  const alice = await seedUser('member', 'alice');
  const bob = await seedUser('member', 'bob');
  const book = await seedBook({ uploadedBy: alice.id, format: 'pdf' });
  const row = await seedAnnotation({ userId: alice.id, bookId: book.id, noteText: 'A 的想法' });

  const patch = await app.inject({
    method: 'PATCH', url: `/api/books/${book.id}/annotations/${row.id}`,
    headers: await authHeader(bob), payload: { noteText: 'B 覆盖', revision: 1 },
  });
  const del = await app.inject({
    method: 'DELETE', url: `/api/books/${book.id}/annotations/${row.id}`,
    headers: await authHeader(bob),
  });
  expect(patch.statusCode).toBe(404);
  expect(del.statusCode).toBe(404);
  const [stored] = await testDb.select().from(annotations);
  expect(stored).toMatchObject({ noteText: 'A 的想法', deletedAt: null, revision: 1 });
});

it('keeps the previous note text when an edit conflicts', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id, format: 'pdf' });
  const row = await seedAnnotation({ userId: user.id, bookId: book.id, noteText: '第一版' });
  const headers = await authHeader(user);
  const first = await app.inject({
    method: 'PATCH', url: `/api/books/${book.id}/annotations/${row.id}`,
    headers, payload: { noteText: '第二版', revision: 1 },
  });
  expect(first.json()).toMatchObject({ conflict: false, annotation: { revision: 2, noteText: '第二版' } });

  const stale = await app.inject({
    method: 'PATCH', url: `/api/books/${book.id}/annotations/${row.id}`,
    headers, payload: { noteText: '第三版', revision: 1 },
  });
  expect(stale.json()).toMatchObject({ conflict: true, annotation: { revision: 3, noteText: '第三版' } });
  const history = await testDb.select().from(annotationHistory);
  expect(history.map((entry) => entry.noteText)).toEqual(['第一版', '第二版']);
});

it('rejects a locator from the wrong engine and hides deleted annotations', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const epub = await seedBook({ uploadedBy: user.id, format: 'epub' });
  const headers = await authHeader(user);
  const wrong = await app.inject({
    method: 'POST', url: `/api/books/${epub.id}/annotations`, headers, payload: highlight,
  });
  expect(wrong.statusCode).toBe(400);
  expect(wrong.json().error.details).toEqual({ expectedKind: 'epub' });

  const created = await app.inject({
    method: 'POST', url: `/api/books/${epub.id}/annotations`, headers,
    payload: { ...highlight, locator: { kind: 'epub', cfi: 'epubcfi(/6/4!/2)', percent: 0.1 } },
  });
  const id = created.json().annotation.id;
  expect((await app.inject({
    method: 'DELETE', url: `/api/books/${epub.id}/annotations/${id}`, headers,
  })).statusCode).toBe(204);
  expect((await app.inject({
    method: 'GET', url: `/api/books/${epub.id}/annotations`, headers,
  })).json().items).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bookr/server test reading-annotations`
Expected: FAIL — routes return 404 not found.

- [ ] **Step 3: Implement annotations**

`reading/annotations.ts`:
- `requireLiveBook` and locator-kind validation shared with Task 4 (extract a small helper in `reading/repo.ts` or `reading/guards.ts`; do not duplicate the 404/400 logic).
- `listAnnotations`: verify live book; select own rows with `deletedAt IS NULL`, order `updatedAt DESC, id DESC`; map to DTO.
- `createAnnotation`: `noteText` from `input.noteText ?? null`; tags are already normalized by the schema; insert `revision: 1`; return DTO.
- `updateAnnotation` in a transaction: `SELECT ... FOR UPDATE` restricted by `id`, `bookId`, `userId`, `deletedAt IS NULL`; any miss → 404. `conflict = input.revision !== row.revision`. If `input.noteText` is defined and differs from `row.noteText` and the old text is non-empty, insert `annotationHistory` with the old text and `deviceId: actor.deviceId`. If `row.type === 'note'` and the new note text is null/blank → 400 `VALIDATION_FAILED` (`details: { noteText: 'required' }`). Update editable fields, `revision: row.revision + 1`, `updatedAt: now`, return `{ annotation, conflict }`.
- `deleteAnnotation`: update `deletedAt` where id/book/user and `deletedAt IS NULL`; no row → 404.

`reading/dto.ts`: `toAnnotationDto(row): AnnotationDto`; ISO timestamps; tags default `[]` if null.

`reading/routes.ts`: add the four routes with `requireAuth`; `POST` returns 201. Book id and annotation id are validated with `z.uuid()`.

Task 1's `createAnnotationSchema` and `updateAnnotationSchema` must run every `tags` array through `normalizeTags` (`.transform(normalizeTags)`), which is what makes the first test's `['历史']` expectation true.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bookr/server test reading-annotations`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/reading apps/server/test/reading-annotations.test.ts
git commit -m "feat(server): add user-scoped annotations with edit history"
```

---

### Task 6: Bookmarks API

**Files:**
- Create: `apps/server/src/reading/bookmarks.ts`
- Modify: `apps/server/src/reading/repo.ts`, `apps/server/src/reading/dto.ts`, `apps/server/src/reading/routes.ts`
- Test: `apps/server/test/reading-bookmarks.test.ts`

**Interfaces:**
- Produces:
  - `listBookmarks(deps, userId, bookId): Promise<BookmarkDto[]>`
  - `createBookmark(deps, actor, bookId, input): Promise<BookmarkDto>`
  - `updateBookmark(deps, actor, bookId, bookmarkId, input): Promise<BookmarkDto>`
  - `deleteBookmark(deps, actor, bookId, bookmarkId): Promise<void>`
- Produces routes: `GET|POST /api/books/:id/bookmarks`, `PATCH|DELETE /api/books/:id/bookmarks/:bookmarkId`. Create 201, update 200, delete 204.

- [ ] **Step 1: Write the failing bookmark tests**

```ts
import { expect, it } from 'vitest';
import { bookmarks } from '../src/db/schema';
import {
  authHeader, buildTestApp, resetDb, seedBook, seedBookmark, seedUser, testDb,
} from './helpers';

const locator = { kind: 'epub' as const, cfi: 'epubcfi(/6/4!/2)', percent: 0.3 };

it('creates, renames, lists and deletes own bookmarks', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id, format: 'epub' });
  const headers = await authHeader(user);

  const created = await app.inject({
    method: 'POST', url: `/api/books/${book.id}/bookmarks`, headers,
    payload: { locator, label: '  第三章  ' },
  });
  expect(created.statusCode).toBe(201);
  expect(created.json().bookmark).toMatchObject({ label: '第三章', locator });
  const id = created.json().bookmark.id;

  const renamed = await app.inject({
    method: 'PATCH', url: `/api/books/${book.id}/bookmarks/${id}`, headers,
    payload: { label: '重读此处' },
  });
  expect(renamed.json().bookmark.label).toBe('重读此处');

  const listed = await app.inject({
    method: 'GET', url: `/api/books/${book.id}/bookmarks`, headers,
  });
  expect(listed.json().items).toHaveLength(1);

  expect((await app.inject({
    method: 'DELETE', url: `/api/books/${book.id}/bookmarks/${id}`, headers,
  })).statusCode).toBe(204);
  expect((await app.inject({
    method: 'GET', url: `/api/books/${book.id}/bookmarks`, headers,
  })).json().items).toEqual([]);
});

it("never exposes another member's bookmark", async () => {
  await resetDb();
  const app = await buildTestApp();
  const alice = await seedUser('member', 'alice');
  const bob = await seedUser('member', 'bob');
  const book = await seedBook({ uploadedBy: alice.id, format: 'epub' });
  const row = await seedBookmark({ userId: alice.id, bookId: book.id, label: 'A 的书签' });

  expect((await app.inject({
    method: 'GET', url: `/api/books/${book.id}/bookmarks`, headers: await authHeader(bob),
  })).json().items).toEqual([]);
  expect((await app.inject({
    method: 'PATCH', url: `/api/books/${book.id}/bookmarks/${row.id}`,
    headers: await authHeader(bob), payload: { label: 'B 改名' },
  })).statusCode).toBe(404);
  expect((await app.inject({
    method: 'DELETE', url: `/api/books/${book.id}/bookmarks/${row.id}`,
    headers: await authHeader(bob),
  })).statusCode).toBe(404);
  const [stored] = await testDb.select().from(bookmarks);
  expect(stored).toMatchObject({ label: 'A 的书签', deletedAt: null });
});

it('rejects a locator from the wrong engine and a trashed book', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const pdf = await seedBook({ uploadedBy: user.id, format: 'pdf' });
  const wrong = await app.inject({
    method: 'POST', url: `/api/books/${pdf.id}/bookmarks`,
    headers: await authHeader(user), payload: { locator },
  });
  expect(wrong.statusCode).toBe(400);
  const trashed = await seedBook({ uploadedBy: user.id, format: 'epub', deletedAt: new Date() });
  const refused = await app.inject({
    method: 'POST', url: `/api/books/${trashed.id}/bookmarks`,
    headers: await authHeader(user), payload: { locator },
  });
  expect(refused.statusCode).toBe(404);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bookr/server test reading-bookmarks`
Expected: FAIL — routes return 404 not found.

- [ ] **Step 3: Implement bookmarks**

`reading/bookmarks.ts` uses the same live-book and locator-kind guard as annotations. `listBookmarks` filters own rows with `deletedAt IS NULL`, ordered `createdAt DESC, id DESC`. `createBookmark` inserts the normalized label (schema turns blank into `null`). `updateBookmark` updates `label` and `updatedAt` where id/book/user/live; no row → 404. `deleteBookmark` soft-deletes with the same ownership predicate; no row → 404.

`reading/dto.ts`: `toBookmarkDto(row): BookmarkDto`.

`reading/routes.ts`: add the four routes with `requireAuth`; `bookmarkId` validated with `z.uuid()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bookr/server test reading-bookmarks`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/reading apps/server/test/reading-bookmarks.test.ts
git commit -m "feat(server): add user-scoped bookmarks"
```

---

### Task 7: reader-core scaffold, engine contract and settings

**Files:**
- Create: `packages/reader-core/package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `packages/reader-core/src/types.ts`, `src/settings.ts`, `src/locator.ts`, `src/emitter.ts`, `src/index.ts`
- Test: `packages/reader-core/src/__tests__/settings.test.ts`, `src/__tests__/locator.test.ts`

**Interfaces:**
- Produces the exact `ReaderEngine` contract used by Tasks 8–11:
```ts
import type { AnnotationColor, Locator, ReaderKind } from '@bookr/shared';

export type ReaderThemeName = 'paper' | 'sepia' | 'green' | 'dark';
export type PdfLayoutMode = 'continuous' | 'single' | 'double';
export type EpubFlow = 'paginated' | 'scrolled';
export type EpubFontFamily = 'serif' | 'sans';

export interface ReaderSettings {
  theme: ReaderThemeName;
  brightness: number; // 0.6–1.2
  pdf: {
    mode: PdfLayoutMode; zoom: number | 'fit-width' | 'fit-page';
    crop: 'auto' | 'none';
    cropAdjust: { top: number; right: number; bottom: number; left: number }; // 0–10 (%)
  };
  epub: {
    flow: EpubFlow; fontFamily: EpubFontFamily; fontSize: number;
    lineHeight: number; margin: number; spread: 'none' | 'auto';
  };
}

export interface ReaderSelection {
  text: string;
  locator: Locator;
  /** Viewport CSS pixels, for positioning the floating menu. */
  rect: { left: number; top: number; width: number; height: number };
}
export interface ReaderHighlight {
  id: string; locator: Locator; color: AnnotationColor; hasNote: boolean;
}
export interface TocItem {
  id: string; label: string; depth: number; locator: Locator; children: TocItem[];
}
export interface ReaderDocumentInfo {
  kind: ReaderKind; title: string | null; pageCount: number | null; toc: TocItem[];
}
export interface ReaderEventMap {
  relocated: { locator: Locator; percent: number };
  selection: ReaderSelection | null;
  highlightClick: { id: string };
  error: { code: 'load-failed' | 'render-failed'; message: string };
}
export interface OpenReaderOptions {
  initialLocator?: Locator;
  workerSrc?: string;           // pdf.js worker URL, supplied by the web build
  cMapUrl?: string;             // PDF CMaps, default '/cmaps/'
  standardFontDataUrl?: string; // PDF standard fonts, default '/standard_fonts/'
}
export interface ReaderEngine {
  readonly kind: ReaderKind;
  open(url: string, container: HTMLElement, settings: ReaderSettings, options?: OpenReaderOptions): Promise<ReaderDocumentInfo>;
  goTo(locator: Locator, options?: { flash?: boolean }): Promise<void>;
  goToPercent(percent: number): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  currentLocator(): Locator;
  setSettings(settings: ReaderSettings): void;
  setHighlights(highlights: ReaderHighlight[]): void;
  on<K extends keyof ReaderEventMap>(event: K, listener: (payload: ReaderEventMap[K]) => void): () => void;
  destroy(): Promise<void>;
}
```
- Produces `DEFAULT_READER_SETTINGS`, `mergeReaderSettings(unknown): ReaderSettings`, `READER_THEME_COLORS`, `HIGHLIGHT_HEX`.
- Produces `clamp`, `normalizeRect`, `percentForPage`, `pageForPercent`, `isPdfLocator`, `isEpubLocator`.
- Produces `TypedEmitter<K, Map>` internal class.

- [ ] **Step 1: Write the failing settings and locator tests**

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_READER_SETTINGS, mergeReaderSettings } from '../settings';

describe('reader settings', () => {
  it('merges nested sections without losing sibling defaults', () => {
    const settings = mergeReaderSettings({ epub: { fontSize: 22 } });
    expect(settings.epub.fontSize).toBe(22);
    expect(settings.epub.lineHeight).toBe(1.8);
    expect(settings.pdf).toEqual(DEFAULT_READER_SETTINGS.pdf);
    expect(settings.pdf).toMatchObject({ crop: 'auto', cropAdjust: { top: 0, right: 0, bottom: 0, left: 0 } });
    expect(settings.theme).toBe('paper');
  });

  it('clamps values and ignores unknown enums', () => {
    const settings = mergeReaderSettings({
      brightness: 5, theme: 'neon',
      epub: { fontSize: 99, lineHeight: 0, margin: -4, flow: 'explode' },
      pdf: { zoom: 99, mode: 'flip', crop: 'sometimes', cropAdjust: { top: 99, right: -2, bottom: 3, left: 0 } },
    } as unknown);
    expect(settings.brightness).toBe(1.2);
    expect(settings.theme).toBe('paper');
    expect(settings.epub).toMatchObject({ fontSize: 28, lineHeight: 1.4, margin: 2, flow: 'paginated' });
    expect(settings.pdf).toMatchObject({ zoom: 4, mode: 'continuous', crop: 'auto' });
    expect(settings.pdf.cropAdjust).toEqual({ top: 10, right: 0, bottom: 3, left: 0 });
  });
});
```

```ts
import { describe, expect, it } from 'vitest';
import { normalizeRect, pageForPercent, percentForPage } from '../locator';

describe('reader locator math', () => {
  it('converts a page position to a 0–1 percentage', () => {
    expect(percentForPage(1, 10)).toBe(0);
    expect(percentForPage(10, 10)).toBe(0.9);
    expect(percentForPage(5, 10, 0.5)).toBe(0.45);
    expect(percentForPage(99, 10)).toBe(0.9);
  });

  it('converts a percentage back to a page', () => {
    expect(pageForPercent(0, 10)).toBe(1);
    expect(pageForPercent(0.45, 10)).toBe(5);
    expect(pageForPercent(1, 10)).toBe(10);
  });

  it('normalizes client rects against the page box and clamps overflow', () => {
    const bounds = { left: 100, top: 50, width: 200, height: 400 };
    expect(normalizeRect({ left: 120, top: 70, width: 20, height: 40 }, bounds))
      .toEqual({ x: 0.1, y: 0.05, w: 0.1, h: 0.1 });
    expect(normalizeRect({ left: 290, top: 440, width: 40, height: 40 }, bounds))
      .toEqual({ x: 0.95, y: 0.975, w: 0.05, h: 0.025 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bookr/reader-core test`
Expected: FAIL — package/scripts or modules missing.

- [ ] **Step 3: Scaffold the package and implement the utilities**

`packages/reader-core/package.json`: name `@bookr/reader-core`, `type: module`, `main`/`types`/`exports` pointing at `./src/index.ts`, scripts `test` (`vitest run`) and `typecheck` (`tsc -p tsconfig.json --noEmit`); dependencies `@bookr/shared` (workspace), `epubjs` `^0.3.93`, `pdfjs-dist` `^6.4.299`; devDependencies `jsdom`, `typescript`, `vitest`.

`tsconfig.json`: extends `../../tsconfig.base.json`, `module/moduleResolution` ESNext/Bundler, `lib: ["ES2023","DOM","DOM.Iterable"]`, `noEmit: true`, include `src` and `vitest.config.ts`.
`vitest.config.ts`: `environment: 'jsdom'`, include `src/**/*.test.ts`.

Settings implementation:
- `DEFAULT_READER_SETTINGS` exactly: `{ theme: 'paper', brightness: 1, pdf: { mode: 'continuous', zoom: 'fit-width', crop: 'auto', cropAdjust: { top: 0, right: 0, bottom: 0, left: 0 } }, epub: { flow: 'paginated', fontFamily: 'serif', fontSize: 18, lineHeight: 1.8, margin: 6, spread: 'none' } }`.
- `mergeReaderSettings(value: unknown)` accepts a partial, never throws, falls back per field, clamps brightness 0.6–1.2, epub fontSize 14–28, lineHeight 1.4–2.4, margin 2–12, PDF numeric zoom 0.5–4, and `cropAdjust` 0–10 per side.
- `READER_THEME_COLORS` paper/sepia/green/dark with hex values: paper `#F6F1E7/#2B2620`, sepia `#F2E4C9/#3A2E20`, green `#E4EBDD/#2C3327`, dark `#1C1A17/#E6DECF`.
- `HIGHLIGHT_HEX`: yellow `#E8C56B`, green `#9BBF8A`, blue `#8FB4C9`, pink `#D9A6A0`, purple `#B3A0C6`.

`locator.ts`: `clamp`, `percentForPage`, `pageForPercent`, `normalizeRect` as pinned by the tests, plus `isPdfLocator`/`isEpubLocator` type guards. `normalizeRect` must return `x + w <= 1` and `y + h <= 1` even when the client rect overflows the page.

`emitter.ts`: `TypedEmitter<Events extends Record<string, unknown>>` with `on(event, listener): unsubscribe` and `emit(event, payload)`.

`index.ts` re-exports types, settings, locator utilities and emitter.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bookr/reader-core test && pnpm --filter @bookr/reader-core typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/reader-core pnpm-lock.yaml
git commit -m "feat(reader-core): add engine contract and settings"
```

---

### Task 8: PDF original-mode engine

**Files:**
- Create: `packages/reader-core/src/pdf/engine.ts`, `src/pdf/layout.ts`, `src/pdf/selection.ts`, `src/pdf/text-layer.ts`, `src/pdf/outline.ts`, `src/pdf/crop.ts`
- Test: `src/__tests__/pdf-layout.test.ts`, `src/__tests__/pdf-selection.test.ts`, `src/__tests__/pdf-outline.test.ts`, `src/__tests__/pdf-crop.test.ts`

**Interfaces:**
- Consumes: Task 7 `ReaderEngine`, `ReaderSettings`, `ReaderHighlight`, `TocItem`, `normalizeRect`, `percentForPage`.
- Produces `export class PdfReaderEngine implements ReaderEngine { readonly kind = 'pdf' }`.
- Produces pure functions:
  - `computeScale({ page, viewport, zoom, padding? }): number`
  - `spreadStart(page: number): number`
  - `pageFromScroll(scrollTop: number, pageTops: number[], viewportHeight: number): number`
  - `rectsFromClientRects(rects: RectLike[], pageBox: RectLike): LocatorRect[]`
  - `pageTextOf(layer: HTMLElement): string`
  - `charOffsetForRange(layer: HTMLElement, range: Range): number`
  - `buildPdfToc(outline, pageCount, resolvePage): Promise<TocItem[]>`（outline 为空时回退为每页一项）
  - `detectCropMargins(pixels: Uint8ClampedArray, width: number, height: number, threshold?: number): { top; right; bottom; left }`

- [ ] **Step 1: Write the failing pure-function tests**

`pdf-layout.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { computeScale, pageFromScroll, spreadStart } from '../pdf/layout';

const page = { width: 600, height: 800 };
const viewport = { width: 1000, height: 900 };

describe('pdf layout', () => {
  it('computes fit-width, fit-page and numeric zoom', () => {
    expect(computeScale({ page, viewport, zoom: 'fit-width', padding: 24 })).toBeCloseTo(952 / 600, 6);
    expect(computeScale({ page, viewport, zoom: 'fit-page', padding: 24 })).toBeCloseTo(852 / 800, 6);
    expect(computeScale({ page, viewport, zoom: 2, padding: 24 })).toBe(2);
  });

  it('clamps zoom to a usable range', () => {
    expect(computeScale({ page, viewport, zoom: 99, padding: 24 })).toBe(5);
    expect(computeScale({ page, viewport, zoom: 0.1, padding: 24 })).toBe(0.25);
  });

  it('pairs pages for a two-page spread, keeping page 1 alone', () => {
    expect(spreadStart(1)).toBe(1);
    expect(spreadStart(2)).toBe(1);
    expect(spreadStart(4)).toBe(3);
    expect(spreadStart(5)).toBe(5);
  });

  it('finds the page under the reading focus line', () => {
    const tops = [0, 900, 1800];
    expect(pageFromScroll(0, tops, 800)).toBe(1);
    expect(pageFromScroll(950, tops, 800)).toBe(2);
    expect(pageFromScroll(1900, tops, 800)).toBe(3);
  });
});
```

`pdf-selection.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { charOffsetForRange, pageTextOf } from '../pdf/text-layer';
import { rectsFromClientRects } from '../pdf/selection';

it('normalizes multiple client rects against the page box', () => {
  const pageBox = { left: 100, top: 50, width: 200, height: 400 };
  expect(rectsFromClientRects([
    { left: 120, top: 70, width: 20, height: 40 },
    { left: 300, top: 70, width: 20, height: 40 },
    { left: 120, top: 120, width: 60, height: 40 },
  ], pageBox)).toEqual([
    { x: 0.1, y: 0.05, w: 0.1, h: 0.1 },
    { x: 0.95, y: 0.05, w: 0.05, h: 0.1 },
    { x: 0.1, y: 0.175, w: 0.3, h: 0.1 },
  ]);
});

it('computes a stable character offset across text-layer spans', () => {
  const layer = document.createElement('div');
  layer.innerHTML = '<span>Hello </span><span>brave </span><span>world</span>';
  expect(pageTextOf(layer)).toBe('Hello brave world');
  const textNode = layer.querySelectorAll('span')[2]!.firstChild!;
  const range = document.createRange();
  range.setStart(textNode, 3);
  range.setEnd(textNode, 5);
  expect(charOffsetForRange(layer, range)).toBe(15); // "Hello brave " = 12 chars, + 3 into "world"
});

it('returns no rects when the selection is outside the page', () => {
  expect(rectsFromClientRects([], { left: 0, top: 0, width: 100, height: 100 })).toEqual([]);
});
```

`pdf-crop.test.ts`:
```ts
import { expect, it } from 'vitest';
import { detectCropMargins } from '../pdf/crop';

it('finds the non-white content box as fractional margins', () => {
  const width = 10, height = 10;
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 1; y <= 8; y += 1) {
    for (let x = 2; x <= 7; x += 1) {
      const i = (y * width + x) * 4;
      pixels[i] = 0; pixels[i + 1] = 0; pixels[i + 2] = 0; pixels[i + 3] = 255;
    }
  }
  expect(detectCropMargins(pixels, width, height)).toEqual({
    top: 0.1, right: 0.2, bottom: 0.1, left: 0.2,
  });
});

it('returns zero margins for an all-white page', () => {
  expect(detectCropMargins(new Uint8ClampedArray(100 * 4).fill(255), 10, 10))
    .toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
});
```

`pdf-outline.test.ts`:
```ts
import { expect, it } from 'vitest';
import { buildPdfToc } from '../pdf/outline';

it('flattens nested outline items with page locators', async () => {
  const toc = await buildPdfToc([
    { title: '第一章', dest: ['p1'], items: [{ title: '第一节', dest: ['p3'] }] },
    { title: '第二章', dest: ['p8'] },
  ], 10, async (dest) => {
    const key = Array.isArray(dest) ? dest[0] : dest;
    return ({ p1: 1, p3: 3, p8: 8 } as Record<string, number>)[key as string] ?? null;
  });

  expect(toc.map((item) => [item.label, item.depth, item.locator.page])).toEqual([
    ['第一章', 0, 1], ['第一节', 1, 3], ['第二章', 0, 8],
  ]);
  expect(toc[0]!.locator.percent).toBe(0);
  expect(toc[1]!.depth).toBe(1);
  expect(toc[1]!.locator.percent).toBe(0.2);
});

it('falls back to one item per page when the outline is empty', async () => {
  const toc = await buildPdfToc([], 3, async () => null);
  expect(toc.map((item) => item.label)).toEqual(['第 1 页', '第 2 页', '第 3 页']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bookr/reader-core test pdf-`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement the PDF engine**

`types.ts` already carries `workerSrc?: string` (the web layer passes Vite's `?url` file; reader-core must not use Vite-specific imports).

`pdf/engine.ts` structure:
- One module-level `configureWorker(src)` sets `GlobalWorkerOptions.workerSrc` before the first `getDocument`.
- `open(url, container, settings, options)`:
  - `getDocument({ url, cMapUrl: options.cMapUrl ?? '/cmaps/', cMapPacked: true, standardFontDataUrl: options.standardFontDataUrl ?? '/standard_fonts/' })`.
  - Load page 1 to learn the base viewport. When `settings.pdf.crop === 'auto'`, render page 1 once at 200 px wide into an offscreen canvas and call `detectCropMargins`; each detected side is capped at 15%, and all-zero means no crop. Add the manual `cropAdjust` percentages (0–10 per side). The effective crop is stored as four fractions and reduces the page's layout size before `computeScale`.
  - Build `.bookr-pdf-scroll` inside the container; one `.bookr-pdf-page` per page with `data-page`, containing `.bookr-pdf-page-inner` (full unscaled page) which holds the `<canvas>`, `.bookr-text-layer`, `.bookr-highlight-layer`. The outer page box is the cropped size with `overflow: hidden`; the inner box is translated and scaled so the cropped region fills it:
    `translate(-left*baseW*sx, -top*baseH*sy) scale(sx, sy)` with `sx = 1/(1-left-right)`, `sy = 1/(1-top-bottom)` and `transform-origin: 0 0`.
  - Selection rectangles and highlights are normalized against the **inner** full-page box, not the cropped outer box, so changing crop never moves stored locators. Placeholders use the computed cropped page size, so scrolling never jumps when a page renders later.
  - Render page 1 (canvas + text layer) before resolving `open`; enqueue the rest through `IntersectionObserver` (`rootMargin: '150%'`).
  - Resolve the outline once (`pdf.getOutline()`), map destinations to pages, and return `{ kind:'pdf', title: metadata title or null, pageCount, toc }`.
  - If `options.initialLocator` is a PDF locator, `goTo` it after the first render.
- Rendering: keep at most 6 rendered pages (visible ±1 plus the current page). Cancel a page's `renderTask` when it leaves the window. `canvas.width = floor(viewport.width * devicePixelRatio)`; render with `transform: [dpr, 0, 0, dpr, 0, 0]`; CSS size stays in layout pixels.
- Text layer: `new TextLayer({ textContentSource: page.streamTextContent(), container, viewport }).render()`; container sized exactly to the canvas CSS box. The text layer must remain usable when the page is later re-rendered at a new scale.
- Layout modes: `continuous` renders the scroll column; `single` and `double` render only the current page/spread. `spreadStart(n)` decides the pair; page 1 is always alone.
- `goTo`: continuous scrolls the page box to the top (plus `locator.rect.y` when present); single/double switch the current page. `flash` adds `.bookr-flash` to the page or highlight rect for 1200 ms.
- `currentLocator`: continuous uses `pageFromScroll` over the page offsets and the focus line at 35% of the viewport; single/double use the current page. `percent = percentForPage(page, pageCount, fraction)`.
- Selection: one debounced (60 ms) `selectionchange` listener on `document`. Ignore selections outside the container. Build the locator from `rectsFromClientRects`, `charOffsetForRange`, `page`, and `percentForPage(page, pageCount, union.y)`; emit `selection` with the trimmed text. Emit `selection: null` when the selection is empty or outside. A scanned PDF has no spans, so `pageTextOf` is empty and no selection menu appears.
- Highlights: group by page; render one absolutely positioned div per rect (percent-based `left/top/width/height`), fill from `HIGHLIGHT_HEX`, `pointer-events: auto`, `data-highlight-id`; click emits `highlightClick`. Rebuild on every `setHighlights`.
- `setSettings`: re-layout when PDF mode, zoom, crop mode or crop adjustment changed; re-detect auto crop only when the crop mode changes. Preserve the locator across re-layout. Theme is exposed as `container.dataset.readerTheme`; the web stylesheet owns colors.
- `next`/`previous`: continuous scrolls by 85% of the viewport; paged modes move by one page (two in double mode).
- `goToPercent`: page from `pageForPercent`; clamped.
- `destroy`: cancel render tasks, disconnect the observer, remove listeners, clear the container.
- Any load failure throws after emitting `error` with `{ code: 'load-failed' }`; a failed page render emits `render-failed` and leaves the placeholder visible.

`pdf/layout.ts`, `pdf/selection.ts`, `pdf/text-layer.ts`, `pdf/outline.ts`, `pdf/crop.ts` implement the pure functions exactly as the tests pin them. `buildPdfToc` returns a **flat** depth-first list (indentation comes from `depth`; `children` stays `[]` for forward compatibility), assigns `id = \`toc-${path.join('-')}\``, skips items whose destination cannot be resolved, and computes `percent` with `percentForPage`. When the outline is empty or every item is unresolvable, it returns one `第 N 页` item per page with `locator = { kind:'pdf', page:N, percent: percentForPage(N, pageCount) }`. `detectCropMargins` scans luminance `< threshold` (default 245) and returns the fractional white margins; it returns all zeros when the page has no non-white pixels.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @bookr/reader-core test && pnpm --filter @bookr/reader-core typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/reader-core
git commit -m "feat(reader-core): implement the PDF original-mode engine"
```

---

### Task 9: EPUB engine and engine factory

**Files:**
- Create: `packages/reader-core/src/epub/engine.ts`, `src/epub/navigation.ts`, `src/epub/theme.ts`, `src/factory.ts`
- Modify: `packages/reader-core/src/index.ts`
- Test: `src/__tests__/epub-navigation.test.ts`, `src/__tests__/epub-theme.test.ts`, `src/__tests__/factory.test.ts`

**Interfaces:**
- Produces `export class EpubReaderEngine implements ReaderEngine { readonly kind = 'epub' }`.
- Produces `flattenNavigation(items, canonical, depth?): TocItem[]`; `canonical` maps an href to a CFI.
- Produces `epubLocator(cfi, href, percent): EpubLocator`.
- Produces `epubThemeCss(name: ReaderThemeName): string`; `epubOverrides(settings: ReaderSettings): Array<[string, string]>`.
- Produces `createReaderEngine(kind: ReaderKind): ReaderEngine`.

- [ ] **Step 1: Write the failing EPUB pure-function tests**

`epub-navigation.test.ts`:
```ts
import { expect, it } from 'vitest';
import { epubLocator, flattenNavigation } from '../epub/navigation';

it('flattens nested EPUB navigation into depth-tagged toc items', () => {
  const canonical = (href: string) => `cfi:${href}`;
  const toc = flattenNavigation([
    { label: '第一章', href: 'ch1.xhtml' },
    { label: '第二章', href: 'ch2.xhtml', subitems: [
      { label: '第二节', href: 'ch2.xhtml#s2' },
    ] },
  ], canonical);
  expect(toc.map((item) => [item.label, item.depth, item.locator.kind])).toEqual([
    ['第一章', 0, 'epub'], ['第二章', 0, 'epub'], ['第二节', 1, 'epub'],
  ]);
  expect(toc[2]!.locator).toMatchObject({ cfi: 'cfi:ch2.xhtml#s2', href: 'ch2.xhtml#s2' });
});

it('builds an EPUB locator with a clamped percentage', () => {
  expect(epubLocator('epubcfi(/6/4!/2)', 'ch1.xhtml', 0.42))
    .toEqual({ kind: 'epub', cfi: 'epubcfi(/6/4!/2)', href: 'ch1.xhtml', percent: 0.42 });
  expect(epubLocator('epubcfi(/6/4!/2)', undefined, 3).percent).toBe(1);
});
```

`epub-theme.test.ts`:
```ts
import { expect, it } from 'vitest';
import { mergeReaderSettings, DEFAULT_READER_SETTINGS } from '../settings';
import { epubOverrides, epubThemeCss } from '../epub/theme';

it('paints each paper-ink theme inside the epub iframe', () => {
  expect(epubThemeCss('paper')).toContain('background: #F6F1E7');
  expect(epubThemeCss('dark')).toContain('color: #E6DECF');
});

it('maps typography settings to epub overrides', () => {
  const settings = mergeReaderSettings({ epub: { fontSize: 22, lineHeight: 2, margin: 8 } });
  const overrides = Object.fromEntries(epubOverrides(settings));
  expect(overrides['font-size']).toBe('22px');
  expect(overrides['line-height']).toBe('2');
  expect(overrides['padding-left']).toBe('8%');
  expect(overrides['padding-right']).toBe('8%');
  expect(epubOverrides(DEFAULT_READER_SETTINGS).length).toBeGreaterThan(3);
});
```

`factory.test.ts`:
```ts
import { expect, it } from 'vitest';
import { createReaderEngine } from '../factory';
import { PdfReaderEngine } from '../pdf/engine';
import { EpubReaderEngine } from '../epub/engine';

it('creates the engine that matches the reader kind', () => {
  expect(createReaderEngine('pdf')).toBeInstanceOf(PdfReaderEngine);
  expect(createReaderEngine('epub')).toBeInstanceOf(EpubReaderEngine);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bookr/reader-core test epub- factory`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement the EPUB engine and factory**

`epub/navigation.ts`: `flattenNavigation` walks `toc` depth-first; each item becomes a `TocItem` with `id = \`toc-${path.join('-')}\``, `depth`, `children: []`, and `epubLocator(canonical(href), href, 0)`. If `canonical` throws, skip that item. `epubLocator` clamps percent to 0–1 and omits `href` when undefined.

`epub/theme.ts`: four named theme CSS strings, each `body { background: <hex>; color: <hex>; }` plus `a { color: <text>; }`; serif/sans font stacks; `epubOverrides` returns `[['font-size', \`${fontSize}px\`], ['line-height', String(lineHeight)], ['padding-left', \`${margin}%\`], ['padding-right', \`${margin}%\`], ['padding-top', '2%'], ['padding-bottom', '2%']]`.

`epub/engine.ts`:
- `const book = ePub(url, { openAs: 'epub' }); await book.ready;`
- `rendition = book.renderTo(container, { width: '100%', height: '100%', flow: settings.epub.flow, spread: settings.epub.spread, allowScriptedContent: false })`. Scripted content stays disabled; EPUB HTML is untrusted input.
- Register the four themes, select `settings.theme`, apply `epubOverrides` through `themes.override`, and set `themes.font()` from the serif/sans stack.
- Display `options.initialLocator` when it is an EPUB locator, otherwise the first section.
- `title` from `book.loaded.metadata` (`title`), `pageCount: null`, `toc` from `book.loaded.navigation.toc` through `flattenNavigation`.
- `relocated` listener: build `epubLocator(start.cfi, start.href, percent)`, where percent comes from `book.locations.percentageFromCfi(start.cfi)` when locations exist, else `start.percentage ?? 0`; clamp and emit.
- After the first display, call `book.locations.generate(1600)` without blocking `open`; when it resolves, re-emit the current location so the footer percentage becomes exact.
- Selection: `rendition.on('selected', (cfiRange, contents) => ...)` reads `contents.window.getSelection()`, and computes the menu rect from `range.getBoundingClientRect()` plus the iframe element's `getBoundingClientRect()`. Register a `selectionchange` listener on each rendered `contents` document to emit `selection: null` when collapsed.
- Highlights: keep the applied CFI set; before applying a new list, call `rendition.annotations.remove(cfi, 'highlight')` for every previously applied CFI; add with `annotations.highlight(cfi, { id }, () => emit('highlightClick', { id }), 'bookr-epub-hl', { fill: HIGHLIGHT_HEX[color], 'fill-opacity': '0.35' })`. Reapplying the same full list must not duplicate or throw.
- `goTo`: try `rendition.display(cfi)`, fall back to `href` when the CFI fails, and on both failing emit `error` `{ code: 'render-failed' }` without throwing. `goToPercent`: use `book.locations.cfiFromPercentage` when locations exist; otherwise remember the percent and apply it right after generation.
- `setSettings`: theme/font changes apply immediately through themes/overrides. A change to `flow` or `spread` saves the current locator, destroys and recreates the rendition, displays the saved CFI, then reapplies highlights and listeners.
- `next`/`previous`: `rendition.next()` / `rendition.prev()`.
- `currentLocator`: returns the last relocated locator; before the first relocation it throws `Error('Reader is not open')`.
- `destroy`: remove rendition listeners, `rendition.destroy()`, `book.destroy()`, clear the container.

`factory.ts`: `createReaderEngine(kind)` returns a new `PdfReaderEngine` or `EpubReaderEngine`; export it and the two classes from `index.ts`.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @bookr/reader-core test && pnpm --filter @bookr/reader-core typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/reader-core
git commit -m "feat(reader-core): implement the EPUB engine and factory"
```

---

### Task 10: Reader page, autosave and reading settings

**Files:**
- Create: `apps/web/src/api/reading.ts`
- Create: `apps/web/src/features/reader/{ReaderPage,ReaderChrome,ReaderContent,TocPanel,SettingsPanel}.tsx`
- Create: `apps/web/src/features/reader/{readerSettings,progressStore,useReaderProgress,colors}.ts`, `reader.css`
- Modify: `apps/web/src/app/router.tsx`, `apps/web/src/features/bookshelf/BookCard.tsx`, `apps/web/src/features/bookshelf/UploadDialog.tsx`, `apps/web/src/lib/errorMessages.ts`, `apps/web/package.json`, `apps/web/vite.config.ts`, `apps/web/Dockerfile`, `apps/web/test/setup.ts`
- Test: `apps/web/src/features/reader/__tests__/reader-settings.test.ts`, `progress-store.test.ts`, `reader-page.test.tsx`

**Interfaces:**
- Consumes: Task 3 `GET /api/books/:id/file`; Task 4 progress API; Task 7–9 `createReaderEngine`, `ReaderEngine`, `ReaderSettings`.
- Produces API functions `fetchReaderFile`, `fetchProgress`, `saveProgress`; Task 11 extends the same module.
- Produces `loadReaderSettings(): ReaderSettings`, `saveReaderSettings(settings): void`.
- Produces `readLocalProgress(bookId)`, `writeLocalProgress(bookId, locator, savedAt)`, `resolveInitialLocator(server, local)`.
- Produces route `/books/:id/read` rendered outside `AppLayout`; `/books/:id` redirects to it.

- [ ] **Step 1: Write the failing settings and progress-cache tests**

```ts
import { beforeEach, expect, it } from 'vitest';
import { DEFAULT_READER_SETTINGS } from '@bookr/reader-core';
import { loadReaderSettings, saveReaderSettings, READER_SETTINGS_KEY } from '../readerSettings';

beforeEach(() => localStorage.clear());

it('returns defaults when nothing is stored or the payload is corrupt', () => {
  expect(loadReaderSettings()).toEqual(DEFAULT_READER_SETTINGS);
  localStorage.setItem(READER_SETTINGS_KEY, '{not json');
  expect(loadReaderSettings()).toEqual(DEFAULT_READER_SETTINGS);
});

it('round-trips a merged settings object', () => {
  saveReaderSettings({ ...DEFAULT_READER_SETTINGS, theme: 'dark', epub: { ...DEFAULT_READER_SETTINGS.epub, fontSize: 24 } });
  expect(loadReaderSettings()).toMatchObject({ theme: 'dark', epub: { fontSize: 24 } });
});
```

```ts
import { beforeEach, expect, it } from 'vitest';
import { readLocalProgress, resolveInitialLocator, writeLocalProgress } from '../progressStore';

const pdf = { kind: 'pdf' as const, page: 4, percent: 0.3 };

beforeEach(() => localStorage.clear());

it('prefers the newer of local and server progress', () => {
  const server = { bookId: 'b', locator: pdf, percent: 0.3, updatedAt: '2026-03-01T00:00:00.000Z' };
  writeLocalProgress('b', { ...pdf, page: 7, percent: 0.6 }, new Date('2026-02-01T00:00:00Z').getTime());
  expect(resolveInitialLocator(server, readLocalProgress('b')))
    .toEqual({ ...pdf, page: 4, percent: 0.3 });

  writeLocalProgress('b', { ...pdf, page: 7, percent: 0.6 }, new Date('2026-04-01T00:00:00Z').getTime());
  expect(resolveInitialLocator(server, readLocalProgress('b')))
    .toEqual({ ...pdf, page: 7, percent: 0.6 });
});

it('falls back to local when the server has no progress', () => {
  writeLocalProgress('b', pdf, Date.now());
  expect(resolveInitialLocator(null, readLocalProgress('b'))).toEqual(pdf);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bookr/web test reader-settings progress-store`
Expected: FAIL — modules missing.

- [ ] **Step 3: Write the failing reader-page test**

`ReaderPage` accepts an optional `engineFactory?: (kind: ReaderKind) => ReaderEngine` prop, defaulting to the real `createReaderEngine`; the route passes nothing. Tests inject a recording fake instead of mocking pdf.js/epub.js.

```tsx
import { screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { http, HttpResponse } from 'msw';
import { ReaderPage } from '../ReaderPage';
import { setTokens } from '../../../api/client';
import { renderWithProviders, server } from '../../../../test/setup';
import type { ReaderEngine } from '@bookr/reader-core';

function fakeEngine() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    kind: 'pdf' as const,
    open: vi.fn(async () => ({ kind: 'pdf', title: '测试书', pageCount: 10, toc: [] })),
    goTo: vi.fn(async () => {}), goToPercent: vi.fn(async () => {}),
    next: vi.fn(async () => {}), previous: vi.fn(async () => {}),
    currentLocator: vi.fn(() => ({ kind: 'pdf', page: 2, percent: 0.42 })),
    setSettings: vi.fn(), setHighlights: vi.fn(),
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      const set = listeners.get(event) ?? new Set(); set.add(listener); listeners.set(event, set);
      return () => set.delete(listener);
    }),
    destroy: vi.fn(async () => {}),
    emit(event: string, payload: unknown) { listeners.get(event)?.forEach((listener) => listener(payload)); },
  };
}

it('opens the file at the saved locator and shows the reading chrome', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  server.use(
    http.get('/api/books/book-csapp/file', () => HttpResponse.json({
      url: 'https://files.test/book.pdf', format: 'pdf', expiresIn: 3600,
    })),
    http.get('/api/books/book-csapp/progress', () => HttpResponse.json({
      progress: {
        bookId: 'book-csapp', locator: { kind: 'pdf', page: 2, percent: 0.42 },
        percent: 0.42, updatedAt: new Date().toISOString(),
      },
    })),
  );
  const engine = fakeEngine();
  const factory = vi.fn(() => engine as unknown as ReaderEngine);
  const router = createMemoryRouter(
    [{ path: '/books/:id/read', element: <ReaderPage engineFactory={factory} /> }],
    { initialEntries: ['/books/book-csapp/read'] },
  );
  renderWithProviders(<RouterProvider router={router} />);

  expect(await screen.findByRole('heading', { name: '深入理解计算机系统' })).toBeInTheDocument();
  await waitFor(() => expect(engine.open).toHaveBeenCalledWith(
    'https://files.test/book.pdf',
    expect.any(HTMLElement),
    expect.objectContaining({ theme: 'paper' }),
    expect.objectContaining({ initialLocator: { kind: 'pdf', page: 2, percent: 0.42 } }),
  ));
  engine.emit('relocated', { locator: { kind: 'pdf', page: 3, percent: 0.3 }, percent: 0.3 });
  expect(await screen.findByText(/第 3 \/ 10 页/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '目录' })).toBeInTheDocument();
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm --filter @bookr/web test reader-settings progress-store reader-page`
Expected: FAIL — modules/components missing.

- [ ] **Step 5: Implement the API, cache, engine lifecycle and page shell**

`package.json`: add `@bookr/reader-core: workspace:*`, `pdfjs-dist: ^6.4.299`; dev `vite-plugin-static-copy: ^4.1.1`. `vite.config.ts` copies `node_modules/pdfjs-dist/cmaps` → `cmaps` and `standard_fonts` → `standard_fonts` in dev and build. `Dockerfile` copies `packages/reader-core/package.json` before install and `packages/reader-core` before build.

`api/reading.ts`: `fetchReaderFile(bookId)`, `fetchProgress(bookId)` (returns `progress` or null), `saveProgress(bookId, locator)` via `PUT`. All through `apiFetch`.

`readerSettings.ts`: key `bookr.reader.settings.v1`; read → `mergeReaderSettings(JSON.parse(...))`; corrupted/unavailable storage → defaults; write merges and clamps first.

`progressStore.ts`: key prefix `bookr.reader.progress.`; stored `{ locator, savedAt }`; `resolveInitialLocator(server, local)` returns the newer locator by `savedAt` vs `Date.parse(server.updatedAt)`, then the server locator, then the local locator, else `undefined`.

`useReaderProgress({ bookId, engine, initialLocator })`:
- subscribes to `relocated`; keeps `percent` and `dirty` refs.
- writes localStorage at most once per 5 seconds (leading write, trailing timeout).
- calls `saveProgress` every 30 seconds only when dirty, and flushes once on `pagehide`, on `visibilitychange` to hidden, and on unmount. Failures set `saveState='error'` but never throw.
- exposes `{ percent, saveState }`, labels 已保存 / 保存中 / 未同步.

`ReaderPage`:
- `useParams`, `useBook(id)`; error when missing or trashed.
- `kind = readerKindForFormat(book.format)`; engine created once per `(book.id, kind)` via `engineFactory`.
- Load file URL and progress in parallel, compute the initial locator from server + local cache, then `engine.open(...)` with `{ initialLocator, workerSrc: pdfWorkerUrl, cMapUrl: '/cmaps/', standardFontDataUrl: '/standard_fonts/' }`. `pdfWorkerUrl` comes from `import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'` and is only passed for PDF.
- State machine: loading → ready | error. `BOOK_NOT_READY` shows 「这本书正在转换，完成后即可阅读」; `FILE_MISSING`/404 shows 「找不到这本书的文件」; engine load failure shows 「无法打开这本书，请确认文件完整」.
- Layout: `.reader-root` fixed inset 0 with `data-reader-theme`, `.reader-content` scroll host, brightness overlay (`opacity = 1 - brightness`, pointer-events none), `<ReaderChrome>`, panels. The reader route renders outside `AppLayout`.
- `ReaderChrome`: top bar (back link labelled `返回书架`, serif title/author, 目录/书签/笔记/设置/fullscreen) and bottom bar (上一页, page or percent label, slider, 下一页). Auto-hides after 2.5 s without pointer/keyboard activity when no panel is open; center tap toggles; click on chrome resets the timer.
- Keyboard: arrows/PageUp/PageDown navigate, `t` TOC, `b` bookmark, `f` fullscreen, Escape closes panels. Ignore keys while an input/textarea is focused.
- Touch: when chrome is hidden, a tap in the left 25% goes back, right 25% forward, middle toggles chrome.
- `TocPanel` renders the flat `documentInfo.toc` with left padding `depth * 12px`; an empty list shows `暂无目录`; selecting calls `engine.goTo(locator, { flash: true })` and closes.
- `SettingsPanel`: theme swatches (纸白/米黄/护眼绿/深色), brightness slider 0.6–1.2, PDF mode/zoom, EPUB flow/font family/font size/line height/margin/spread. Every change saves settings and calls `engine.setSettings`.
- `reader.css`: page wrappers, canvas sizing, text-layer rules (absolute spans, transparent text, selection color), highlight layers, chrome transitions, dark-theme canvas filter for PDF, iframe sizing for EPUB. The `.bookr-text-layer` rules must match pdf.js 6: absolute inset 0, `line-height: 1`, `text-size-adjust: none`, spans `position:absolute; white-space:pre; color:transparent; transform-origin:0 0`.

`router.tsx`: add `books/:id/read` as a sibling of `AppLayout` under `RequireAuth`; replace the `books/:id` placeholder with a `BookRedirect` that reads `:id` and renders `<Navigate to={\`/books/${id}/read\`} replace />`; delete `BookPlaceholderPage.tsx`. `BookCard` gains a `阅读《title》` link to `/books/:id/read`; `UploadDialog`'s duplicate link can keep `/books/:id` (it now redirects).

`errorMessages.ts`: `BOOK_NOT_READY: '这本书正在转换，请稍后再试'`, `FILE_MISSING: '这本书的文件不存在'`.

`test/setup.ts`: add MSW handlers for `GET /api/books/:id/file` (pdf fixture URL), `GET /api/books/:id/progress` (null), `PUT .../progress` (echo). They must not interfere with existing shelf tests.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @bookr/web test reader-settings progress-store reader-page`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web packages/reader-core pnpm-lock.yaml
git commit -m "feat(web): add the reader page with autosaved progress"
```

---

### Task 11: Highlights, notes and bookmarks UI

**Files:**
- Create: `apps/web/src/features/reader/{SelectionMenu,AnnotationDialog,AnnotationsPanel,BookmarkDialog,BookmarksPanel}.tsx`
- Modify: `apps/web/src/api/reading.ts`, `ReaderPage.tsx`, `ReaderChrome.tsx`, `reader.css`, `test/setup.ts`
- Test: `apps/web/src/features/reader/__tests__/reader-annotations.test.tsx`, `reader-bookmarks.test.tsx`, `fake-engine.ts`

**Interfaces:**
- API: `fetchAnnotations(bookId)`, `createAnnotation(bookId, input)`, `updateAnnotation(bookId, annotationId, patch)`, `deleteAnnotation(bookId, annotationId)`, `fetchBookmarks(bookId)`, `createBookmark(bookId, input)`, `updateBookmark(bookId, bookmarkId, patch)`, `deleteBookmark(bookId, bookmarkId)`.
- `SelectionMenu` props: `{ selection, onHighlight(color), onNote(color), onCopy(), onDismiss() }`.
- `AnnotationDialog` props: `{ open, mode: 'create'|'edit', initial?: AnnotationDto, draft?: { locator, selectedText, color }, onClose, onSaved }`.
- `BookmarkDialog` props: `{ open, bookId, locator, initial?: BookmarkDto, onClose, onSaved }`.

- [ ] **Step 1: Write the failing annotation UI tests**

`fake-engine.ts` exports the same recording fake used in Task 10 plus `emit`.

```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { http, HttpResponse } from 'msw';
import { ReaderPage } from '../ReaderPage';
import { setTokens } from '../../../api/client';
import { renderWithProviders, server } from '../../../../test/setup';
import { createFakeEngine } from './fake-engine';

it('creates a highlight from a text selection and renders it in the engine', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  let posted: Record<string, unknown> | null = null;
  server.use(
    http.get('/api/books/book-csapp/file', () => HttpResponse.json({
      url: 'https://files.test/book.pdf', format: 'pdf', expiresIn: 3600,
    })),
    http.get('/api/books/book-csapp/annotations', () => HttpResponse.json({ items: [] })),
    http.post('/api/books/book-csapp/annotations', async ({ request }) => {
      posted = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({
        annotation: { id: 'a1', bookId: 'book-csapp', revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), noteText: null, tags: [], ...posted },
      }, { status: 201 });
    }),
  );
  const engine = createFakeEngine();
  const router = createMemoryRouter(
    [{ path: '/books/:id/read', element: <ReaderPage engineFactory={() => engine} /> }],
    { initialEntries: ['/books/book-csapp/read'] },
  );
  renderWithProviders(<RouterProvider router={router} />);
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  engine.emit('selection', {
    text: '被选中的原文',
    locator: { kind: 'pdf', page: 2, percent: 0.2, rect: { x: 0.1, y: 0.2, w: 0.4, h: 0.03 } },
    rect: { left: 10, top: 20, width: 100, height: 18 },
  });
  await userEvent.click(await screen.findByRole('button', { name: '用黄色划线' }));
  await waitFor(() => expect(posted).toMatchObject({
    type: 'highlight', color: 'yellow', selectedText: '被选中的原文',
  }));
  await waitFor(() => expect(engine.setHighlights).toHaveBeenCalledWith([
    expect.objectContaining({ id: 'a1', color: 'yellow', hasNote: false }),
  ]));
});

it('creates a note with text and jumps back from the notes panel', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  server.use(
    http.get('/api/books/book-csapp/file', () => HttpResponse.json({
      url: 'https://files.test/book.pdf', format: 'pdf', expiresIn: 3600,
    })),
    http.get('/api/books/book-csapp/annotations', () => HttpResponse.json({
      items: [{
        id: 'n1', bookId: 'book-csapp', type: 'note', color: 'blue',
        locator: { kind: 'pdf', page: 4, percent: 0.3 }, selectedText: '原文',
        noteText: '我的批注', tags: ['历史'], revision: 1,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }],
    })),
  );
  const engine = createFakeEngine();
  const router = createMemoryRouter(
    [{ path: '/books/:id/read', element: <ReaderPage engineFactory={() => engine} /> }],
    { initialEntries: ['/books/book-csapp/read'] },
  );
  renderWithProviders(<RouterProvider router={router} />);
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  await userEvent.click(screen.getByRole('button', { name: '笔记' }));
  await userEvent.click(await screen.findByText('我的批注'));
  expect(engine.goTo).toHaveBeenCalledWith(
    { kind: 'pdf', page: 4, percent: 0.3 }, { flash: true },
  );
});
```

`reader-bookmarks.test.tsx` follows the same shape: click 书签 to open the bookmark list, click 添加书签, fill 书签备注, save, and expect POST body `{ locator, label }`; click the saved label → `engine.goTo`; delete → DELETE called and the row disappears.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bookr/web test reader-annotations reader-bookmarks`
Expected: FAIL — selection menu and panels missing.

- [ ] **Step 3: Implement the annotation and bookmark UI**

`api/reading.ts` adds the eight functions, all typed with `AnnotationDto`, `AnnotationMutationResult`, `BookmarkDto` and the shared input types; update uses `PATCH` with `revision`.

`ReaderPage` data flow:
- `useQuery(['annotations', bookId])` and `useQuery(['bookmarks', bookId])`; mutations invalidate the matching key.
- When annotations change, call `engine.setHighlights(annotations.map(({ id, locator, color, noteText }) => ({ id, locator, color, hasNote: Boolean(noteText) })))`.
- Subscribe to `selection` and `highlightClick`. A selection sets `SelectionMenu`; clicking a highlight opens `AnnotationDialog` in edit mode for that annotation.
- `SelectionMenu`: five color buttons with accessible names `用黄色划线`, `用绿色划线`, `用蓝色划线`, `用粉色划线`, `用紫色划线`; plus `写批注` and `复制`. Clicking a color creates a highlight immediately; `写批注` opens the dialog with the chosen color (default yellow). Copy uses `navigator.clipboard.writeText` and shows `已复制`. Dismiss on outside pointerdown, Escape, or scroll; do not dismiss while the dialog is open.
- `AnnotationDialog`: textarea labelled `批注内容`, tag input labelled `标签（用逗号分隔）`, color swatches, `保存批注`/`取消` buttons. Create posts `type: 'note'`; edit patches `{ noteText, color, tags, revision }`. On `conflict: true`, show `已在其他设备更新，旧版本已保留` and use the returned annotation. If an edit clears the note text of a `note`, keep it as a highlight: send a PATCH with a new text? No — the server rejects blank note text for notes; the UI thus requires text and only offers delete for clearing. Delete asks for confirmation (`确认删除`).
- `AnnotationsPanel`: list own annotations; each row shows a color bar, `selectedText` excerpt, note text, tags and time; actions `跳转`, `编辑`, `删除`. Jump calls `engine.goTo(locator, { flash: true })` and closes the panel. Empty state `还没有划线和批注`.
- `BookmarkDialog`: current locator captured when opened; label field labelled `书签备注` (optional); `保存书签`/`取消` buttons. Create posts `{ locator, label }`; edit patches `{ label }`.
- `BookmarksPanel`: list rows with label or `第 N 页`/`位置`; actions `跳转`, `重命名`, `删除`; empty state `还没有书签`.
- `ReaderChrome` wires buttons to panels and keeps the current relative time formatting consistent with the shelf (`formatDate`).
- `reader.css`: selection menu fixed above the selection (flip below when near the top), five swatch classes, highlight `mix-blend-mode: multiply` for light themes and `screen` for dark, note dot indicator.

`test/setup.ts`: add mutable `annotations` and `bookmarks` fixture arrays and handlers for GET/POST/PATCH/DELETE. New annotations echo the posted payload with `id: \`annotation-${n}\``, `revision: 1`, timestamps; PATCH increments revision and returns `{ annotation, conflict: false }`; DELETE removes. Bookmarks behave analogously. `resetFixtures` clears both arrays.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bookr/web test reader-annotations reader-bookmarks reader-page`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): add highlights, notes and bookmarks to the reader"
```

---

### Task 12: Reading controls, keyboard and responsive behavior

**Files:**
- Modify: `apps/web/src/features/reader/{ReaderPage,ReaderChrome,SettingsPanel,ReaderContent}.tsx`, `reader.css`
- Test: `apps/web/src/features/reader/__tests__/reader-controls.test.tsx`

**Interfaces:**
- Consumes Tasks 10–11 components and the fake engine.
- Produces accessible control names used by E2E and tests: `目录`, `书签`, `笔记`, `设置`, `全屏`, `上一页`, `下一页`, `阅读进度`.

- [ ] **Step 1: Write the failing control tests**

```tsx
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { http, HttpResponse } from 'msw';
import { ReaderPage } from '../ReaderPage';
import { setTokens } from '../../../api/client';
import { renderWithProviders, server } from '../../../../test/setup';
import { createFakeEngine } from './fake-engine';

async function renderReader() {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  server.use(http.get('/api/books/book-csapp/file', () => HttpResponse.json({
    url: 'https://files.test/book.pdf', format: 'pdf', expiresIn: 3600,
  })));
  const engine = createFakeEngine();
  const router = createMemoryRouter(
    [{ path: '/books/:id/read', element: <ReaderPage engineFactory={() => engine} /> }],
    { initialEntries: ['/books/book-csapp/read'] },
  );
  renderWithProviders(<RouterProvider router={router} />);
  await waitFor(() => expect(engine.open).toHaveBeenCalled());
  return engine;
}

it('applies and persists theme, zoom and font changes', async () => {
  const engine = await renderReader();
  await userEvent.click(screen.getByRole('button', { name: '设置' }));
  await userEvent.click(screen.getByRole('button', { name: '深色主题' }));
  expect(engine.setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'dark' }));
  expect(JSON.parse(localStorage.getItem('bookr.reader.settings.v1')!)).toMatchObject({ theme: 'dark' });

  await userEvent.selectOptions(screen.getByLabelText('缩放'), 'fit-page');
  expect(engine.setSettings).toHaveBeenLastCalledWith(
    expect.objectContaining({ pdf: expect.objectContaining({ zoom: 'fit-page' }) }),
  );

  await userEvent.click(screen.getByLabelText('自动裁边'));
  await userEvent.clear(screen.getByLabelText('裁边上边'));
  await userEvent.type(screen.getByLabelText('裁边上边'), '5');
  expect(engine.setSettings).toHaveBeenLastCalledWith(
    expect.objectContaining({ pdf: expect.objectContaining({
      crop: 'none', cropAdjust: expect.objectContaining({ top: 5 }),
    }) }),
  );
});

it('navigates with keyboard and jumps with the progress slider', async () => {
  const engine = await renderReader();
  await userEvent.keyboard('{ArrowRight}');
  expect(engine.next).toHaveBeenCalled();
  await userEvent.keyboard('{ArrowLeft}');
  expect(engine.previous).toHaveBeenCalled();

  const slider = screen.getByLabelText('阅读进度');
  fireEvent.change(slider, { target: { value: '50' } });
  expect(engine.goToPercent).toHaveBeenLastCalledWith(0.5);

  await userEvent.clear(screen.getByLabelText('页码'));
  await userEvent.type(screen.getByLabelText('页码'), '7{Enter}');
  expect(engine.goTo).toHaveBeenLastCalledWith(
    expect.objectContaining({ kind: 'pdf', page: 7 }),
  );
});

it('hides the chrome after inactivity and reveals it on a center tap', async () => {
  await renderReader();
  expect(screen.getByRole('button', { name: '目录' })).toBeInTheDocument();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2600)); });
  expect(screen.queryByRole('button', { name: '目录' })).toBeNull();
  await userEvent.click(screen.getByTestId('reader-content'));
  expect(screen.getByRole('button', { name: '目录' })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bookr/web test reader-controls`
Expected: FAIL — missing labels/behavior.

- [ ] **Step 3: Implement the controls**

- `SettingsPanel` uses labelled controls: `缩放` (select: 适应宽度/适应页面/75%/100%/125%/150%), `页面布局` (连续/单页/双页), `自动裁边` checkbox, four `裁边上边/右边/下边/左边` sliders (0–10%), `主题` buttons with names `纸白主题`/`米黄主题`/`护眼绿主题`/`深色主题`, `亮度` range, EPUB `字体` (衬线/无衬线), `字号`, `行距`, `页边距`, `排版` (分页/滚动), `分栏` (单栏/双栏). Changes merge into `ReaderSettings`, persist, and call `engine.setSettings`.
- Bottom bar slider: `aria-label="阅读进度"`, PDF `min=1 max=pageCount value=currentPage`, EPUB `min=0 max=100`. On change, PDF calls `engine.goTo(pageLocator)`; EPUB calls `engine.goToPercent(value/100)`. Do not save on every slider tick; the engine's `relocated` drives autosave.
- PDF page jump: a number input labelled `页码` plus a `跳转` button; Enter in the input also jumps. Clamp to `1..pageCount` and call `engine.goTo({ kind:'pdf', page, percent: percentForPage(page, pageCount) })`.
- `全屏` calls `document.documentElement.requestFullscreen()` and `document.exitFullscreen()`; ignore absence/rejection.
- Keyboard handler on `window` (ignores `input`, `textarea`, `select`, `[contenteditable]`): ArrowRight/PageDown/Space → next; ArrowLeft/PageUp → previous; `t` toggles TOC; `b` opens bookmark dialog; `f` toggles fullscreen; Escape closes panels/menu.
- Auto-hide: pointer/keyboard activity shows chrome and resets a 2500 ms timer; the timer is suspended while any panel/dialog is open and resumed on close. `ReaderContent` has `data-testid="reader-content"`; a tap in the middle 50% toggles chrome, left 25% previous, right 25% next. Do not treat a tap that ends a text selection as navigation.
- `reader.css`: hide chrome with `opacity-0 pointer-events-none` rather than unmount to avoid reflow; but tests expect the button to be absent from the accessibility tree, so use conditional rendering when hidden, or `aria-hidden` plus `inert`. Use conditional rendering.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bookr/web test reader-controls`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): finish reader controls, keyboard and touch navigation"
```

---

### Task 13: Reader end-to-end acceptance

**Files:**
- Create: `apps/web/scripts/make-reader-fixtures.mjs`
- Modify: `apps/web/e2e/global-setup.ts`, `apps/web/package.json`, `.gitignore`
- Test: `apps/web/e2e/reader.spec.ts`

**Interfaces:**
- Consumes the deployed Compose stack from Plan 1 plus this plan's reader UI.
- Produces deterministic fixtures `apps/web/e2e/fixtures/reader.pdf` (300 pages) and `reader.epub` (2 chapters), generated by the script.
- Guards: the same localhost-only and `E2E_ALLOW_REMOTE=1` rule as the shelf suite.

- [ ] **Step 1: Write the failing acceptance spec**

`reader.spec.ts` opens a real PDF and EPUB, and checks: first paint, text selection → highlight, note persistence, bookmark persistence, progress restore, TOC jump and EPUB highlight.

```ts
import { expect, test } from '@playwright/test';

const PDF_TITLE = '端到端阅读 PDF';
const EPUB_TITLE = '端到端阅读 EPUB';

test('reads a PDF, highlights, annotates, bookmarks and restores progress', async ({ page, request }) => {
  const adminLogin = await request.post('/api/auth/login', {
    data: {
      username: process.env.E2E_ADMIN_USERNAME ?? 'admin',
      password: process.env.E2E_ADMIN_PASSWORD ?? 'Admin-Test-Password-123',
    },
  });
  const { accessToken } = await adminLogin.json();
  const headers = { authorization: `Bearer ${accessToken}` };

  // Clean leftovers from interrupted runs; sha256 dedupe spans the library.
  const shelf = await request.get('/api/books?pageSize=100', { headers });
  const leftovers = (await shelf.json()).items as Array<{
    id: string; uploadedBy: { displayName: string };
  }>;
  for (const item of leftovers) {
    if (item.uploadedBy.displayName === '阅读端到端') {
      await request.delete(`/api/books/${item.id}`, { headers });
    }
  }

  const invite = await request.post('/api/admin/invites', { headers, data: { expiresInHours: 1 } });
  const { code } = await invite.json();
  await page.goto('/register');
  await page.getByLabel('邀请码').fill(code);
  await page.getByLabel('用户名').fill(`e2e_reader_${Date.now()}`);
  await page.getByLabel('显示名称').fill('阅读端到端');
  await page.getByLabel('密码').fill('e2e-reader-password');
  await page.getByRole('button', { name: '注册' }).click();
  await expect(page).toHaveURL('/');

  await page.getByRole('button', { name: '上传图书' }).click();
  await page.setInputFiles('input[type=file]', 'e2e/fixtures/reader.pdf');
  await expect(page.getByText('上传完成')).toBeVisible({ timeout: 90_000 });
  // The upload is the newest book, so the recent sort puts it first.
  const card = page.getByTestId('book-card').first();
  await card.getByRole('button', { name: /编辑《/ }).click();
  await page.getByLabel('书名').fill(PDF_TITLE);
  await page.getByRole('button', { name: '保存' }).click();

  const started = Date.now();
  await page.getByRole('link', { name: `阅读《${PDF_TITLE}》` }).click();
  await expect(page.locator('.bookr-pdf-page canvas').first()).toBeVisible({ timeout: 10_000 });
  expect(Date.now() - started).toBeLessThan(10_000);
  await expect(page.getByText(/第 1 \/ 300 页/)).toBeVisible();

  // Select the unique phrase in the pdf.js text layer and highlight it.
  await page.evaluate(() => {
    const span = [...document.querySelectorAll('.bookr-text-layer span')]
      .find((node) => node.textContent?.includes('quick brown fox'));
    if (!span) throw new Error('text layer span not found');
    const range = document.createRange();
    range.selectNodeContents(span);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.getByRole('button', { name: '用黄色划线' }).click();
  await expect(page.locator('.bookr-highlight-layer > div').first()).toBeVisible();

  // Go to page 3, leave the reader (flush), reopen and land on page 3.
  await page.getByLabel('页码').fill('3');
  await page.getByLabel('页码').press('Enter');
  await expect(page.getByText(/第 3 \/ 300 页/)).toBeVisible();
  const flushed = page.waitForResponse(
    (response) => response.url().includes('/progress') && response.request().method() === 'PUT',
  );
  await page.getByRole('link', { name: '返回书架' }).click();
  await flushed;
  await page.getByRole('link', { name: `阅读《${PDF_TITLE}》` }).click();
  await expect(page.getByText(/第 3 \/ 300 页/)).toBeVisible({ timeout: 15_000 });

  // Add a note from a new selection and find it in the notes panel.
  await page.evaluate(() => {
    const span = [...document.querySelectorAll('.bookr-text-layer span')]
      .find((node) => node.textContent?.includes('page three'));
    if (!span) throw new Error('page 3 text layer span not found');
    const range = document.createRange();
    range.selectNodeContents(span);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.getByRole('button', { name: '写批注' }).click();
  await page.getByLabel('批注内容').fill('端到端批注');
  await page.getByRole('button', { name: '保存批注' }).click();
  await page.getByRole('button', { name: '笔记' }).click();
  await expect(page.getByText('端到端批注')).toBeVisible();

  // Bookmark page 3 and jump back to it after a reload.
  await page.getByRole('button', { name: '书签' }).click();
  await page.getByRole('button', { name: '添加书签' }).click();
  await page.getByLabel('书签备注').fill('第三页');
  await page.getByRole('button', { name: '保存书签' }).click();
  await page.reload();
  await expect(page.locator('.bookr-pdf-page canvas').first()).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('reader-content').click(); // reveal auto-hidden chrome
  await page.getByRole('button', { name: '书签' }).click();
  await page.getByRole('button', { name: '第三页' }).click();
  await expect(page.getByText(/第 3 \/ 300 页/)).toBeVisible();
});

test('reads an EPUB, jumps by TOC, highlights and restores the location', async ({ page }) => {
  // This test reuses the reader created by the previous test only when run in
  // order; Playwright runs this file with workers: 1. Otherwise register again.
  // (Registration/upload steps are extracted into a helper to avoid repeating
  // the invite flow; see Step 3.)
});
```

- [ ] **Step 2: Fill in the EPUB acceptance test and shared setup**

Add a `registerFreshReader(page, request)` helper that logs in as admin, cleans titles starting with `端到端阅读`, mints an invite, and registers a unique user; both tests call it. The EPUB test then:

1. Uploads `e2e/fixtures/reader.epub`, renames it to `端到端阅读 EPUB`, opens it and waits for the iframe to contain `第一章正文`.
2. Clicks `目录`, selects `第二章`, expects the frame to contain `第二章正文`.
3. Selects the chapter body in the iframe:
```ts
const frame = page.frameLocator('.reader-content iframe').first();
await frame.locator('body').evaluate((body) => {
  const range = document.createRange();
  range.selectNodeContents(body);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
  body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
});
```
   Clicks `用蓝色划线`, opens `笔记`, and expects one `data-testid="annotation-item"`.
4. Adds bookmark `第二章`, reloads, opens the bookmark panel, clicks `第二章`, and expects `第二章正文` again (CFI restore).
5. Leaves and reopens the book; the same chapter is restored and the footer percentage is greater than zero.

The notes panel row must expose `data-testid="annotation-item"`; bookmark rows expose `data-testid="bookmark-item"` with the label as the accessible name.

- [ ] **Step 3: Implement the fixture generator and run the acceptance suite**

`scripts/make-reader-fixtures.mjs`:
- `pdf-lib`: 300 US-letter pages; page 1 carries `The quick brown fox jumps over the lazy dog`, page 3 carries `reader fixture page three`, every page carries `Bookr reader fixture — page N`; metadata title `Bookr Reader Fixture`; write `e2e/fixtures/reader.pdf`.
- `jszip`: EPUB 3 archive with `mimetype` stored uncompressed, `META-INF/container.xml`, `OEBPS/content.opf` (title `Bookr Reader Fixture`, 2 spine items), `OEBPS/nav.xhtml` (章节目录), `OEBPS/ch1.xhtml` (`第一章正文`), `OEBPS/ch2.xhtml` (`第二章正文`); write `e2e/fixtures/reader.epub`.
- Both files are deterministic and git-ignored.

`e2e/global-setup.ts` runs the generator with `execFileSync(process.execPath, [script], { stdio: 'inherit' })` after the disposable-target guard.

`package.json`: devDependencies `pdf-lib ^1.17.1`, `jszip ^3.10.1`; script `"e2e:fixtures": "node scripts/make-reader-fixtures.mjs"`.

Run: `pnpm --filter @bookr/web e2e:fixtures && docker compose up -d --build && pnpm --filter @bookr/web exec playwright test e2e/reader.spec.ts`
Expected: 2 passed. The PDF first paint must stay under 10 s.

- [ ] **Step 4: Run the whole suite to catch regressions**

Run: `pnpm exec turbo run typecheck test --force && pnpm --filter @bookr/web exec playwright test`
Expected: all unit tests and both E2E specs pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web .gitignore pnpm-lock.yaml
git commit -m "test(e2e): cover PDF and EPUB reading flows"
```

---

### Task 14: Desktop and Android shells, API origin and CORS

**Files:**
- Create: `apps/desktop/package.json`, `apps/desktop/src-tauri/{Cargo.toml,build.rs,tauri.conf.json,src/main.rs,capabilities/default.json}`, `apps/desktop/app-icon.svg`, `apps/desktop/README.md`
- Create: `apps/mobile/package.json`, `apps/mobile/capacitor.config.ts`, `apps/mobile/android/` (generated), `apps/mobile/README.md`
- Modify: `apps/web/src/api/client.ts`, `apps/web/Dockerfile`, `apps/server/src/config.ts`, `apps/server/src/app.ts`, `apps/server/test/helpers.ts`, `docker-compose.yml`, `.env.example`, `README.md`, root `pnpm-workspace.yaml` if needed
- Test: `apps/web/src/api/__tests__/api-base.test.ts`, `apps/server/test/cors.test.ts`

**Interfaces:**
- Produces `resolveApiBase(value: string | undefined): string` and `apiUrl(path: string): string` from `apps/web/src/api/client.ts`; every `fetch` in that module uses `apiUrl`.
- Changes `AppConfig.corsOrigin: string` → `corsOrigins: string[]`; `CORS_ORIGIN` is a comma-separated list.
- Produces Tauri app `com.bookr.reader` loading the built web assets and Capacitor Android project with the same `appId`.
- Build-time `VITE_API_BASE_URL` points native builds at the deployed server; the browser build keeps `''` (same-origin).

- [ ] **Step 1: Write the failing origin tests**

`apps/web/src/api/__tests__/api-base.test.ts`:
```ts
import { expect, it } from 'vitest';
import { resolveApiBase } from '../client';

it('keeps same-origin paths and normalizes an absolute API origin', () => {
  expect(resolveApiBase(undefined)).toBe('');
  expect(resolveApiBase('')).toBe('');
  expect(resolveApiBase('https://bookr.example.com/')).toBe('https://bookr.example.com');
  expect(resolveApiBase('https://bookr.example.com/api')).toBe('https://bookr.example.com/api');
});
```

`apps/server/test/cors.test.ts`:
```ts
import { expect, it } from 'vitest';
import { buildTestApp } from './helpers';

it('allows every configured app origin and rejects the rest', async () => {
  const app = await buildTestApp({
    corsOrigins: ['http://localhost:8180', 'https://tauri.localhost'],
  });
  const allowed = await app.inject({
    method: 'GET', url: '/healthz', headers: { origin: 'https://tauri.localhost' },
  });
  const rejected = await app.inject({
    method: 'GET', url: '/healthz', headers: { origin: 'https://evil.example' },
  });
  expect(allowed.headers['access-control-allow-origin']).toBe('https://tauri.localhost');
  expect(rejected.headers['access-control-allow-origin']).toBeUndefined();
});

```

Also extend `apps/server/test/config.test.ts` (or the new file) with:
```ts
import { loadConfig } from '../src/config';
it('parses a comma-separated CORS allowlist', () => {
  const config = loadConfig({
    DATABASE_URL: 'postgres://x', S3_ENDPOINT: 'http://x', S3_ACCESS_KEY: 'a',
    S3_SECRET_KEY: 'b', JWT_SECRET: 'x'.repeat(32),
    CORS_ORIGIN: ' http://localhost:8180 , https://tauri.localhost ',
  });
  expect(config.corsOrigins).toEqual(['http://localhost:8180', 'https://tauri.localhost']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bookr/web test api-base && pnpm --filter @bookr/server test cors`
Expected: FAIL — `resolveApiBase`/`corsOrigins` missing.

- [ ] **Step 3: Implement the API origin and CORS allowlist**

`apps/web/src/api/client.ts`:
```ts
export function resolveApiBase(value: string | undefined): string {
  const raw = (value ?? '').trim();
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}
const API_BASE = resolveApiBase(import.meta.env.VITE_API_BASE_URL);
export function apiUrl(path: string): string { return `${API_BASE}${path}`; }
```
Use `apiUrl('/api/auth/refresh')`, `apiUrl(path)` in `apiFetch`, and `apiUrl(path)` in `postJson`. Absolute URLs passed by callers (none today) must be returned unchanged if they start with `http://` or `https://`.

`apps/server/src/config.ts`: parse `CORS_ORIGIN` with `z.string().default(DEFAULT_CORS_ORIGINS.join(','))`, split on commas, trim, drop empties; reject an empty list. Default list: `http://localhost:8180,https://tauri.localhost,http://tauri.localhost,https://localhost,capacitor://localhost`. `AppConfig.corsOrigins: string[]`. `app.ts` passes `origin: deps.config.corsOrigins`. Update `test/helpers.ts`, `config.test.ts`, and any `corsOrigin` references.

`apps/web/Dockerfile`: `ARG VITE_API_BASE_URL=` and `ENV VITE_API_BASE_URL=$VITE_API_BASE_URL` in the build stage. `docker-compose.yml` web service passes `${VITE_API_BASE_URL:-}` as a build arg, and MinIO gets `MINIO_API_CORS_ALLOW_ORIGIN: ${MINIO_API_CORS_ALLOW_ORIGIN:-*}` so the browser can fetch presigned EPUB/PDF URLs.

`.env.example`: document `CORS_ORIGIN` as a comma-separated allowlist with the native origins above, and `VITE_API_BASE_URL` as a native-build setting (`https://your-domain`), empty for the web build.

- [ ] **Step 4: Create the Tauri desktop shell**

`apps/desktop/package.json`: `@bookr/desktop`, scripts `dev` (`tauri dev`), `build` (`tauri build`), `check` (`cargo check --manifest-path src-tauri/Cargo.toml`); devDependencies `@tauri-apps/cli ^2.12.3`; dependencies `@tauri-apps/api ^2`.

`src-tauri/Cargo.toml`: package `bookr-desktop`; `[build-dependencies] tauri-build = { version = "2", features = [] }`; `[dependencies] tauri = { version = "2", features = [] }`; `serde`/`serde_json`.
`build.rs`: `fn main() { tauri_build::build() }`.
`src/main.rs`: `fn main() { tauri::Builder::default().run(tauri::generate_context!()).expect("failed to run BookrReader"); }`.

`tauri.conf.json` (v2):
```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "纸墨书房",
  "version": "0.2.0",
  "identifier": "com.bookr.reader",
  "build": {
    "beforeDevCommand": "pnpm --filter @bookr/web dev",
    "devUrl": "http://localhost:5173",
    "beforeBuildCommand": "pnpm --filter @bookr/web build",
    "frontendDist": "../../web/dist"
  },
  "app": {
    "windows": [{ "title": "纸墨书房", "width": 1200, "height": 800, "minWidth": 800, "minHeight": 600 }],
    "security": { "csp": null }
  },
  "bundle": { "active": true, "targets": "all", "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.icns", "icons/icon.ico"] }
}
```
`capabilities/default.json` grants `core:default` to the main window. `app-icon.svg` is a paper-colored rounded square with an ink book mark; generate icons with `pnpm --filter @bookr/desktop exec tauri icon app-icon.svg`.

README states: web build must be made with `VITE_API_BASE_URL=https://<server>` for a packaged app; `CORS_ORIGIN` must include the Tauri origins; local dev uses `pnpm --filter @bookr/desktop dev`.

- [ ] **Step 5: Create the Capacitor Android shell**

`apps/mobile/package.json`: `@bookr/mobile`; dependencies `@capacitor/core 7.6.9`; devDependencies `@capacitor/cli 7.6.9`, `@capacitor/android 7.6.9`; scripts `add:android` (`cap add android`), `sync` (`cap sync android`), `open` (`cap open android`).

`capacitor.config.ts`:
```ts
import type { CapacitorConfig } from '@capacitor/cli';
const config: CapacitorConfig = {
  appId: 'com.bookr.reader',
  appName: '纸墨书房',
  webDir: '../web/dist',
  server: { androidScheme: 'https' },
  android: { backgroundColor: '#F6F1E7' },
};
export default config;
```
Run `pnpm --filter @bookr/mobile add:android` once and commit the generated `android/` project. Build the web assets with `VITE_API_BASE_URL=https://<server>` before `sync`. README documents the JDK 21 + Android SDK prerequisite, `pnpm --filter @bookr/mobile open`, and that signing/APK distribution belongs to Plan 8. `CORS_ORIGIN` must include `https://localhost` and `capacitor://localhost`; presigned file URLs must be reachable from the device (use the public MinIO/domain endpoint).

- [ ] **Step 6: Verify origin tests, shells and the full stack**

Run:
```bash
pnpm --filter @bookr/web test api-base
pnpm --filter @bookr/server test cors config
pnpm --filter @bookr/desktop check
pnpm --filter @bookr/web build
pnpm --filter @bookr/mobile sync
pnpm exec turbo run typecheck test --force
```
Expected: all green. `cargo check` may download crates on first run; if the machine lacks the MSVC toolchain, report the exact error and keep the source committed (Plan 8 owns packaging). In that case record the limitation in the ledger and README rather than weakening the source.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop apps/mobile apps/web apps/server docker-compose.yml .env.example README.md .gitignore pnpm-lock.yaml
git commit -m "feat: add desktop and Android shells with configurable API origin"
```

---

## Execution notes

- Tasks 1–6 are server/shared work; Tasks 7–9 are framework-free reader-core work; Tasks 10–13 are web; Task 14 is packaging. Each task leaves the tree type-clean and test-green.
- The Tauri/Android shells intentionally contain no reading logic: the reader lives in the shared web build, so fixes reach all three platforms at once.
- Plan 3 may add the reflow engine behind the same `ReaderEngine` contract and the `reflow` locator branch; no API shape in this plan needs to change for that.
- Plan 4 replaces the direct progress/bookmark/annotation API calls with the local-first sync queue; the DTOs and locators defined here are the wire contract it will reuse.
