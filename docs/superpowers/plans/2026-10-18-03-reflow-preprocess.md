# 私人书房 — 计划 3：预处理与重排 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 PDF 在原版模式之外拥有一套可调字体、字号、行距、页边距与主题的重排模式，并提供本地预处理工具：文字版 PDF 抽取版面、扫描版 PDF OCR 后生成版本化重排包（`*.bookr.json`），服务端校验后存储，阅读器可在两种模式间一键切换且位置误差不超过 1 页。

**Architecture:** 新包格式只是一份纯文本 JSON（块结构 + 源页几何 + 字符区间），图片/表格/公式/失败块不内嵌像素，而是由阅读器按块矩形从原始 PDF 实时裁绘，因此包体小、可校验、可直传 MinIO。`packages/shared` 定义唯一的包 schema 与定位器；`packages/reader-core` 新增不依赖 React 的 `ReflowReaderEngine`，复用 pdf.js 只为视觉块绘制原页；`apps/web` 负责模式切换、重排设置与重排包上传；`tools/pdf-preprocess` 是独立的 Python CLI，不部署到服务器。

**Tech Stack:** 既有 Node.js 22 / Fastify 5 / Drizzle / PostgreSQL 16 / React 19 / Vite / TanStack Query / Vitest / Playwright / pdfjs-dist 6.4.299；新增 Python 3.10+ / PyMuPDF / pytest；OCR（PaddleOCR）与 DeepSeek 纠错为可选依赖，通过 CLI 参数显式启用。

**Spec:** `docs/superpowers/specs/2026-10-18-private-book-reader-design.md`

**Plan set:** 本项目共 8 份计划，见 `2026-10-18-00-roadmap.md`。本计划覆盖 P3，不包含同步与离线（计划 4）、AI 伴读（计划 5）、笔记库（计划 6）、统计（计划 7）。重排模式不改变 P2 已交付的原版/EPUB 行为。

## Global Constraints

- 重排包 schema 版本固定为 `1`（`REFLOW_PACK_SCHEMA_VERSION = 1`）；服务端只接受该版本，未来升级必须新增版本号并保留旧版读取能力。
- 重排包不得内嵌图片/base64；`image`、`table`、`formula`、`fallback` 块只保存源页归一化矩形，由阅读器用原 PDF 裁绘。包体上限 32 MiB，页数上限 5000，块总数上限 200000，单页块数上限 2000，单块文本上限 20000 字符。
- 包内 `source.sha256` 必须等于书库中该书的原始 `books.sha256`；`source.pageCount` 必须等于 `pages.length`，页号从 1 连续递增且唯一。
- `generatedAt` 必须是 UTC 且以 `Z` 结尾（schema 使用 `z.iso.datetime()`，不接受 `+00:00`）；Python 工具用 `datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'`。
- 所有字符区间一律使用 **UTF-16 code unit** 偏移（与 JavaScript 字符串一致）；Python 工具必须用 `utf16_len(text)` 计算，禁止直接使用 `len(text)`。补充平面字符（如 `𠮷`）必须有测试。
- 重排定位器在 P2 基础上增加可选 `ranges`：`{ kind:'reflow', sourcePage, percent, blockId?, charRange?, ranges?: Array<{ blockId, charRange }> }`；`ranges` 最多 200 项，用于跨块划线。
- 位置映射：原版→重排优先使用 PDF 定位器的 `rect`（页内纵向位置）匹配块，其次 `charOffset`，最后该页第一个文本块；重排→原版使用 `sourcePage` + 块 `rect` + `sourceCharStart + charRange[0]`。切换模式后页码误差必须 ≤1 页。
- 重排设置与 P2 设置同存于 `localStorage` 键 `bookr.reader.settings.v1`：`pdf.readingMode` 为 `'original' | 'reflow'`（默认 `original`）；`reflow.fontFamily` 为 `'serif' | 'sans'`，`fontSize` 16–28（默认 19），`lineHeight` 1.5–2.4（默认 1.9），`margin` 2–16（百分比，默认 7）。
- 重排包上传/删除仅限该书上传者或管理员；任何活跃成员都可以读取已存在的重排包。响应仍用预签名 URL，包体不经过应用服务器转发（仅完成上传时读取一次做校验）。
- 每本书最多一个未完成的 reflow 上传会话和一份已存储的重排包（≤32 MiB）；创建新会话会使同书旧会话过期并删除其对象，替换/删除重排包会删除旧对象。重排包不单独计入图书配额（由上述上限约束），这一点必须在 README 中说明。
- 重排包读取端点：`GET /api/books/:id/reflow`，URL 有效期 3600 秒；无包返回 409 `REFLOW_NOT_READY`；包无效返回 422 `REFLOW_INVALID`。
- 重排渲染的安全底线：包内文本只能通过 `textContent` 进入 DOM，任何情况下不得 `innerHTML`；所有块矩形必须被 clamp 到 `[0,1]`；非法块跳过而不是让整本书打不开。
- 本地工具的输出是唯一事实来源：它生成 `*.bookr.json` 与质量报告；服务端不修正包内容，只校验与拒绝。工具不得联网，除非显式传入 `--ai-correct`。
- 重排模式只对 PDF 生效；EPUB 保持 P2 流式渲染。MOBI/AZW3 仍按服务端转换后的 EPUB 阅读。
- 界面文案用简体中文，代码/标识符/注释用英文；沿用纸墨书房主题（纸白/米黄/护眼绿/深色）。
- 本计划不做：AI 伴读、跨设备实时同步、离线缓存、笔记库、阅读统计、Android 安装包签名；这些仍属于计划 4–8。

## Review Focus

以下五类输入/故障最可能伤害真实用户，对应测试必须在所属任务中实现：

1. **恶意或错误的重排包**：超大 JSON、非法 schema、块 id 重复、文本含 `<script>`、`rect` 越界、页号乱序 → 服务端拒绝且不残留对象；阅读器即使收到坏块也只跳过该块、不执行脚本、不白屏（Task 1、2、4、5）。
2. **双模式位置丢失**：在原版第 120 页切到重排再切回，或重开书时进度是另一种模式的定位器 → 页码误差 ≤1；缺失块/空页/越界 `charOffset` 都要回退到该页第一块或该页百分比（Task 3、7、8）。
3. **重排包与书不匹配**：用 B 书的包上传到 A 书、包内 sha256 不符、旧 schema 版本 → 422 且 A 书原有重排包保持不变；上传中途失败不覆盖旧包、不产生孤儿对象（Task 2、6）。
4. **选区/划线在重排下失真**：跨段落选择、CJK 无空格断行、补充平面字符、字体/字号/行距/主题变化后划线仍覆盖同一段文字；纯视觉块不可选中（Task 4、5、8）。
5. **扫描件与缺图回退**：OCR 失败页、无文字层页、原 PDF 加载失败、`image/table/formula/fallback` 块 → 页面显示原页截图或清晰占位，不崩溃；质量报告列出回退页（Task 9、10、11）。

## File Structure

```
packages/shared/
  src/schemas/reflow.ts            重排包 schema、常量、上传/读取 DTO
  src/locators.ts                  reflow 定位器 + ranges
  src/schemas/books.ts             BookDto.reflowAvailable / reflowSchemaVersion / reflowPageCount
  src/errors.ts                    + REFLOW_NOT_READY / REFLOW_INVALID
  src/index.ts                     导出
  src/__tests__/reflow-schemas.test.ts
  src/__tests__/fixtures/golden.bookr.json   跨语言黄金包（Python 测试也读它）

packages/reader-core/
  src/types.ts                     ReaderEngineKind、OpenReaderOptions.sourcePdfUrl
  src/settings.ts                  pdf.readingMode + reflow 设置与 clamp
  src/factory.ts                   createReaderEngine('reflow')
  src/reflow/pack.ts               解析/索引重排包
  src/reflow/mapping.ts            双模式定位器映射
  src/reflow/render.ts             块 DOM、主题/排版变量
  src/reflow/selection.ts          选区 → 多块字符区间
  src/reflow/highlights.ts         非重叠 mark 渲染
  src/reflow/source-painter.ts     pdf.js 原页裁绘
  src/reflow/engine.ts             ReflowReaderEngine
  src/__tests__/reflow-*.test.ts

apps/server/
  src/db/schema.ts                 + reflow_uploads 表与 books 重排列
  drizzle/0003_reflow.sql
  src/books/reflow.ts              上传会话、校验、签名、删除、清理
  src/books/routes.ts              + /reflow 路由
  src/books/dto.ts                 + 重排字段
  src/books/service.ts             复用 canManage/assertCanManageBook
  src/startup.ts                   清理过期重排上传
  test/reflow.test.ts
  test/helpers.ts                  seedBook 支持重排字段

apps/web/
  src/api/reflow.ts                重排包 API + 直传流程
  src/features/bookshelf/ReflowPackSection.tsx   编辑弹窗中的重排包管理
  src/features/bookshelf/EditBookDialog.tsx      + 重排包区块
  src/features/bookshelf/BookCard.tsx            + 重排标记
  src/features/reader/useReadingMode.ts          模式/重排源状态
  src/features/reader/ReaderPage.tsx             模式切换、映射、进度
  src/features/reader/ReaderChrome.tsx           原版/重排切换按钮
  src/features/reader/SettingsPanel.tsx          重排字体/字号/行距/边距
  src/features/reader/reader.css                 重排阅读样式
  src/features/reader/__tests__/reader-reflow.test.tsx
  src/features/bookshelf/__tests__/reflow-pack.test.tsx
  e2e/reflow.spec.ts
  scripts/make-reader-fixtures.mjs               + 生成 reader.bookr.json

tools/pdf-preprocess/
  pyproject.toml
  README.md
  bookr_preprocess/{__init__,model,layout,detect,build,extract_text,ocr,ai,pdf_writer,cli,__main__}.py
  tests/{test_layout,test_build,test_schema,test_ocr,test_ai,test_pdf_writer}.py

docs/superpowers/plans/2026-10-18-00-roadmap.md   标记计划 3 交付
README.md                                          预处理工具、重排包上传与重排阅读说明
```

---

## Execution Note

Task 1 defines the shared contract and must land first. After it, **Tasks 2–8 (TypeScript: server / reader-core / web / E2E) and Tasks 9–11 (Python tool) touch disjoint directory trees and may run concurrently** with separate implementers, as the owner requested Agent Teams concurrency. Reviews remain per task and sequential within each workstream; no two implementers may edit the same file. Task 12 waits for both workstreams. If a shared type needs to change mid-flight, stop both, land the contract change through a Task 1 follow-up, then resume.

---

### Task 1: Shared reflow pack contract and Book DTO fields

**Files:**
- Create: `packages/shared/src/schemas/reflow.ts`
- Create: `packages/shared/src/__tests__/reflow-schemas.test.ts`
- Create: `packages/shared/src/__tests__/fixtures/golden.bookr.json`
- Modify: `packages/shared/src/locators.ts`, `packages/shared/src/schemas/books.ts`, `packages/shared/src/errors.ts`, `packages/shared/src/index.ts`
- Modify: `apps/server/src/books/dto.ts`, `apps/server/src/errors.ts`, `apps/server/test/helpers.ts`
- Modify: `apps/web/src/lib/errorMessages.ts`, `apps/web/src/features/bookshelf/__tests__/bookshelf.test.tsx`
- Test: `packages/shared/src/__tests__/locators.test.ts`

**Interfaces:**
- Produces: `REFLOW_PACK_SCHEMA_VERSION = 1`, `MAX_REFLOW_PACK_BYTES = 32 * 1024 * 1024`, `MAX_REFLOW_PAGES = 5000`, `MAX_REFLOW_BLOCKS = 200000`, `MAX_REFLOW_BLOCKS_PER_PAGE = 2000`, `MAX_REFLOW_TEXT_LENGTH = 20000`, `REFLOW_BLOCK_TYPES = ['heading','paragraph','image','table','formula','fallback'] as const`。
- Produces: `reflowBlockSchema`, `reflowPageSchema`, `reflowPackSchema`, types `ReflowPack`, `ReflowPage`, `ReflowBlock`, `ReflowBlockType`。
- Produces: `reflowUploadCreateSchema`（`{ size: int 1..MAX_REFLOW_PACK_BYTES, sha256: 64 hex }`）。
- Produces: `ReflowFileInfo`, `ReflowPackSummary`, `CreateReflowUploadResponse`, `CompleteReflowUploadResponse`。
- Produces: `BookDto.reflowAvailable: boolean`, `reflowSchemaVersion: number | null`, `reflowPageCount: number | null`。
- Produces errors `REFLOW_NOT_READY`（409）与 `REFLOW_INVALID`（422）。

- [ ] **Step 1: Write the failing reflow schema tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  MAX_REFLOW_BLOCKS_PER_PAGE,
  REFLOW_PACK_SCHEMA_VERSION,
  reflowPackSchema,
} from '../schemas/reflow';
import golden from './fixtures/golden.bookr.json';

function pack(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: REFLOW_PACK_SCHEMA_VERSION,
    source: { sha256: 'a'.repeat(64), pageCount: 2 },
    generatedAt: '2026-10-18T08:00:00.000Z',
    tool: { name: 'bookr-preprocess', version: '0.1.0' },
    quality: { pages: 2, textBlocks: 2, fallbackPages: [], ocrPages: [], avgConfidence: null, warnings: [] },
    toc: [{ label: '第一章', page: 1, level: 1 }],
    pages: [
      { page: 1, width: 612, height: 792, blocks: [
        { id: 'p1-b0', type: 'heading', text: '第一章', level: 1, rect: { x: 0.1, y: 0.1, w: 0.8, h: 0.05 }, sourceCharStart: 0, sourceCharEnd: 3 },
        { id: 'p1-b1', type: 'paragraph', text: '正文。', rect: { x: 0.1, y: 0.2, w: 0.8, h: 0.05 }, sourceCharStart: 4, sourceCharEnd: 7 },
      ] },
      { page: 2, width: 612, height: 792, blocks: [
        { id: 'p2-b0', type: 'fallback', rect: { x: 0, y: 0, w: 1, h: 1 } },
      ] },
    ],
    ...overrides,
  };
}

describe('reflowPackSchema', () => {
  it('accepts the golden pack and a valid synthetic pack', () => {
    expect(reflowPackSchema.safeParse(golden).success).toBe(true);
    expect(reflowPackSchema.safeParse(pack()).success).toBe(true);
  });

  it('requires pageCount to equal pages.length and pages to be 1..n', () => {
    expect(reflowPackSchema.safeParse(pack({ source: { sha256: 'a'.repeat(64), pageCount: 3 } })).success).toBe(false);
    const reversed = pack();
    reversed.pages = [reversed.pages[1], reversed.pages[0]];
    expect(reflowPackSchema.safeParse(reversed).success).toBe(false);
  });

  it('rejects out-of-range rects, duplicate ids, missing text and unknown block types', () => {
    const badRect = pack();
    badRect.pages[0].blocks[0].rect = { x: 0.9, y: 0.1, w: 0.2, h: 0.05 };
    expect(reflowPackSchema.safeParse(badRect).success).toBe(false);

    const duplicate = pack();
    duplicate.pages[0].blocks[1].id = 'p1-b0';
    expect(reflowPackSchema.safeParse(duplicate).success).toBe(false);

    const noText = pack();
    // @ts-expect-error deliberately invalid
    noText.pages[0].blocks[1].text = undefined;
    expect(reflowPackSchema.safeParse(noText).success).toBe(false);

    const unknown = pack();
    // @ts-expect-error deliberately invalid
    unknown.pages[0].blocks[0].type = 'script';
    expect(reflowPackSchema.safeParse(unknown).success).toBe(false);
  });

  it('caps blocks per page and requires schemaVersion 1', () => {
    const over = pack();
    over.pages[0].blocks = Array.from({ length: MAX_REFLOW_BLOCKS_PER_PAGE + 1 }, () => ({
      id: 'x', type: 'paragraph', text: 'x', rect: { x: 0, y: 0, w: 1, h: 1 },
    }));
    expect(reflowPackSchema.safeParse(over).success).toBe(false);
    expect(reflowPackSchema.safeParse(pack({ schemaVersion: 2 })).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @bookr/shared test -- reflow-schemas`
Expected: FAIL — cannot resolve `../schemas/reflow`.

- [ ] **Step 3: Implement `packages/shared/src/schemas/reflow.ts`**

Exact schema rules: `schemaVersion: z.literal(1)`; `generatedAt: z.iso.datetime()`; block `id` 1–64 chars; `text` optional but **required for `heading`/`paragraph`** (superRefine); `level` required for `heading` (omitted → invalid), 1–6; `sourceCharEnd >= sourceCharStart` when both present; block ids unique **within a page**; page numbers exactly `1..source.pageCount`; total blocks ≤ 200000. Export helpers:

```ts
export function reflowPackBlockCount(pack: ReflowPack): number;
export function reflowPackSummary(pack: ReflowPack): ReflowPackSummary;
```

`ReflowPackSummary = { schemaVersion: number; pageCount: number; blockCount: number; fallbackPages: number[] }`。DTO 形状：

```ts
export interface ReflowFileInfo { url: string; schemaVersion: number; pageCount: number; expiresIn: number }
export interface CreateReflowUploadResponse {
  uploadId: string;
  upload: PresignedUploadTarget;
  expiresAt: string;
}
export interface CompleteReflowUploadResponse { book: BookDto; pack: ReflowPackSummary }
```

Import `PresignedUploadTarget`/`BookDto` from the existing schema modules; re-export everything from `packages/shared/src/index.ts`.

- [ ] **Step 4: Extend the locator and book DTO contracts**

In `locators.ts`, add `ranges` to the reflow locator and a named `reflowRangeSchema`:

```ts
const reflowRangeSchema = z.object({
  blockId: z.string().min(1).max(200),
  charRange: charRangeSchema,
});
// inside reflowLocatorSchema:
ranges: z.array(reflowRangeSchema).max(200).optional(),
```

In `schemas/books.ts`, add the three fields to `BookDto` and document them: `reflowAvailable` true when a pack is stored; `reflowSchemaVersion` and `reflowPageCount` null when absent. In `apps/server/src/books/dto.ts` map `book.reflowKey !== null`, `book.reflowSchemaVersion`, `book.reflowPageCount`. Add `reflowKey/reflowSchemaVersion/reflowPageCount/reflowUpdatedAt` to `SeedBookInput` and the insert in `apps/server/test/helpers.ts` so later tasks can seed.

- [ ] **Step 5: Add error codes and update exhaustive maps**

Add `REFLOW_NOT_READY: 'REFLOW_NOT_READY'` and `REFLOW_INVALID: 'REFLOW_INVALID'` to `ERROR_CODES`. Add server defaults:

```ts
[ERROR_CODES.REFLOW_NOT_READY]: 'This book has no reflow pack yet',
[ERROR_CODES.REFLOW_INVALID]: 'The reflow pack is not valid for this book',
```

Web messages: `REFLOW_NOT_READY: '这本书还没有重排包'`、`REFLOW_INVALID: '重排包与这本书不匹配'`。Update every `BookDto` fixture under `apps/web/src/**/__tests__`, `apps/web/test/setup.ts` (the shared `book()` helper) and `apps/server/test` with `reflowAvailable: false, reflowSchemaVersion: null, reflowPageCount: null`（server tests using `seedBook` get defaults automatically）。

- [ ] **Step 6: Create the golden pack fixture**

Write `packages/shared/src/__tests__/fixtures/golden.bookr.json` with exactly two pages, one heading + one paragraph on page 1, one `image` block on page 2, a TOC entry, `quality.fallbackPages: [2]`, and a fixed `generatedAt` of `2026-10-18T08:00:00.000Z`. It must validate against the schema and will be parsed by Python tests in Task 9. Keep it ASCII-only except one CJK heading `第一章` and one supplementary character in the paragraph `𠮷` to exercise UTF-16 offsets. Add a locator test asserting `{ kind:'reflow', sourcePage: 1, percent: 0.5, blockId: 'p1-b0', charRange: [0, 3], ranges: [{ blockId:'p1-b0', charRange:[0,3] }, { blockId:'p1-b1', charRange:[0,2] }] }` parses, and that 201 ranges fail.

- [ ] **Step 7: Run the tests and typecheck**

Run: `pnpm --filter @bookr/shared test && pnpm --filter @bookr/server typecheck && pnpm --filter @bookr/web typecheck`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add packages/shared apps/server/src/books/dto.ts apps/server/src/errors.ts apps/server/test/helpers.ts apps/web/src/lib/errorMessages.ts apps/web/src/features/bookshelf/__tests__
git commit -m "feat(shared): define the versioned reflow pack contract"
```

---

### Task 2: Server reflow pack storage and API

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Create: `apps/server/drizzle/0003_reflow.sql`, update `apps/server/drizzle/meta/_journal.json`
- Create: `apps/server/src/books/reflow.ts`
- Modify: `apps/server/src/books/routes.ts`, `apps/server/src/startup.ts`, `apps/server/test/helpers.ts`
- Test: `apps/server/test/reflow.test.ts`

**Interfaces:**
- Consumes: `reflowPackSchema`, `reflowUploadCreateSchema`, `reflowPackSummary`, `ReflowFileInfo`, `CreateReflowUploadResponse`, `CompleteReflowUploadResponse` from Task 1; `canManage/assertCanManageBook` from `books/service.ts`; `StorageService` presign/get/put/delete.
- Produces: `REFLOW_URL_EXPIRES_SECONDS = 900`, `REFLOW_PACK_URL_EXPIRES_SECONDS = 3600`, `REFLOW_SESSION_TTL_MS = 24 * 60 * 60 * 1000`.
- Produces service functions:
  - `createReflowUpload(deps: AppDeps, actor: BookActor, bookId: string, input: { size: number; sha256: string }): Promise<CreateReflowUploadResponse>`
  - `completeReflowUpload(deps: AppDeps, actor: BookActor, bookId: string, uploadId: string): Promise<CompleteReflowUploadResponse>`
  - `deleteReflowPack(deps: AppDeps, actor: BookActor, bookId: string): Promise<void>`
  - `getReflowFile(deps: AppDeps, bookId: string): Promise<ReflowFileInfo>`
  - `cleanupExpiredReflowUploads(deps: AppDeps): Promise<number>`

- [ ] **Step 1: Write the failing API tests**

Cover, with a PDF book seeded by `seedBook` and a pack built by a local helper:

```ts
const book = await seedBook({ uploadedBy: ownerId, format: 'pdf', sha256: 'c'.repeat(64) });
const packJson = Buffer.from(JSON.stringify(validPackFor('c'.repeat(64))));

// create → expect 201, upload.url starts with https://fake-s3.local, expiresAt in the future
// fakeStorage.putObject(session object key, packJson, 'application/json')
// complete → expect 200, book.reflowAvailable true, pack.pageCount 2
// GET /api/books/:id/reflow → 200 with url, schemaVersion 1, pageCount 2
// GET file as another active member → same shape; DELETE as member → 403
// mismatch: pack.source.sha256 = 'd'.repeat(64) → 422 REFLOW_INVALID, reflowKey unchanged
// wrong schemaVersion → 422; expired session → 409; non-PDF book → 400
// replacing a pack: complete a second valid pack; old object deleted, book points at new key
// complete twice → 409, no second mutation
```

The object key is returned by `FakeStorage.presignPost` fields (`key`), so tests can place bytes without a real browser POST. Use the auth helpers from `books.test.ts`; assert error envelopes include `code`. Also assert a second user's session can read the pack but cannot manage it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @bookr/server test -- reflow`
Expected: FAIL — route/module missing.

- [ ] **Step 3: Add the database schema and migration**

Add to `books`: `reflowSchemaVersion: integer('reflow_schema_version')`, `reflowPageCount: integer('reflow_page_count')`, `reflowUpdatedAt: timestamp('reflow_updated_at', { withTimezone: true })`. Add:

```ts
export const reflowUploads = pgTable(
  'reflow_uploads',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    bookId: uuid('book_id').notNull().references(() => books.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    objectKey: text('object_key').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    status: text('status').$type<'created' | 'completed' | 'failed' | 'expired'>().notNull().default('created'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [index('reflow_uploads_status_expires_idx').on(table.status, table.expiresAt)],
);
```

Write `drizzle/0003_reflow.sql` matching the schema (`ALTER TABLE books ADD COLUMN ...`, `CREATE TABLE reflow_uploads ...`, index) and append the `0003_reflow` entry to `meta/_journal.json`. Run `pnpm --filter @bookr/server db:test:reset` to apply it.

- [ ] **Step 4: Implement `apps/server/src/books/reflow.ts`**

Rules:
- `createReflowUpload`: load live book; 404 if absent; `format === 'pdf'` else 400 `VALIDATION_FAILED`; `canManage(actor, book)` else 403; validate `reflowUploadCreateSchema`; reject when `input.sha256 !== book.sha256` with 422 `REFLOW_INVALID`; insert session with key `library/<libraryId>/books/<bookId>/reflow/<uploadId>.json`, `expiresAt = now + 24h`; return `presignPost(key, 'application/json', input.size, 900)`.
- `completeReflowUpload`: select the session by `(id, bookId, userId)` without a lock; `404` if not found; `409` if status not `created` or expired; `head` must exist with exact size; `getObject` (≤32 MiB), `JSON.parse` in try/catch, `reflowPackSchema.safeParse`; on any validation failure mark session `failed`, delete object best-effort, throw `422 REFLOW_INVALID` with `{ reason }`; verify `pack.source.sha256 === book.sha256`; then in one transaction lock the session, re-check `created`, update the book (`reflowKey`, `reflowSchemaVersion`, `reflowPageCount`, `reflowUpdatedAt = now`), mark session completed; after commit delete the *previous* key if it differs. Return the updated DTO and `reflowPackSummary(pack)`.
- If zod reports `pages.length !== pageCount`, return `{ reason: 'pack/invalid' }`; never leak pack text in errors or logs.
- `deleteReflowPack`: manage permission; clear the four columns; delete object best-effort after the update.
- `getReflowFile`: live book; `reflowKey` null → 409 `REFLOW_NOT_READY`; return presigned URL with 3600s, `schemaVersion`, `pageCount`.
- `cleanupExpiredReflowUploads`: same transition-then-delete pattern as `cleanupExpiredUploads`.

- [ ] **Step 5: Register routes and cleanup**

In `books/routes.ts`:

```ts
app.post('/api/books/:id/reflow/uploads', { preHandler: requireAuth }, async (request, reply) => {
  const { id } = bookIdParamsSchema.parse(request.params);
  const input = reflowUploadCreateSchema.parse(request.body);
  return reply.status(201).send(await createReflowUpload(deps, request.user!, id, input));
});

app.post('/api/books/:id/reflow/uploads/:uploadId/complete', { preHandler: requireAuth }, async (request) => {
  const params = z.object({ id: z.uuid(), uploadId: z.uuid() }).parse(request.params);
  return completeReflowUpload(deps, request.user!, params.id, params.uploadId);
});

app.get('/api/books/:id/reflow', { preHandler: requireAuth }, async (request) => {
  const { id } = bookIdParamsSchema.parse(request.params);
  return getReflowFile(deps, id);
});

app.delete('/api/books/:id/reflow', { preHandler: requireAuth }, async (request, reply) => {
  const { id } = bookIdParamsSchema.parse(request.params);
  await deleteReflowPack(deps, request.user!, id);
  return reply.status(204).send();
});
```

In `startup.ts`, call `cleanupExpiredReflowUploads(deps)` alongside `cleanupExpiredUploads`, and include its count in the log. Also add `reflowUploads` to the test reset/truncate behavior (the generic truncate already covers it).

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm --filter @bookr/server test -- reflow && pnpm --filter @bookr/server typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server
git commit -m "feat(server): store and serve validated reflow packs"
```

---

### Task 3: Reader-core reflow settings, pack index and locator mapping

**Files:**
- Modify: `packages/reader-core/src/types.ts`, `packages/reader-core/src/settings.ts`
- Create: `packages/reader-core/src/reflow/pack.ts`, `packages/reader-core/src/reflow/mapping.ts`
- Modify: `packages/reader-core/src/index.ts`
- Test: `packages/reader-core/src/__tests__/settings.test.ts`, `packages/reader-core/src/__tests__/reflow-mapping.test.ts`

**Interfaces:**
- Produces: `PdfReadingMode = 'original' | 'reflow'`; `ReflowSettings = { fontFamily: 'serif' | 'sans'; fontSize: number; lineHeight: number; margin: number }`; `ReaderSettings.pdf.readingMode` and `ReaderSettings.reflow`.
- Produces: `ReaderEngineKind = ReaderKind | 'reflow'`; `ReaderDocumentInfo.kind` and `ReaderEngine.kind` use it; `OpenReaderOptions.sourcePdfUrl?: string`.
- Produces: `indexReflowPack(value: unknown): ReflowPack`（throws `Error('Invalid reflow pack')` on failure）, `ReflowPackIndex` with `page(page)`, `block(id)`, `pageCount`, `textBlocksOnPage(page)`, `firstTextBlock(page)`, `toc()`.
- Produces mapping functions:
  - `reflowLocatorFor(locator: Locator, pack: ReflowPack): ReflowLocator | null`
  - `pdfLocatorFor(locator: Locator, pack?: ReflowPack | null): PdfLocator | null`
  - `locatorForMode(locator: Locator, mode: PdfReadingMode, pack?: ReflowPack | null): Locator | null`

- [ ] **Step 1: Write the failing settings and mapping tests**

Settings test additions:

```ts
it('defaults to original mode and clamps reflow settings', () => {
  const defaults = mergeReaderSettings({});
  expect(defaults.pdf.readingMode).toBe('original');
  expect(defaults.reflow).toEqual({ fontFamily: 'serif', fontSize: 19, lineHeight: 1.9, margin: 7 });

  const clamped = mergeReaderSettings({
    pdf: { readingMode: 'nonsense' },
    reflow: { fontFamily: 'mono', fontSize: 99, lineHeight: 0.2, margin: -4 },
  });
  expect(clamped.pdf.readingMode).toBe('original');
  expect(clamped.reflow).toEqual({ fontFamily: 'serif', fontSize: 28, lineHeight: 1.5, margin: 2 });
});
```

Mapping tests use a 3-page pack fixture helper (page 1: `p1-b0` chars 0–40 rect y=0.1 h=0.08, `p1-b1` chars 40–90 rect y=0.55 h=0.08; page 2 empty; page 3: one paragraph chars 20–30):

```ts
it('maps a PDF rect to the block at the same height, then to a caret position', () => {
  const mapped = reflowLocatorFor(
    { kind: 'pdf', page: 1, percent: 0.2, rect: { x: 0.1, y: 0.62, w: 0.8, h: 0.02 }, charOffset: 120 },
    pack,
  );
  expect(mapped).toMatchObject({ kind: 'reflow', sourcePage: 1, blockId: 'p1-b1', percent: 0.2 });
  expect(mapped?.charRange).toBeUndefined();
});

it('falls back to charOffset, then the first text block, then the page', () => {
  expect(reflowLocatorFor({ kind: 'pdf', page: 1, percent: 0.1, charOffset: 44 }, pack)?.blockId).toBe('p1-b1');
  expect(reflowLocatorFor({ kind: 'pdf', page: 1, percent: 0.1 }, pack)?.blockId).toBe('p1-b0');
  expect(reflowLocatorFor({ kind: 'pdf', page: 2, percent: 0.4 }, pack)).toEqual(
    { kind: 'reflow', sourcePage: 2, percent: 0.4 },
  );
});

it('maps reflow back to the same source page with rect and charOffset', () => {
  const mapped = pdfLocatorFor(
    { kind: 'reflow', sourcePage: 1, percent: 0.2, blockId: 'p1-b1', charRange: [3, 9] },
    pack,
  );
  expect(mapped).toMatchObject({ kind: 'pdf', page: 1, percent: 0.2, charOffset: 43 });
  expect(mapped?.rect).toEqual({ x: 0.1, y: 0.55, w: 0.8, h: 0.08 });
});

it('keeps the source page when a reflow locator has no block or a stale block id', () => {
  expect(pdfLocatorFor({ kind: 'reflow', sourcePage: 2, percent: 0.4 }, pack)).toEqual(
    { kind: 'pdf', page: 2, percent: 0.4 },
  );
  expect(pdfLocatorFor({ kind: 'reflow', sourcePage: 99, percent: 0.9 }, pack)).toEqual(
    { kind: 'pdf', page: 3, percent: 0.9 },
  );
});

it('normalizes without a pack in both directions', () => {
  expect(locatorForMode({ kind: 'reflow', sourcePage: 7, percent: 0.3 }, 'original')).toEqual(
    { kind: 'pdf', page: 7, percent: 0.3 },
  );
  expect(locatorForMode({ kind: 'pdf', page: 7, percent: 0.3 }, 'reflow')).toEqual(
    { kind: 'pdf', page: 7, percent: 0.3 },
  );
  expect(locatorForMode({ kind: 'epub', cfi: 'epubcfi(/6/4!/4)', percent: 0.3 }, 'reflow')).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @bookr/reader-core test -- reflow-mapping settings`
Expected: FAIL — module/settings missing.

- [ ] **Step 3: Extend settings and types**

`ReaderSettings` gains:

```ts
pdf: { ...existing; readingMode: PdfReadingMode };
reflow: { fontFamily: 'serif' | 'sans'; fontSize: number; lineHeight: number; margin: number };
```

Defaults `'original'`, `{ fontFamily:'serif', fontSize:19, lineHeight:1.9, margin:7 }`。`mergeSettings` clamps `fontSize` 16–28, `lineHeight` 1.5–2.4, `margin` 2–16, and `readingMode` via `pickEnum(..., ['original','reflow'], 'original')`。Freeze the new nested objects in `deepFreezeSettings`. Extend `ReaderEngineKind` and `OpenReaderOptions.sourcePdfUrl` in `types.ts`; keep `ReaderKind` unchanged for API/file formats.

- [ ] **Step 4: Implement `reflow/pack.ts` and `reflow/mapping.ts`**

`ReflowPackIndex` builds three Maps in the constructor (`byPage`, `blocksById`, `pagesByNumber`). `block(id)` returns `{ block, page } | null`. `textBlocksOnPage` filters `heading|paragraph`.

Mapping algorithm exactly as the Global Constraints state. For rect matching, use the block's vertical center distance; if the PDF rect's center lies inside a block, distance is 0. For `charOffset`, choose a block whose `[sourceCharStart, sourceCharEnd)` contains it; otherwise the block with the nearest `sourceCharStart`. Clamp pages into `1..pageCount`. `reflowLocatorFor` preserves `percent` from the source locator; `pdfLocatorFor` preserves it too. Reflow→PDF sets `rect` to the matched block's rect and `charOffset = sourceCharStart + charRange[0]` only when both values exist. Never throw on malformed input; return `null` for kinds that cannot map.

- [ ] **Step 5: Export and run tests**

Re-export from `index.ts`; run `pnpm --filter @bookr/reader-core test -- reflow-mapping settings && pnpm --filter @bookr/reader-core typecheck`.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/reader-core
git commit -m "feat(reader-core): add reflow settings and mode locator mapping"
```

---

### Task 4: Reflow rendering and navigation engine

**Files:**
- Create: `packages/reader-core/src/reflow/render.ts`, `packages/reader-core/src/reflow/engine.ts`
- Modify: `packages/reader-core/src/factory.ts`, `packages/reader-core/src/index.ts`
- Test: `packages/reader-core/src/__tests__/reflow-engine.test.ts`, `packages/reader-core/src/__tests__/factory.test.ts`

**Interfaces:**
- Produces: `renderReflowDocument(pack: ReflowPack, container: HTMLElement): RenderedReflowDocument` where

```ts
export interface RenderedReflowDocument {
  host: HTMLElement;          // .bookr-reflow-scroll, owns scrolling
  article: HTMLElement;       // .bookr-reflow, owns typography
  blockElements: Map<string, HTMLElement>;
  skippedBlocks: number;
}
```

- Produces: `applyReflowStyles(article: HTMLElement, settings: ReaderSettings): void` (sets CSS custom properties `--reflow-font-size`, `--reflow-line-height`, `--reflow-margin`, `--reflow-font-family`).
- Produces: `class ReflowReaderEngine implements ReaderEngine` with `constructor(deps?: { fetchPack?: (url: string) => Promise<unknown> })`.
- Produces: `createReaderEngine('reflow')` returns a `ReflowReaderEngine`.
- `open` resolves `{ kind: 'reflow', title: null, pageCount: pack.source.pageCount, toc }` (the Task 1 pack schema has no title field); `toc` maps pack TOC entries to `{ id: 'reflow-toc-<index>', label, depth: level - 1, locator: { kind:'reflow', sourcePage: page, percent: percentForPage(page, pageCount) }, children: [] }` (import `percentForPage` from `../locator`).

- [ ] **Step 1: Write the failing engine tests**

Use a helper that builds a 3-page pack, a container, and injects a pack loader:

```ts
function makePack(): ReflowPack { /* pages + one heading and two paragraphs per page, page 2 empty */ }

function scrollMetrics(host: HTMLElement, scrollHeight = 1500, clientHeight = 500) {
  let top = 0;
  Object.defineProperty(host, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(host, 'clientHeight', { configurable: true, get: () => clientHeight });
  Object.defineProperty(host, 'scrollTop', {
    configurable: true, get: () => top, set: (value: number) => { top = value; },
  });
}

it('renders blocks as text, never as markup', async () => {
  const pack = makePack();
  pack.pages[0]!.blocks[0]!.text = '<script>alert(1)</script>';
  const container = document.createElement('div');
  const engine = new ReflowReaderEngine({ fetchPack: async () => pack });
  const info = await engine.open('https://fake-s3.local/pack.json', container, DEFAULT_READER_SETTINGS);
  expect(info).toMatchObject({ kind: 'reflow', pageCount: 3 });
  expect(container.querySelector('script')).toBeNull();
  expect(container.querySelector('[data-block-id="p1-b0"]')?.textContent).toBe('<script>alert(1)</script>');
  await engine.destroy();
});

it('opens at a mapped PDF locator and reports relocation', async () => {
  const pack = makePack();
  const container = document.createElement('div');
  const engine = new ReflowReaderEngine({ fetchPack: async () => pack });
  await engine.open('https://fake-s3.local/pack.json', container, DEFAULT_READER_SETTINGS);
  const host = container.querySelector('.bookr-reflow-scroll') as HTMLElement;
  scrollMetrics(host);
  // jsdom has no layout; give the three text blocks stacked offsets so the
  // engine's "first block near the viewport top" rule is observable.
  let offset = 0;
  for (const element of container.querySelectorAll<HTMLElement>('[data-block-type="heading"], [data-block-type="paragraph"]')) {
    Object.defineProperty(element, 'offsetTop', { configurable: true, get: () => offset });
    offset += 200;
  }
  const events: Array<{ blockId?: string }> = [];
  engine.on('relocated', ({ locator }) => events.push(locator as { blockId?: string }));

  await engine.goTo({ kind: 'pdf', page: 1, percent: 0.2, rect: { x: 0.1, y: 0.6, w: 0.8, h: 0.02 } });
  expect(events.at(-1)?.blockId).toBe('p1-b1');
  expect(engine.currentLocator()).toMatchObject({ kind: 'reflow', sourcePage: 1, blockId: 'p1-b1' });
  await engine.destroy();
});

it('navigates by page percent and rejects an invalid pack', async () => {
  const pack = makePack();
  const engine = new ReflowReaderEngine({ fetchPack: async () => pack });
  const container = document.createElement('div');
  await engine.open('https://fake-s3.local/pack.json', container, DEFAULT_READER_SETTINGS);
  const host = container.querySelector('.bookr-reflow-scroll') as HTMLElement;
  scrollMetrics(host);
  await engine.goToPercent(0.5);
  expect(host.scrollTop).toBe(500);
  await engine.next();
  expect(host.scrollTop).toBe(950);
  await engine.previous();
  expect(host.scrollTop).toBe(500);
  await engine.destroy();

  const bad = new ReflowReaderEngine({ fetchPack: async () => ({ schemaVersion: 99 }) });
  await expect(bad.open('https://fake-s3.local/bad.json', document.createElement('div'), DEFAULT_READER_SETTINGS))
    .rejects.toThrow('Invalid reflow pack');
});
```

Add factory test: `createReaderEngine('reflow')` is a `ReflowReaderEngine`, and two calls return distinct instances.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @bookr/reader-core test -- reflow-engine factory`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `reflow/render.ts`**

`renderReflowDocument` leaves `container` empty and appends `host`; `host` has class `bookr-reflow-scroll` and `article` class `bookr-reflow`. Every block element carries `data-block-id`, `data-block-type`, `data-source-page`. Text blocks are `h1`–`h6` for heading (level clamped 1–6) or `p` for paragraph, and their only child is a text node (`textContent = block.text`). Visual blocks are `<figure class="bookr-reflow-visual" aria-label="原文图像">` containing `<canvas>`; Task 5 paints them. Blocks are appended in pack order (pages in order, blocks in order). Skip a block whose `rect` or `id` is unusable rather than throwing; count skips and expose them on the returned object as `skippedBlocks: number`.

- [ ] **Step 4: Implement `reflow/engine.ts`**

State: pack, index, rendered DOM, current settings, open flag, rAF handle, flash timers, emitter. Requirements:
- `open`: fetch/parse pack (`indexReflowPack`), render DOM, `applyReflowStyles`, attach scroll listener, build TOC, resolve info, then `goTo(initialLocator)` if provided, else `goToPercent(0)`; emit one `relocated`. `open` after a previous open must tear down first. Wrap unknown errors as `Error('Invalid reflow pack')` and emit `{ code:'load-failed' }`.
- `goTo`: accept `pdf` or `reflow` locators. Convert with `reflowLocatorFor`. If a block is found, set `host.scrollTop = Math.max(0, element.offsetTop - 24)` and flash `bookr-reflow-flash` for 1200ms when requested; otherwise use `goToPercent(locator.percent)`. Never throw on unknown kinds (return resolved).
- `goToPercent(percent)`: `host.scrollTop = clamp(percent,0,1) * Math.max(0, scrollHeight - clientHeight)`; emit relocated.
- `next`/`previous`: scroll by `0.9 * (clientHeight || 600)`; emit.
- `currentLocator`: compute scroll percent; find the last text block with `offsetTop <= scrollTop + clientHeight * 0.33`, falling back to the first text block, then `{ kind:'reflow', sourcePage: block.page, percent, blockId: block.id }`; without blocks `{ kind:'reflow', sourcePage: 1, percent }`.
- `setSettings`: `applyReflowStyles(article, settings)`; keep typography changes from resetting the scroll position.
- `setHighlights`: Task 5 fills this in; for now store the list and do nothing.
- `on`: TypedEmitter. `destroy`: remove listener, cancel rAF/timers, clear the container, mark closed; idempotent.
- Scroll handler: rAF-throttled; emit only when scroll percent changes by more than `0.0005` (same epsilon as the PDF engine) or the visible block changes.

- [ ] **Step 5: Update the factory and exports**

```ts
export function createReaderEngine(kind: ReaderEngineKind): ReaderEngine {
  if (kind === 'epub') return new EpubReaderEngine();
  if (kind === 'reflow') return new ReflowReaderEngine();
  return new PdfReaderEngine();
}
```

Export `ReflowReaderEngine`, render helpers and `ReflowPackIndex` from `index.ts`. Do not import React.

- [ ] **Step 6: Add reflow CSS basics**

In `apps/web/src/features/reader/reader.css` add:

```css
.reader-content[data-reader-kind='reflow'] { overflow: hidden; }
.bookr-reflow-scroll { position: absolute; inset: 0; overflow-y: auto; background: var(--reader-paper); }
.bookr-reflow {
  box-sizing: border-box;
  width: min(100%, 46rem);
  margin: 0 auto;
  padding: 5rem max(var(--reflow-margin, 7%), 1.25rem) 6rem;
  color: var(--reader-ink);
  font-family: var(--reflow-font-family, Georgia, 'Songti SC', serif);
  font-size: var(--reflow-font-size, 19px);
  line-height: var(--reflow-line-height, 1.9);
  letter-spacing: 0.01em;
}
.bookr-reflow :is(h1,h2,h3,h4,h5,h6) { font-family: var(--font-serif, Georgia, serif); line-height: 1.35; margin: 2.2em 0 0.9em; }
.bookr-reflow p { margin: 0 0 1.05em; text-align: justify; text-justify: inter-ideograph; }
.bookr-reflow-visual { position: relative; margin: 1.4em 0; }
.bookr-reflow-visual canvas { display: block; width: 100%; height: auto; }
.bookr-reflow-flash { animation: reflow-flash 1.2s ease; }
@keyframes reflow-flash { from { background: color-mix(in srgb, var(--reader-accent) 22%, transparent); } to { background: transparent; } }
```

Add responsive rules so on screens under 640px the side padding is at least 1rem and headings shrink one step. The `data-reader-kind='reflow'` attribute is set by Task 7.

- [ ] **Step 7: Run tests and typecheck**

Run: `pnpm --filter @bookr/reader-core test -- reflow-engine factory && pnpm --filter @bookr/reader-core typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/reader-core apps/web/src/features/reader/reader.css
git commit -m "feat(reader-core): render and navigate reflow packs"
```

---

### Task 5: Reflow selection, highlights and original-page painting

**Files:**
- Create: `packages/reader-core/src/reflow/selection.ts`, `packages/reader-core/src/reflow/highlights.ts`, `packages/reader-core/src/reflow/source-painter.ts`
- Modify: `packages/reader-core/src/reflow/engine.ts`, `packages/reader-core/src/reflow/render.ts`, `packages/reader-core/src/pdf/engine.ts`, `packages/reader-core/src/index.ts`
- Test: `packages/reader-core/src/__tests__/reflow-selection.test.ts`, `packages/reader-core/src/__tests__/reflow-highlights.test.ts`, `packages/reader-core/src/__tests__/reflow-painter.test.ts`, `packages/reader-core/src/__tests__/pdf-engine.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ReflowRangeRef { blockId: string; charRange: [number, number] }
export interface ReflowSelectionResult {
  refs: ReflowRangeRef[];
  text: string;
  rect: { left: number; top: number; width: number; height: number };
}
export function selectionToReflow(selection: Selection, root: HTMLElement): ReflowSelectionResult | null;
export function charOffsetWithin(block: HTMLElement, node: Node, offset: number): number;

export interface ReflowMark {
  id: string; blockId: string; charRange: [number, number];
  color: AnnotationColor; hasNote: boolean;
}
export function marksForHighlights(highlights: ReaderHighlight[]): Map<string, ReflowMark[]>;
export function renderBlockText(block: HTMLElement, text: string, marks: ReflowMark[]): void;

export function normalizedCrop(rect: LocatorRect, width: number, height: number):
  { sx: number; sy: number; sw: number; sh: number };

export interface PainterPage {
  getViewport(params: { scale: number }): { width: number; height: number };
  render(params: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void>; cancel(): void };
}
export interface PainterDocument { numPages: number; getPage(page: number): Promise<PainterPage> }
export interface SourcePagePainterLike {
  load(url: string): Promise<void>;
  paint(page: number, rect: LocatorRect, canvas: HTMLCanvasElement): Promise<void>;
  destroy(): Promise<void>;
}
export class SourcePagePainter implements SourcePagePainterLike {
  constructor(options: OpenReaderOptions, loadDocument?: (url: string, options: OpenReaderOptions) => Promise<PainterDocument>);
}
```

- `ReflowReaderEngine` constructor extends to `{ fetchPack?: (url: string) => Promise<unknown>; painterFactory?: (options: OpenReaderOptions) => SourcePagePainterLike | null }`.
- `ReflowReaderEngine` implements `setHighlights`, emits `selection` and `highlightClick`; visual blocks render their source region when `sourcePdfUrl` is supplied.

- [ ] **Step 1: Write the failing pure tests**

Selection tests (jsdom Range):
- Select from the middle of paragraph 1 into paragraph 2 → `refs` equals first `[start, len1]` and second `[0, end]`; `text` is the selected substring; a selection outside the root returns null; reversed anchors are normalized; whitespace-only returns null.
- `charOffsetWithin` counts `𠮷` as two UTF-16 units: block text `a𠮷b`, a text-node offset of 3 (after `𠮷`) → 3, and offset 4 (after `b`) → 4.

Highlight tests:
- `renderBlockText` with marks `[0,2]` and `[1,3]` produces segments `[0,1]` plain, `[1,2]` second mark, `[2,3]` second mark, and `mark` elements carry `data-highlight-id` and `backgroundColor` from `HIGHLIGHT_HEX`.
- Out-of-range/negative ranges are clamped or ignored; a block with no marks receives a single text node.
- Text `<img src=x onerror=alert(1)>` is rendered as text, never an element.

Painter tests:
- `normalizedCrop({x:0.1,y:0.2,w:0.5,h:0.4}, 1000, 2000)` → `{sx:100, sy:400, sw:500, sh:800}`; values clamp to the bitmap.
- A fake `loadDocument` returning `{ numPages: 2, getPage: async () => ({ getViewport: () => ({ width: 612, height: 792 }), render: () => ({ promise: Promise.resolve(), cancel: () => {} }) }) }` lets `load` resolve and `paint` reject gracefully (jsdom has no 2D context) without throwing out of the engine.

Engine tests:
- `setHighlights` wraps selected ranges in the rendered blocks and removes marks when the list becomes empty.
- A selection made across two paragraphs emits a `selection` event after 60ms whose locator has `blockId` + `charRange` + `ranges.length === 2`.
- With a fake painter, every visual block's canvas is painted once; a painter rejection adds the note `原文图像暂不可用，可切回原版查看` and does not reject `open`.
- `destroy` disconnects the observer and calls `painter.destroy`.
- PDF engine `goTo({ kind:'reflow', sourcePage: 5, percent: 0.5 })` lands on page 5 (extend the existing `pdf-engine.test.ts` fake document).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @bookr/reader-core test -- reflow-selection reflow-highlights reflow-painter pdf-engine`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement selection and highlights**

`selectionToReflow` walks up from `anchorNode`/`focusNode` to the nearest `[data-block-id]` whose `data-block-type` is `heading` or `paragraph`; `range.commonAncestorContainer` must be inside `root`. Use a `Range` clone to normalize direction. Collect text blocks between the start and end elements using `root.querySelectorAll('[data-block-type="heading"],[data-block-type="paragraph"]')`. Compute offsets with `charOffsetWithin`; clamp each range to `[0, block.textContent.length]`; drop empty segments; require at least one ref and non-empty trimmed text. Return the selection's `getBoundingClientRect()`.

`renderBlockText` builds segment boundaries from clamped marks, skips marks whose blockId does not match, and for each segment picks the **last** covering mark (the most recently applied highlight wins where ranges overlap). Use `document.createTextNode` and `<mark>` with `style.backgroundColor = HIGHLIGHT_HEX[color]`, `dataset.highlightId = id`, class `bookr-reflow-mark` plus `has-note` when `hasNote`. Never use `innerHTML`.

- [ ] **Step 4: Implement `source-painter.ts`**

`normalizedCrop` multiplies rect by bitmap size and clamps `sx/sy/sw/sh` into `[0,width]/[0,height]`. `SourcePagePainter` lazily loads the PDF with pdf.js `getDocument` (passing `workerSrc`, `cMapUrl`, `standardFontDataUrl` from options), caches rendered full pages in a `Map<number, HTMLCanvasElement>` at the target pixel width (`max(canvas.clientWidth, 640) * devicePixelRatio`), and paints a crop onto the caller's canvas:
- Load the page viewport at `scale = targetWidth / viewport.width`.
- Render the page into an offscreen canvas (reuse the cache; a second paint of the same page waits on the in-flight promise).
- Size the target canvas by `cssWidth * dpr` and `cssWidth * (rect.h / rect.w) * dpr`, then `drawImage` the crop.
- `destroy` cancels in-flight render tasks, destroys the PDF document and clears the cache. All async work checks a generation token so a destroyed painter never touches the DOM.
- If `getContext('2d')` is null (jsdom/unsupported host), reject with `Error('Canvas is unavailable')`; the engine catches it.

- [ ] **Step 5: Extend the reflow engine**

- On open, register a debounced (60ms) `selectionchange` listener on the owner document; ignore events while a dialog owns the screen only in the web layer (engine always emits). Convert with `selectionToReflow`; build locator `{ kind:'reflow', sourcePage: pageOf(primary.blockId), percent: this.currentPercent(), blockId, charRange, ranges: refs.length > 1 ? refs : undefined }`; emit `selection` with `{ text, locator, rect }`, or `null` when the selection is empty/outside.
- Root click handler: `event.target.closest('[data-highlight-id]')` → emit `highlightClick` with the id; do not treat it as a tap.
- `setHighlights`: store; rebuild every text block's content with `renderBlockText` and that block's marks from `marksForHighlights`; only re-render blocks whose mark signature changed to avoid destroying a live selection on every annotation cache refresh.
- Visual blocks: keep `{ page, rect, figure, canvas }`; after open call `painter.load(sourcePdfUrl)` asynchronously. If `IntersectionObserver` exists, observe figures with `rootMargin: '200% 0px'`; otherwise paint immediately. Paint once per block; on failure hide the canvas and append the note once. If no `sourcePdfUrl`, append the note immediately.
- `destroy` removes the selection/click listeners, disconnects the observer, clears timers and destroys the painter; idempotent.

- [ ] **Step 6: Accept reflow locators in the PDF engine**

At the top of `PdfReaderEngine.goTo`, if `locator.kind === 'reflow'`, normalize to
`{ kind:'pdf', page: clamp(locator.sourcePage, 1, pageCount), percent: locator.percent }` and continue. `goToPercent` and `currentLocator` are unchanged. Add the corresponding test to `pdf-engine.test.ts`.

- [ ] **Step 7: Update exports and run tests**

Export the new modules from `index.ts`. Run:
`pnpm --filter @bookr/reader-core test && pnpm --filter @bookr/reader-core typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/reader-core
git commit -m "feat(reader-core): add reflow selection, highlights and page fallbacks"
```

---

### Task 6: Web reflow pack upload API and shelf management

**Files:**
- Create: `apps/web/src/api/reflow.ts`, `apps/web/src/features/bookshelf/ReflowPackSection.tsx`
- Modify: `apps/web/src/features/bookshelf/EditBookDialog.tsx`, `apps/web/src/features/bookshelf/BookCard.tsx`, `apps/web/src/features/bookshelf/labels.ts`
- Test: `apps/web/src/features/bookshelf/__tests__/reflow-pack.test.tsx`, `apps/web/src/features/bookshelf/__tests__/bookshelf.test.tsx`

**Interfaces:**
- Produces:

```ts
export function fetchReflowFile(bookId: string): Promise<ReflowFileInfo>;
export function createReflowUpload(bookId: string, input: { size: number; sha256: string }): Promise<CreateReflowUploadResponse>;
export function completeReflowUpload(bookId: string, uploadId: string): Promise<CompleteReflowUploadResponse>;
export function deleteReflowPack(bookId: string): Promise<void>;
export interface ReflowUploadDeps {
  hash: (file: File, signal?: AbortSignal) => Promise<string>;
  create: (bookId: string, input: { size: number; sha256: string }) => Promise<CreateReflowUploadResponse>;
  post: (target: PresignedUploadTarget, file: File, onProgress: (percent: number) => void, signal?: AbortSignal) => Promise<void>;
  complete: (bookId: string, uploadId: string) => Promise<CompleteReflowUploadResponse>;
}
export function uploadReflowPack(
  bookId: string,
  file: File,
  options?: { onProgress?: (percent: number) => void; signal?: AbortSignal; deps?: Partial<ReflowUploadDeps> },
): Promise<CompleteReflowUploadResponse>;
```

- Produces component props:

```ts
export interface ReflowPackSectionProps {
  book: BookDto;
  onChanged?: (book: BookDto) => void;
  upload?: (file: File, onProgress: (percent: number) => void) => Promise<CompleteReflowUploadResponse>;
  remove?: () => Promise<void>;
}
```

- [ ] **Step 1: Write the failing component tests**

Use the shared `book()` fixture from `apps/web/test/setup.ts`:

```tsx
it('uploads a pack and reports page count', async () => {
  const onChanged = vi.fn();
  const upload = vi.fn(async (_file: File, onProgress: (n: number) => void) => {
    onProgress(50);
    return {
      book: book({ id: 'book-csapp', title: '深入理解计算机系统', reflowAvailable: true, reflowSchemaVersion: 1, reflowPageCount: 300 }),
      pack: { schemaVersion: 1, pageCount: 300, blockCount: 2400, fallbackPages: [] },
    };
  });
  render(<ReflowPackSection book={book({ id: 'book-csapp', title: '深入理解计算机系统' })} onChanged={onChanged} upload={upload} />);
  expect(screen.getByText('尚未上传重排包')).toBeInTheDocument();
  await userEvent.upload(screen.getByLabelText('选择重排包'), new File(['{}'], 'book.bookr.json', { type: 'application/json' }));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  expect(screen.getByText(/300 页/)).toBeInTheDocument();
});

it('rejects non-JSON and oversized files without calling upload', async () => { /* ... */ });
it('removes an existing pack after confirmation', async () => { /* remove mock, click 移除重排包, confirm */ });
it('shows the 422 message when the pack does not match the book', async () => { /* upload rejects with new ApiError('REFLOW_INVALID') */ });
```

Add to `bookshelf.test.tsx`: a PDF book with `reflowAvailable: true` shows the badge `可重排`, and a PDF without it does not.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @bookr/web test -- reflow-pack bookshelf`
Expected: FAIL — component missing.

- [ ] **Step 3: Implement `api/reflow.ts`**

Reuse `hashFile` and `postWithProgress` from `../lib/upload`. `uploadReflowPack` computes SHA-256, creates the session, POSTs the file to the presigned target, then completes it. On complete failure also surface the server error through `ApiError` unchanged. `deleteReflowPack` uses `DELETE` and expects 204.

- [ ] **Step 4: Implement `ReflowPackSection`**

- Visible only for PDF books (the parent enforces this too).
- Hidden file input with label `选择重排包`, `accept=".json,application/json"`.
- Reject: file name not ending `.json`, or `file.size > MAX_REFLOW_PACK_BYTES`, with Chinese messages `仅支持 .bookr.json 重排包` / `重排包不能超过 32 MB`.
- While uploading show `上传中 {progress}%`; on success call `onChanged(book)` and show `已上传 · {reflowPageCount} 页 · schema v{reflowSchemaVersion}`.
- Existing pack shows its status and a `移除重排包` button; first click switches to `确认移除` + `取消`, second click calls `remove`, then `onChanged({ ...book, reflowAvailable: false, reflowSchemaVersion: null, reflowPageCount: null })`.
- Errors render in `role="alert"`; use `messageForApiError`.
- Reset `input.value` after each selection so choosing the same file again retries.

- [ ] **Step 5: Wire into the edit dialog and card**

In `EditBookDialog`, render `<ReflowPackSection book={book} onChanged={() => void queryClient.invalidateQueries({ queryKey: ['book', book.id] })} />` above the title field when `book.format === 'pdf'`. Keep local `reflow` state if needed to reflect success before the query refetch.

In `BookCard`, near the format badge add a `可重排` badge when `book.reflowAvailable`; add `REFLOW_BADGE_LABEL = '可重排'` to `labels.ts`.

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm --filter @bookr/web test -- reflow-pack bookshelf && pnpm --filter @bookr/web typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/api/reflow.ts apps/web/src/features/bookshelf
git commit -m "feat(web): upload and manage reflow packs from the shelf"
```

---

### Task 7: Reader mode switching and reflow settings

**Files:**
- Create: `apps/web/src/features/reader/useReadingMode.ts`
- Modify: `apps/web/src/features/reader/ReaderPage.tsx`, `ReaderChrome.tsx`, `SettingsPanel.tsx`, `reader.css`
- Modify: `apps/web/src/features/reader/__tests__/fake-engine.ts` if needed
- Test: `apps/web/src/features/reader/__tests__/reader-reflow.test.tsx`, `reader-controls.test.tsx`, `reader-settings.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ReadingModeInput {
  book: BookDto | null;
  bookKind: ReaderKind | null;
  /** True once the signed reflow pack URL has been fetched successfully. */
  reflowReady: boolean;
  settings: ReaderSettings;
  onSwitch: (next: PdfReadingMode) => void;
}
export interface ReadingModeState {
  mode: ReaderEngineKind | null;
  reflowAvailable: boolean;
  toggleReflow: () => void;
}
export function useReadingMode(input: ReadingModeInput): ReadingModeState;
```

- `mode` is `'epub'` for EPUB, `'reflow'` when `bookKind === 'pdf' && reflowReady && settings.pdf.readingMode === 'reflow'`, otherwise `'pdf'`; `null` while the book kind is unknown. `reflowAvailable` is `book?.format === 'pdf' && book.reflowAvailable`. `toggleReflow` no-ops when unavailable, otherwise calls `onSwitch` with the opposite mode.
- `ReaderChrome` gains `reflowAvailable: boolean` and `onToggleReflow: () => void`; `kind` widens to `ReaderEngineKind`.
- `SettingsPanel` gains `kind: ReaderEngineKind`; when `kind === 'reflow'` it renders the reflow controls below.

- [ ] **Step 1: Write the failing reader tests**

Create a `reader-reflow.test.tsx` using MSW handlers for `/api/books/:id`, `/api/books/:id/file`, `/api/books/:id/reflow`, `/progress`, annotations/bookmarks. `book()` fixture with `format:'pdf', reflowAvailable:true, reflowPageCount:300, reflowSchemaVersion:1`.

```tsx
const PDF_URL = 'https://fake-s3.local/book.pdf';
const REFLOW_URL = 'https://fake-s3.local/book.bookr.json';

it('switches to reflow at the same source page and back to the original', async () => {
  // fake engine factory records the kind and every open() call.
  // open() resolves { kind, pageCount: 300, toc: [] } and currentLocator() returns
  // { kind:'pdf', page:120, percent:0.4 } until the reflow engine opens.
  renderReader({ engineFactory });
  await waitFor(() => expect(screen.getByRole('button', { name: '重排' })).toBeInTheDocument());
  await userEvent.click(screen.getByRole('button', { name: '重排' }));
  await waitFor(() => expect(openCalls.at(-1)).toMatchObject({
    url: REFLOW_URL,
    options: { sourcePdfUrl: PDF_URL, initialLocator: { kind: 'pdf', page: 120 } },
  }));
  await userEvent.click(screen.getByRole('button', { name: '原版' }));
  await waitFor(() => expect(openCalls.at(-1)).toMatchObject({
    url: PDF_URL,
    options: { initialLocator: { kind: 'pdf', page: 120 } },
  }));
});

it('disables the mode button when no pack exists', async () => { /* book.reflowAvailable = false → button disabled with title 尚未上传重排包 */ });
it('maps stored reflow progress to a PDF page when opening in original mode', async () => {
  // progress locator { kind:'reflow', sourcePage: 120, percent: 0.4 }
  // expect the PDF engine's initialLocator.page === 120
});
it('applies reflow typography without reopening the book', async () => {
  // Settings panel in reflow mode: change 字号 to 24 → engine.setSettings called with reflow.fontSize 24;
  // the factory must not be called again.
});
it('jumps by source page in reflow mode', async () => {
  // page input '60' + 跳转 → engine.goTo with { kind:'reflow', sourcePage:60, percent: 59/300 }
});
```

Also extend `reader-controls.test.tsx` to assert the button label toggles `重排 → 原版`, and `reader-settings.test.ts` to assert reflow controls are shown only for `kind === 'reflow'`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @bookr/web test -- reader-reflow reader-controls reader-settings`
Expected: FAIL — mode hook/button missing.

- [ ] **Step 3: Implement `useReadingMode`**

Pure derivation as described; no fetching. `toggleReflow` uses `mode === 'reflow' ? 'original' : 'reflow'` and is a `useCallback` over `mode`, `reflowAvailable`, and `onSwitch`.

- [ ] **Step 4: Integrate into `ReaderPage`**

1. Add `reflowFile` to the source payload:
```ts
interface ReaderSource {
  file: ReaderFileInfo;
  reflow: ReflowFileInfo | null;
  initialLocator?: Locator;
}
```
The source effect fetches `fetchReflowFile(bookId).catch(() => null)` in parallel only when `book?.reflowAvailable`; a reflow fetch failure must not block opening the original.
2. Gate engine creation on the source being resolved, and create it from `mode`:
```ts
useEffect(() => {
  if (!bookId || !source || !mode) return;
  const created = engineFactoryRef.current(mode);
  setEngine(created);
  return () => { setEngine(null); void Promise.resolve(created.destroy()).catch(() => {}); };
}, [bookId, source, mode]);
```
3. Add `pendingLocatorRef = useRef<Locator | null>(null)`. `switchReadingMode(next)`:
```ts
if (next === 'reflow' && !source?.reflow) { showToast('无法加载重排包'); return; }
const current = currentLocatorRef.current ?? (engine ? engine.currentLocator() : null);
pendingLocatorRef.current = current ? locatorForMode(current, next) : null;
changeSettings({ ...settings, pdf: { ...settings.pdf, readingMode: next } });
```
`switchReadingMode` must be declared after `changeSettings` (or as a function declaration) so its dependency array does not read a `const` in the temporal dead zone.
4. In the open effect, choose the URL/options and clear `pendingLocatorRef` after a successful open:
```ts
const useReflow = readerMode === 'reflow';
const url = useReflow ? source.reflow!.url : source.file.url;
const requested = pendingLocatorRef.current ?? source.initialLocator;
const initialLocator = requested ? locatorForMode(requested, useReflow ? 'reflow' : 'original') ?? requested : undefined;
const options: OpenReaderOptions = {
  initialLocator,
  ...(useReflow ? { sourcePdfUrl: source.file.url } : {}),
  ...(source.file.format === 'pdf' ? { workerSrc: pdfWorkerUrl, cMapUrl: '/cmaps/', standardFontDataUrl: '/standard_fonts/' } : {}),
};
```
`useReflow` is `readerMode === 'reflow'`; when opening reflow from stored PDF progress, the PDF locator passes through and the engine maps it. When opening original with stored reflow progress, `locatorForMode` returns the source page PDF locator.
5. Restore the engine error message for a missing reflow file: if reflow mode and `source.reflow === null`, set status error with `无法加载重排包，请切回原版`.
6. Page and jump:
```ts
const page = currentLocator?.kind === 'pdf' ? currentLocator.page
  : currentLocator?.kind === 'reflow' ? currentLocator.sourcePage : 1;

const jumpToPage = (page: number) => {
  if (!engine) return;
  const count = Math.max(1, documentInfo?.pageCount ?? 1);
  const percent = percentForPage(page, count);
  ignoreRejection(() => engine.goTo(
    mode === 'reflow'
      ? { kind: 'reflow', sourcePage: page, percent }
      : { kind: 'pdf', page, percent },
  ));
};
```
7. Root attributes: `data-reader-kind={mode ?? undefined}`; pass `kind={mode ?? 'pdf'}` to chrome and settings; `ReaderContent` is unchanged.
8. `changeSettings` must not recreate the engine for reflow typography. Mode switches go through `switchReadingMode`, which changes `settings.pdf.readingMode` and therefore `mode`; typography changes leave `mode` unchanged. `engine?.setSettings(merged)` still applies both.
9. Widen `ReaderPageProps.engineFactory` to `(kind: ReaderEngineKind) => ReaderEngine` and update `__tests__/fake-engine.ts` / `reader-page.test.tsx` helpers accordingly.
10. The existing `toHighlights` projection is unchanged: the reflow engine ignores non-reflow locators and the PDF engine ignores reflow highlights. Jumping from a note in the other mode works through `engine.goTo` mapping.

- [ ] **Step 5: Add the chrome toggle**

In `ReaderChrome`, before the TOC button:

```tsx
{(kind === 'pdf' || kind === 'reflow') ? (
  <button
    type="button"
    aria-pressed={kind === 'reflow'}
    disabled={!reflowAvailable}
    title={reflowAvailable ? undefined : '尚未上传重排包'}
    onClick={onToggleReflow}
  >
    {kind === 'reflow' ? '原版' : '重排'}
  </button>
) : null}
```

Show `第 x / y 页` and the page-jump input for both `pdf` and `reflow`; EPUB keeps `%`. `pageCount` comes from `documentInfo` (the reflow engine reports `pack.source.pageCount`).

- [ ] **Step 6: Add reflow controls to the settings panel**

When `kind === 'reflow'`, render:
- 字体: select `衬线` (`serif`) / `黑体` (`sans`) bound to `settings.reflow.fontFamily`.
- 字号: range 16–28 step 1 bound to `fontSize`.
- 行距: range 1.5–2.4 step 0.1 bound to `lineHeight`.
- 页边距: range 2–16 step 1 bound to `margin`.
Keep theme and brightness for all kinds. Add a `updateReflow` helper mirroring `updatePdf`.

- [ ] **Step 7: Finish reflow CSS and accessibility**

Ensure `.bookr-reflow-mark` uses a rounded background, preserves text color and inherits `cursor: pointer`; `.bookr-reflow-mark.has-note::after` draws a 4px accent dot. In dark theme marks keep the same colors with `mix-blend-mode: multiply` disabled and `color: inherit`. Add `.bookr-reflow-visual-note` (muted, centered, small) and `figure[data-state='failed'] canvas { display: none; }`.

- [ ] **Step 8: Run tests and typecheck**

Run: `pnpm --filter @bookr/web test -- reader-reflow reader-controls reader-settings reader-page && pnpm --filter @bookr/web typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/features/reader
git commit -m "feat(web): switch between original and reflow reading modes"
```

---

### Task 8: End-to-end reflow acceptance

**Files:**
- Modify: `apps/web/scripts/make-reader-fixtures.mjs`
- Create: `apps/web/e2e/helpers.ts`, `apps/web/e2e/reflow.spec.ts`
- Modify: `apps/web/e2e/reader.spec.ts`（把 `adminAuth/registerFreshReader/uploadAndRename/openBook` 移到 helpers 并 import）
- Modify: `apps/web/e2e/global-setup.ts` if the pack file needs listing

**Interfaces:**
- Produces fixture `apps/web/e2e/fixtures/reader.bookr.json` generated from `reader.pdf` with `source.sha256` equal to the PDF bytes' SHA-256, `source.pageCount = 300`, and one `paragraph` block per page containing `Bookr reader fixture - page ${page}` (rect `{x:0.11,y:0.07,w:0.55,h:0.04}`), plus page 1's `The quick brown fox jumps over the lazy dog` block at `{x:0.11,y:0.12,w:0.7,h:0.04}` and a TOC entry `{label:'第 3 页',page:3,level:1}`.
- Produces `uploadReflowPack(request, bookId, packPath, authorization)` in `e2e/helpers.ts`: reads the pack, calls create, POSTs the presigned form with Playwright's `multipart` (`file` last), then completes. Returns the complete response body.

- [ ] **Step 1: Extend the fixture generator**

Compute the PDF hash from the exact bytes written to disk:

```js
import { createHash } from 'node:crypto';
const pdfBytes = await makePdf();
writeFileSync(join(fixturesDir, 'reader.pdf'), pdfBytes);
const sha256 = createHash('sha256').update(pdfBytes).digest('hex');
const pack = makeReflowPack(sha256);
writeFileSync(join(fixturesDir, 'reader.bookr.json'), JSON.stringify(pack, null, 2));
```

`makeReflowPack` pins `generatedAt: '2024-01-01T00:00:00.000Z'`, `tool: { name:'bookr-preprocess', version:'e2e' }`, `quality: { pages:300, textBlocks:301, fallbackPages:[], ocrPages:[], avgConfidence:null, warnings:[] }`, and page objects `{ page, width:612, height:792, blocks:[...] }`. Keep JSON deterministic.

- [ ] **Step 2: Write the failing E2E spec**

```ts
test('reads a PDF in reflow mode, keeps its page across modes and saves a reflow highlight', async ({ page, request }) => {
  const { username } = await registerFreshReader(page, request);
  await uploadAndRename(page, PDF_FIXTURE, '端到端重排 PDF');
  const bookId = await openBook(page, '端到端重排 PDF');

  const auth = await readerAuth(request, username, READER_PASSWORD);
  await uploadReflowPack(request, bookId, 'e2e/fixtures/reader.bookr.json', auth.authorization);
  await page.reload();
  await expect(page.getByRole('button', { name: '重排' })).toBeEnabled();
  await page.getByRole('button', { name: '重排' }).click();
  await expect(page.locator('.bookr-reflow')).toContainText('Bookr reader fixture - page 1');

  // Jump to source page 120 in reflow mode.
  await page.getByLabel('页码').fill('120');
  await page.getByRole('button', { name: '跳转' }).click();
  await expect(page.getByText('Bookr reader fixture - page 120')).toBeInViewport();

  // Typography applies without reopening.
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByLabel('字号').fill('24');
  await expect(page.locator('.bookr-reflow')).toHaveCSS('font-size', '24px');
  await page.getByRole('button', { name: '关闭' }).click();

  // Switch back: the original PDF lands on the same source page (±1).
  await page.getByRole('button', { name: '原版' }).click();
  await expect(page.getByText(/第 12[01] \/ 300 页/)).toBeVisible();

  // Switch again and create a reflow highlight through the real selection menu.
  await page.getByRole('button', { name: '重排' }).click();
  await page.evaluate(() => {
    const block = document.querySelector<HTMLElement>('.bookr-reflow [data-block-id]');
    const text = block?.firstChild;
    if (!block || !text) throw new Error('reflow block missing');
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, Math.min(12, text.textContent?.length ?? 0));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.getByRole('button', { name: '黄色划线' }).click();
  const annotations = await request.get(`/api/books/${bookId}/annotations`, { headers: auth });
  const body = await annotations.json();
  expect(body.items[0].locator.kind).toBe('reflow');
  expect(body.items[0].locator.ranges?.length ?? 1).toBeGreaterThanOrEqual(1);
});
```

`toBeInViewport` needs the element to exist; scrolling triggered by jump may land mid-page, so locate the exact paragraph. The reading chrome auto-hides after 2.5s; move the pointer (`page.mouse.move`) before clicking chrome buttons.

- [ ] **Step 3: Run the spec to verify it fails**

Prerequisite: rebuild and start the stack (`docker compose up -d --build`). Run:
`pnpm --filter @bookr/web e2e -- e2e/reflow.spec.ts`
Expected: FAIL — pack endpoints/fixture missing.

- [ ] **Step 4: Implement the helper and make the spec pass**

`readerAuth` logs in with `{ username, password }` and returns `{ authorization: 'Bearer …' }`. `uploadReflowPack` POSTs the presigned form with `multipart` where every `fields` entry is a string and `file` is `{ name: 'reader.bookr.json', mimeType: 'application/json', buffer }`; assert create 201 and complete 200. Add cleanup for the generated book to the shared `registerFreshReader` helper (it already trashes books uploaded by the shared display name).

- [ ] **Step 5: Run both E2E specs**

Run: `pnpm --filter @bookr/web e2e`
Expected: all specs pass (4+ tests). If the fixture PDF is already on the shelf from manual testing, trash it first; E2E's sha256 dedupe blocks the upload.

- [ ] **Step 6: Commit**

```bash
git add apps/web/e2e apps/web/scripts/make-reader-fixtures.mjs
git commit -m "test(e2e): prove reflow switching, typography and highlights"
```

---

### Task 9: Python pack model, layout heuristics and schema validation

**Files:**
- Create: `tools/pdf-preprocess/pyproject.toml`
- Create: `tools/pdf-preprocess/bookr_preprocess/__init__.py`, `model.py`, `detect.py`, `layout.py`, `schema.py`, `quality.py`
- Test: `tools/pdf-preprocess/tests/test_layout.py`, `test_schema.py`

**Interfaces:**
- Produces dataclasses:

```python
@dataclass(frozen=True)
class RawLine:
    text: str
    x0: float; y0: float; x1: float; y1: float   # PDF points, origin top-left
    font_size: float
    bold: bool = False
    confidence: float | None = None

@dataclass
class ExtractedPage:
    page: int
    width: float
    height: float
    lines: list[RawLine]
    image_rects: list[tuple[float, float, float, float]] = field(default_factory=list)
    text_chars: int = 0
    ocr: bool = False
    warnings: list[str] = field(default_factory=list)

@dataclass
class Block:
    id: str; type: str; rect: dict[str, float]
    text: str | None = None
    level: int | None = None
    source_char_start: int | None = None
    source_char_end: int | None = None
    confidence: float | None = None

@dataclass
class ReflowPack:
    schema_version: int; source_sha256: str; page_count: int
    generated_at: str; tool_version: str
    pages: list[dict]; toc: list[dict]; quality: dict
    def to_dict(self) -> dict
```

- Produces pure helpers:
  - `utf16_len(text: str) -> int`
  - `normalize_rect(x0, y0, x1, y1, width, height) -> dict` (clamped, 6 dp)
  - `has_usable_text_layer(pages: list[ExtractedPage], min_chars_per_page: int = 100) -> bool`
  - `body_font_size(lines: list[RawLine]) -> float`, `median_line_height(lines) -> float`
  - `repeated_margin_texts(pages: list[ExtractedPage], threshold: float = 0.3) -> set[str]`
  - `merge_lines(texts: list[str]) -> str`
  - `lines_to_blocks(page: ExtractedPage, repeated_margins: set[str]) -> list[Block]`
  - `build_quality(pages: list[ExtractedPage], blocks_by_page: dict[int, list[Block]], fallback_pages: list[int], ocr_pages: list[int], warnings: list[str]) -> dict`
  - `validate_pack(pack: dict) -> list[str]` (empty list means valid; mirrors the TS schema)
  - `class PackValidationError(Exception)` carrying `errors: list[str]`
  - `@dataclass OcrLine: text: str; x0: float; y0: float; x1: float; y1: float; confidence: float`（normalized 0–1）

```python
class OcrBackend(Protocol):
    def recognize(self, png: bytes, lang: str) -> list[OcrLine]: ...

class TextCorrector(Protocol):
    def correct(self, text: str) -> str: ...
```


- [ ] **Step 1: Write the failing layout tests**

```python
from bookr_preprocess.layout import merge_lines, lines_to_blocks, body_font_size
from bookr_preprocess.model import RawLine, ExtractedPage, utf16_len, normalize_rect

def line(text, x0=72, y0=100, x1=500, y1=112, size=11, bold=False):
    return RawLine(text=text, x0=x0, y0=y0, x1=x1, y1=y1, font_size=size, bold=bold)

def test_utf16_len_counts_supplementary_characters():
    assert utf16_len('a𠮷b') == 4
    assert utf16_len('第一章') == 3

def test_merge_lines_handles_cjk_and_hyphenation():
    assert merge_lines(['这是第一行', '接着第二行']) == '这是第一行接着第二行'
    assert merge_lines(['inter-', 'national']) == 'international'
    assert merge_lines(['hello', 'world']) == 'hello world'

def test_heading_detection_and_levels():
    page = ExtractedPage(page=1, width=612, height=792, lines=[
        line('第一章', y0=80, y1=104, size=22, bold=True),
        line('第一段正文内容。', y0=130, y1=142, size=11),
        line('第二段正文内容。', y0=160, y1=172, size=11),
    ])
    blocks = lines_to_blocks(page, set())
    assert blocks[0].type == 'heading'
    assert blocks[0].level == 1
    assert [b.type for b in blocks[1:]] == ['paragraph', 'paragraph']

def test_paragraph_breaks_on_indent_and_gap():
    page = ExtractedPage(page=1, width=612, height=792, lines=[
        line('第一段第一行', x0=72, y0=100),
        line('第一段第二行', x0=72, y0=114),
        line('第二段首行', x0=90, y0=128),
    ])
    texts = [b.text for b in lines_to_blocks(page, set())]
    assert texts == ['第一段第一行第一段第二行', '第二段首行']

def test_margin_noise_and_page_numbers_are_dropped():
    pages = [
        ExtractedPage(page=i, width=612, height=792, lines=[
            line('Bookr Header', y0=10, y1=20, size=8),
            line('正文内容', y0=100, y1=112),
            line(str(i), y0=770, y1=780, size=8),
        ])
        for i in range(1, 6)
    ]
    from bookr_preprocess.layout import repeated_margin_texts
    repeated = repeated_margin_texts(pages)
    blocks = lines_to_blocks(pages[0], repeated)
    assert [b.text for b in blocks] == ['正文内容']

def test_character_offsets_include_newlines_and_utf16():
    page = ExtractedPage(page=1, width=612, height=792, lines=[
        line('a𠮷b', y0=100, y1=112),
        line('第二行', y0=120, y1=132),
    ])
    block = lines_to_blocks(page, set())[0]
    assert block.source_char_start == 0
    assert block.source_char_end == utf16_len('a𠮷b\n第二行')

def test_rect_normalization_clamps():
    assert normalize_rect(-10, 10, 700, 900, 612, 792) == {'x': 0.0, 'y': 0.012626, 'w': 1.0, 'h': 0.987374}
```

- [ ] **Step 2: Write the failing schema tests**

`validate_pack` must reject: pageCount mismatch, non-contiguous pages, duplicate block ids on a page, missing text on a paragraph, heading without level, rect outside `[0,1]`, unsupported block type, `schemaVersion != 1`, block count over limits. It must accept `packages/shared/src/__tests__/fixtures/golden.bookr.json`:

```python
def test_golden_pack_is_valid():
    path = Path(__file__).parents[3] / 'packages/shared/src/__tests__/fixtures/golden.bookr.json'
    pack = json.loads(path.read_text(encoding='utf-8'))
    assert validate_pack(pack) == []
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd tools/pdf-preprocess && python -m pytest -q`
Expected: FAIL — package missing.

- [ ] **Step 4: Implement the model and schema**

`pyproject.toml`: `[project] name = "bookr-preprocess"; version = "0.1.0"; requires-python = ">=3.10"; dependencies = ["pymupdf>=1.24"]`; `[project.optional-dependencies] ocr = ["paddleocr>=2.7", "numpy", "pillow"]; dev = ["pytest>=8"]`; `[project.scripts] bookr-preprocess = "bookr_preprocess.cli:main"`; setuptools package discovery for `bookr_preprocess*`.

`validate_pack` uses only stdlib. Mirror every TS rule, including the page/block/text limits. It does not check the 32 MiB file size (the server does). Return machine-readable strings such as `"pages.length must equal source.pageCount"`, `"duplicate block id p1-b0 on page 1"`, `"rect out of bounds"`. `to_dict` writes camelCase keys exactly as the TS schema expects (`source`, `schemaVersion`, `quality`, `fallbackPages`, `ocrPages`, `avgConfidence`, `sourceCharStart`, `sourceCharEnd`).

- [ ] **Step 5: Implement layout heuristics**

Order of operations inside `lines_to_blocks`:
1. Drop empty text; drop lines in the top/bottom 6% whose trimmed text is a page number (`^[-–—]?\s*\d+\s*[-–—]?$`) or whose normalized form (digits → `#`, collapse whitespace) is in `repeated_margins`.
2. Sort by `(round(y0, 1), x0)`.
3. Determine `body = body_font_size(lines)` (character-weighted median) and `median_h`.
4. Start a new block when: no current block; vertical gap > `1.6 * max(median_h, 0.8 * body)`; the line's size differs from the block's first line by more than 15%; or the line starts at least `1.5 * body` points right of the page's body left margin (indent) while the current block already has ≥1 line.
5. `text = merge_lines([...])`.
6. Classify: `table` when ≥3 lines each containing ≥3 runs separated by gaps ≥ `2 * body` points and at least half the cells contain digits; `formula` when text length < 120 and it contains at least two of `= ∫ ∑ √ ± × ÷ ≠ ≤ ≥ ^ _` and has no `。！？`; `heading` when size ≥ `1.2 * body` and (len(text) ≤ 80 or any line bold); otherwise `paragraph`. Heading level: size ≥ `1.6 * body` → 1, ≥ `1.35` → 2, else 3.
7. Rect = union of line boxes, normalized with `normalize_rect`.
8. `sourceCharStart/End` from the page's source string, built as all filtered lines joined by `\n`, offsets in UTF-16; only text blocks get them.
9. Sort blocks top-to-bottom and assign ids `p{page}-b{index}` in that order.

`body_font_size` and `median_line_height` use `statistics.median`, weighting font sizes by `utf16_len(line.text)` and ignoring empty lines. `merge_lines` joins CJK-to-CJK without a space, removes an ASCII hyphen at a line end when the next line starts lowercase, and otherwise inserts one space. `repeated_margin_texts` normalizes digits and counts presence in top/bottom 6% across pages, returning texts present on ≥`threshold` of pages.

- [ ] **Step 6: Implement quality**

`build_quality` returns exactly:

```python
{
  "pages": len(pages),
  "textBlocks": sum(1 for blocks in blocks_by_page.values() for b in blocks if b.type in ('heading', 'paragraph')),
  "fallbackPages": sorted(set(fallback_pages)),
  "ocrPages": sorted(set(ocr_pages)),
  "avgConfidence": round(mean(confidences), 3) if confidences else None,
  "warnings": warnings[:100],
}
```

- [ ] **Step 7: Run tests**

Run: `cd tools/pdf-preprocess && python -m pytest -q`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add tools/pdf-preprocess
git commit -m "feat(preprocess): add the reflow pack model and layout heuristics"
```

---

### Task 10: PyMuPDF extraction, build pipeline, text-layer PDF and CLI

**Files:**
- Create: `tools/pdf-preprocess/bookr_preprocess/extract_text.py`, `build.py`, `pdf_writer.py`, `cli.py`, `__main__.py`
- Test: `tools/pdf-preprocess/tests/test_build.py`, `test_pdf_writer.py`, `test_cli.py`

**Interfaces:**
- Produces protocol:

```python
class PdfExtractor(Protocol):
    def page_count(self) -> int: ...
    def page_size(self, page: int) -> tuple[float, float]: ...
    def extract_page(self, page: int) -> ExtractedPage: ...
    def render_page_png(self, page: int, dpi: int) -> bytes: ...
    def outline(self) -> list[dict]: ...   # [{label, page, level}]
    def close(self) -> None: ...

class PyMuPdfExtractor:
    def __init__(self, path: str): ...
```

- Produces:

```python
@dataclass
class BuildOptions:
    ocr: str = 'auto'            # auto | always | never
    ocr_lang: str = 'ch'
    dpi: int = 300
    ai_correct: bool = False
    title: str | None = None
    text_pdf: str | None = None
    max_pages: int | None = None

@dataclass
class BuildResult:
    pack: ReflowPack
    pack_dict: dict
    report: dict
    ocr_lines: dict[int, list[RawLine]]
    warnings: list[str]

def build_pack(
    *,
    source_path: str,
    extractor: PdfExtractor,
    options: BuildOptions,
    ocr_backend: OcrBackend | None = None,
    corrector: TextCorrector | None = None,
) -> BuildResult: ...

def write_text_layer_pdf(source_path: str, output_path: str, ocr_lines: dict[int, list[RawLine]]) -> int: ...
def main(argv: Sequence[str] | None = None) -> int: ...
```

- [ ] **Step 1: Write the failing build tests**

Use a temp source file with known bytes and a fake extractor:

```python
class FakeExtractor:
    def __init__(self, pages): self.pages = pages
    def page_count(self): return len(self.pages)
    def page_size(self, page): return (612.0, 792.0)
    def extract_page(self, page): return self.pages[page - 1]
    def render_page_png(self, page, dpi): return b'png'
    def outline(self): return []
    def close(self): pass

def test_builds_text_pages_with_fallback_and_toc(tmp_path):
    source = tmp_path / 'book.pdf'
    source.write_bytes(b'%PDF-1.4 fake')
    pages = [
        ExtractedPage(page=1, width=612, height=792, lines=[line('第一章', size=22, bold=True), line('正文。')]),
        ExtractedPage(page=2, width=612, height=792, lines=[]),
        ExtractedPage(page=3, width=612, height=792, lines=[line('第三页正文。')], image_rects=[(72, 200, 400, 500)]),
    ]
    result = build_pack(source_path=str(source), extractor=FakeExtractor(pages), options=BuildOptions(ocr='never'))
    pack = result.pack_dict
    assert pack['source']['sha256'] == hashlib.sha256(source.read_bytes()).hexdigest()
    assert pack['generatedAt'].endswith('Z')
    assert pack['source']['pageCount'] == 3
    assert [b['type'] for b in pack['pages'][0]['blocks']][:2] == ['heading', 'paragraph']
    assert pack['pages'][1]['blocks'][0]['type'] == 'fallback'
    assert any(b['type'] == 'image' for b in pack['pages'][2]['blocks'])
    assert pack['quality']['fallbackPages'] == [2]
    assert pack['toc'][0]['label'] == '第一章'
    assert validate_pack(pack) == []
```

Additional tests:
- OCR auto on a scanned page (empty lines + image) with a fake backend returning `OcrLine('扫描正文', 0.1, 0.2, 0.9, 0.25, 0.93)` → text block on page 1, `quality.ocrPages == [1]`, `avgConfidence == 0.93`, `ocr` flag true.
- `ocr='auto'` with no backend and a scanned page → fallback page + warning; `ocr='always'` with no backend still builds fallbacks (CLI decides whether to fail).
- A correcting fake corrector changes `正文` to `更正正文`; a raising corrector keeps the original text and appends a warning.
- A fake extractor raising on page 2 → fallback page and warning, pages 1/3 still built.
- `--max-pages 2` builds only two pages and sets `source.pageCount` to 2 (this is a test-only convenience; the CLI refuses it for real books with more pages? No — keep it as a debugging flag documented as such).

- [ ] **Step 2: Write the failing writer/CLI tests**

```python
def test_text_layer_pdf_round_trips(tmp_path):
    source = tmp_path / 'blank.pdf'
    doc = pymupdf.open()
    page = doc.new_page(width=612, height=792)
    doc.save(source)
    doc.close()
    lines = {1: [RawLine('OCR line', 72, 100, 300, 112, 11, confidence=0.9)]}
    count = write_text_layer_pdf(str(source), str(tmp_path / 'searchable.pdf'), lines)
    assert count == 1
    text = pymupdf.open(tmp_path / 'searchable.pdf')[0].get_text()
    assert 'OCR line' in text
```

CLI test with a real 2-page PyMuPDF-generated PDF:

```python
def test_cli_writes_pack_and_report(tmp_path):
    pdf = make_text_pdf(tmp_path / 'in.pdf', ['Page one text', 'Page two text'])
    out = tmp_path / 'book.bookr.json'
    report = tmp_path / 'book.report.json'
    assert main([str(pdf), '--out', str(out), '--report', str(report), '--ocr', 'never', '--force']) == 0
    pack = json.loads(out.read_text(encoding='utf-8'))
    assert pack['source']['pageCount'] == 2
    assert validate_pack(pack) == []
    assert report.exists()
    assert main([str(pdf), '--out', str(out), '--ocr', 'never']) == 2   # no overwrite without --force
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd tools/pdf-preprocess && python -m pytest -q`
Expected: FAIL — modules missing.

- [ ] **Step 4: Implement `extract_text.py`**

`PyMuPdfExtractor` imports `pymupdf` lazily; on ImportError raises `RuntimeError('PyMuPDF is required: pip install pymupdf')`. `extract_page` uses `page.get_text('dict')`; for every line, join spans with a single space when the horizontal gap between consecutive spans is at least `1.5 * min span size` (so table columns remain detectable), otherwise concatenate without a space; bbox from the line (or union of spans), `font_size = max(span['size'])`, `bold = any('Bold' in span['font'] or span['flags'] & 16 for span in spans)`. Set `text_chars = len(page.get_text('text').strip())`. `image_rects` uses `page.get_images(full=True)` then `page.get_image_rects(xref)`; keep unique rects with area ≥1% of the page. `outline()` uses `doc.get_toc(simple=True)` and maps `[level, title, page]` with `page >= 1`. `render_page_png` uses `page.get_pixmap(dpi=dpi, alpha=False).tobytes('png')`.

- [ ] **Step 5: Implement `build.py`**

Flow:
1. `sha256 = hashlib.sha256(Path(source_path).read_bytes()).hexdigest()`（chunked read）。
2. `page_count = extractor.page_count()`; apply `options.max_pages` only as `min`.
3. Extract every page inside try/except; a failed page becomes an empty `ExtractedPage` with a warning.
4. `usable = has_usable_text_layer(pages)`.
5. OCR selection:
   - `always`: every page.
   - `auto`: pages with `text_chars < 100` **and** at least one image rect (scanned page).
   - `never`: none.
   For each selected page: require `ocr_backend`; if absent, mark page fallback with warning `第 N 页需要 OCR，但没有可用的 OCR 后端`; otherwise `png = extractor.render_page_png(page, options.dpi)`, `lines = ocr_backend.recognize(png, options.ocr_lang)`, convert each normalized bbox to points, sort top-to-bottom, set `page.ocr = True`, `page.lines = converted`, and collect confidences.
6. Compute `repeated = repeated_margin_texts(pages)`; `blocks_by_page[page] = lines_to_blocks(page, repeated)`.
7. Add image blocks: for non-OCR pages, for each image rect, skip when an existing text block overlaps ≥50% of the image area; append `Block(type='image', rect=..., text=None)`; sort all blocks by `(rect.y, rect.x)` and **reassign ids** `p{page}-b{i}` (source offsets stay on text blocks).
8. Fallback: a page with no blocks at all gets one `fallback` block covering `{x:0,y:0,w:1,h:1}` and is recorded in `fallback_pages`.
9. Apply AI correction to each heading/paragraph text when `options.corrector` is present and `options.ai_correct`: on exception append `第 N 页第 M 块纠错失败（{error class}）` and keep the original. Do not update source offsets after correction; document that highlight mapping in corrected text is block-approximate.
10. TOC: extractor outline entries with `1 <= page <= page_count`; if empty, the first 50 heading blocks in reading order become `{label, page, level}`.
11. Build pack dict; `generated_at` = current UTC with milliseconds and `Z`; `title` only when provided. Validate with `validate_pack`; any error raises `PackValidationError(errors)`.
12. If `options.text_pdf` and OCR lines exist, call `write_text_layer_pdf`.
13. `report` = quality plus `{"source": source_path, "outputPages": len(pages), "textPdf": options.text_pdf}` (the CLI adds file paths). Never include book text in the report.

- [ ] **Step 6: Implement `pdf_writer.py`**

Open the source with `pymupdf`; for each page with OCR lines, choose `fontname = 'china-s'` when the line contains any non-ASCII character, else `'helv'`; `page.insert_text((x0, y1 - 0.2 * (y1 - y0)), line.text, fontsize=max(4, 0.75 * (y1 - y0)), fontname=fontname, render_mode=3, color=(0, 0, 0))`; save with `garbage=1, deflate=True`. Return the number of inserted lines. Wrap known font failures per line and continue, counting failures in the return value's second field? Keep the return an int of successful insertions and emit a warning via `print` only in the CLI (the writer stays pure).

- [ ] **Step 7: Implement the CLI**

`argparse` arguments: `input`, `--out` (required), `--report`, `--text-pdf`, `--title`, `--ocr {auto,always,never}` (default auto), `--ocr-lang` (default ch), `--dpi` (default 300), `--ai-correct`, `--max-pages` (help: 仅用于调试), `--force`, `--verbose`.

Behavior:
- Missing input → stderr Chinese message, return 2.
- Output exists and no `--force` → return 2.
- `--ai-correct` without `DEEPSEEK_API_KEY` → stderr `AI 纠错需要设置 DEEPSEEK_API_KEY`, return 2.
- OCR backend: lazy `PaddleOcrBackend(lang)`; ImportError → backend None; if `--ocr always` and backend None → stderr `OCR 需要安装可选依赖：pip install -e '.[ocr]'`, return 3; auto continues with fallback warnings.
- `PyMuPDF` missing → return 3.
- Build with `PyMuPdfExtractor`; catch `PackValidationError` → print errors, return 2.
- Write JSON with `ensure_ascii=False, indent=2`, newline at end; write report as `{"quality": ..., "source": ..., "generatedAt": ...}`.
- Print a Chinese summary: 页数、文本块数、OCR 页、回退页、输出路径、报告路径、文本层 PDF 路径（若有）。
- `--text-pdf` passes to `BuildOptions.text_pdf`.
- `__main__.py`: `raise SystemExit(main())`.

- [ ] **Step 8: Run tests**

Run: `cd tools/pdf-preprocess && python -m pytest -q`
Expected: PASS (the PyMuPDF tests run because PyMuPDF is installed; mark them `pytest.importorskip('pymupdf')` so other machines skip cleanly).

- [ ] **Step 9: Commit**

```bash
git add tools/pdf-preprocess
git commit -m "feat(preprocess): extract PDFs, build packs and write text layers"
```

---

### Task 11: OCR backend and optional DeepSeek correction

**Files:**
- Create: `tools/pdf-preprocess/bookr_preprocess/ocr.py`, `ai.py`
- Test: `tools/pdf-preprocess/tests/test_ocr.py`, `test_ai.py`

**Interfaces:**
- Produces:

```python
class PaddleOcrBackend:
    def __init__(self, lang: str = 'ch', engine: object | None = None,
                 decoder: Callable[[bytes], tuple[object, int, int]] | None = None): ...
    def recognize(self, png: bytes, lang: str) -> list[OcrLine]: ...

def parse_paddle_result(raw: object, width: int, height: int) -> list[OcrLine]: ...

class DeepSeekCorrector:
    def __init__(self, api_key: str, model: str = 'deepseek-chat',
                 endpoint: str = 'https://api.deepseek.com/chat/completions',
                 timeout: float = 30.0,
                 transport: Callable[[urllib.request.Request, float], bytes] | None = None): ...
    def correct(self, text: str) -> str: ...
```

- [ ] **Step 1: Write the failing OCR tests**

```python
def test_parses_paddle_v2_result_and_normalizes_boxes():
    raw = [[
        [[[10, 20], [110, 20], [110, 40], [10, 40]], ('第一行', 0.93)],
        [[[10, 50], [210, 50], [210, 70], [10, 70]], ('second line', 0.81)],
    ]]
    lines = parse_paddle_result(raw, width=200, height=100)
    assert lines[0].text == '第一行'
    assert lines[0].x0 == 0.05 and lines[0].y0 == 0.2
    assert lines[0].x1 == 0.55 and lines[0].y1 == 0.4
    assert lines[0].confidence == 0.93
    assert lines[1].text == 'second line'

def test_parses_newer_dict_result_and_skips_empty_text():
    raw = [{'rec_texts': ['A', '', 'B'], 'rec_scores': [0.9, 0.8, 0.7],
            'rec_polys': [[[0, 0], [50, 0], [50, 10], [0, 10]],
                          [[0, 10], [50, 10], [50, 20], [0, 20]],
                          [[0, 20], [50, 20], [50, 30], [0, 30]]]}]
    lines = parse_paddle_result(raw, width=100, height=100)
    assert [line.text for line in lines] == ['A', 'B']

def test_backend_uses_injected_engine_and_decoder():
    class Engine:
        def ocr(self, image, cls=True): return [[[[[0, 0], [10, 0], [10, 10], [0, 10]], ('ok', 0.9)]]]
    backend = PaddleOcrBackend(engine=Engine(), decoder=lambda png: (object(), 100, 100))
    assert backend.recognize(b'png', 'ch')[0].text == 'ok'
```

Add: boxes are clamped into `[0,1]`; blank lines skipped; confidence defaults to 0 when missing.

- [ ] **Step 2: Write the failing AI tests**

```python
def test_deepseek_request_shape_and_content():
    seen: dict = {}
    def transport(request, timeout):
        seen['url'] = request.full_url
        seen['timeout'] = timeout
        seen['body'] = json.loads(request.data.decode())
        return json.dumps({'choices': [{'message': {'content': ' 更正后的正文。 '}}]}).encode()
    corrector = DeepSeekCorrector('test-key', transport=transport)
    assert corrector.correct('原文') == '更正后的正文。'
    assert seen['url'] == 'https://api.deepseek.com/chat/completions'
    assert seen['body']['model'] == 'deepseek-chat'
    assert seen['body']['temperature'] == 0.2
    assert 'OCR' in seen['body']['messages'][0]['content']
    assert seen['body']['messages'][1]['content'] == '原文'

def test_long_text_is_returned_unchanged_and_transport_errors_propagate():
    corrector = DeepSeekCorrector('test-key', transport=lambda request, timeout: b'{}')
    assert corrector.correct('长' * 4001) == '长' * 4001
    failing = DeepSeekCorrector('test-key', transport=lambda request, timeout: (_ for _ in ()).throw(OSError('offline')))
    with pytest.raises(OSError):
        failing.correct('原文')
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd tools/pdf-preprocess && python -m pytest -q`
Expected: FAIL — modules missing.

- [ ] **Step 4: Implement `ocr.py`**

`parse_paddle_result` handles two shapes:
- `raw` is a list whose first element is a list of `[box, (text, score)]` entries (PaddleOCR 2.x).
- `raw` is a list of dicts with `rec_texts`, `rec_scores`, `rec_polys` or `dt_polys` (PaddleOCR 3.x).
Ignore anything else. Convert each 4-point box to `(min x, min y, max x, max y)` in pixels, divide by width/height, clamp to `[0,1]`, skip empty/whitespace text. Return lines sorted by `(y0, x0)`.

`PaddleOcrBackend.__init__` lazily imports `numpy` and `PIL.Image` and `paddleocr.PaddleOCR(use_angle_cls=True, lang=lang, show_log=False)`; on ImportError raise `RuntimeError("OCR dependencies missing: pip install -e '.[ocr]'")`. The default decoder returns `(np.asarray(Image.open(BytesIO(png)).convert('RGB')), width, height)`. `recognize` calls `self._engine.ocr(image, cls=True)` and parses with the decoded width/height.

- [ ] **Step 5: Implement `ai.py`**

System prompt (exact): `你是中文图书 OCR 校对助手。修正明显的 OCR 错字、被硬换行切断的句子和多余空格，保留原意、段落与标点。只输出校对后的正文，不要解释。` Use `temperature: 0.2`, `model: deepseek-chat`, `stream: False`. `urllib.request.Request` with `Content-Type: application/json`, `Authorization: Bearer <key>`. `default_transport` calls `urlopen(request, timeout=timeout).read()`. Parse `choices[0].message.content`; strip; if empty or longer than `max(400, 4 * len(text))` return the original. Text longer than 4000 UTF-16 units returns unchanged without a request. Errors propagate so the builder can warn and keep the original.

- [ ] **Step 6: Run tests**

Run: `cd tools/pdf-preprocess && python -m pytest -q`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add tools/pdf-preprocess
git commit -m "feat(preprocess): add optional OCR and DeepSeek correction backends"
```

---

### Task 12: Documentation, roadmap and repository hygiene

**Files:**
- Create: `tools/pdf-preprocess/README.md`
- Modify: `README.md`, `docs/superpowers/plans/2026-10-18-00-roadmap.md`, `.gitignore`

- [ ] **Step 1: Write the local tool README**

Cover, in Chinese:
- What it does and the hard boundary: runs only on the owner's machine, not deployed to the server; no network unless `--ai-correct`.
- Install: `cd tools/pdf-preprocess && python -m venv .venv && . .venv/bin/activate`（Windows: `.venv\Scripts\activate`）、`pip install -e '.[dev]'`、可选 `pip install -e '.[ocr]'`（PaddleOCR，GPU 版按其官方说明安装）。
- Commands for a text PDF, a scanned PDF, an OCR-and-AI run, and batch usage:
```bash
bookr-preprocess book.pdf --out book.bookr.json
bookr-preprocess scan.pdf --out scan.bookr.json --ocr auto --text-pdf scan-searchable.pdf
bookr-preprocess scan.pdf --out scan.bookr.json --ocr always --ai-correct --report scan.report.json
```
- Exit codes `0/2/3`.
- Pack contents and the meaning of `heading/paragraph/image/table/formula/fallback`; images are re-rendered from the source PDF, not embedded.
- Quality report fields; how to inspect `fallbackPages` and `warnings`; recommendation to eyeball fallback pages before uploading.
- Upload steps in the app: 书架 → 编辑（仅上传者/管理员）→ 重排包 → 选择 `.bookr.json`；服务端会校验 sha256 与 schema 版本。
- Limitations: heuristic layout (Docling/MinerU are not bundled), tables/formulas are preserved as source crops, AI correction changes text length so highlight mapping inside a corrected block is block-approximate, 4000-char cap per AI request.
- Privacy: the pack contains book text; store it with the book; AI correction sends only the current block's text to DeepSeek when explicitly enabled.

- [ ] **Step 2: Update the root README**

- Add reflow to section 13: PDF 原版/重排一键切换，重排字体/字号/行距/边距/主题；图片、表格、公式以原页裁绘保留；位置双向映射误差 ≤1 页。
- Add a new section after the reader section: 本地 PDF 预处理工具（安装、命令、上传重排包、质量报告），linking `tools/pdf-preprocess/README.md`.
- Add API endpoints to the API list/section: `POST /api/books/:id/reflow/uploads`, `POST /api/books/:id/reflow/uploads/:uploadId/complete`, `GET /api/books/:id/reflow`, `DELETE /api/books/:id/reflow`.
- Update 已知范围: reflow relies on a locally generated pack; no server-side OCR; tables/formulas are crops; reflow pack is text-only and must not exceed 32 MiB.
- Mention the E2E now covers mode switching and requires the regenerated `reader.bookr.json` fixture.

- [ ] **Step 3: Update the roadmap and gitignore**

`2026-10-18-00-roadmap.md`: mark plan 03 as `（已交付）` in the table's 03 row and add `- 2026-10-18-03-reflow-preprocess.md（已交付）` under 计划文件. Do not mark anything else delivered.
`.gitignore`: add the generated E2E pack and Python artifacts:
```
apps/web/e2e/fixtures/reader.bookr.json
__pycache__/
.pytest_cache/
tools/pdf-preprocess/.venv/
*.egg-info/
```

- [ ] **Step 4: Run the full verification**

Run from the repo root:
```bash
pnpm exec turbo run typecheck test --force
cd tools/pdf-preprocess && python -m pytest -q && cd ../..
git status --short
```
Expected: all TypeScript tasks pass; Python tests pass; the working tree only contains intended changes. E2E is run separately in Task 8 against a rebuilt stack.

- [ ] **Step 5: Commit**

```bash
git add README.md .gitignore docs/superpowers/plans/2026-10-18-00-roadmap.md tools/pdf-preprocess/README.md
git commit -m "docs: document reflow packs and the local preprocessing tool"
```

---

## Final verification checklist

Before the final whole-branch review:

- [ ] `pnpm exec turbo run typecheck test --force` is green.
- [ ] `cd tools/pdf-preprocess && python -m pytest -q` is green.
- [ ] `docker compose up -d --build` is healthy and `curl -fsS http://localhost:8180/healthz` returns ok.
- [ ] `pnpm --filter @bookr/web e2e` is green (after trashing any demo PDF that shares the fixture sha256).
- [ ] A real pack produced by `bookr-preprocess` from a locally generated PDF is uploaded through the edit dialog, opens in reflow, switches back within one page, and produces a reflow-located highlight.
- [ ] No `TODO` or placeholder implementation remains in `tools/pdf-preprocess` or `packages/reader-core/src/reflow`.
