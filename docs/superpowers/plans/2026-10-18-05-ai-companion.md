# AI 伴读（P5）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在阅读器里加入服务端 AI 网关：选中段落即可「解释」，对当前页/章「总结」，并在同一线程里多轮「追问」；回答以 SSE 流式返回，Key 加密存库、永不下发客户端，每个用户的每日/每月 token 配额与「禁用 AI」开关都被严格执行。

**Architecture:** 浏览器只做上下文采集与展示：从当前阅读引擎取出选中文字、当前页/章文字（有长度上限），POST 给服务端。服务端负责提示词模板、上下文裁剪到 8k token 预算、OpenAI 兼容网关（默认 DeepSeek）、配额预占/结算、线程与消息持久化，并以 SSE 逐字转发。AI 线程与消息是服务端权威数据，通过 REST 按书读取；它们不进入 P4 的 `sync_changes` 日志，因为离线时 AI 本就不可用，消息只可能由服务端产生。AI 配置（Base URL、模型、Key）存于 `ai_config`，Key 以 AES-256-GCM 加密，只有管理员能改，读取时永不回显。

**Tech Stack:** TypeScript strict、Fastify 5（`reply.hijack` + SSE）、PostgreSQL 16 + Drizzle、Node `fetch` + Web Streams、AES-256-GCM/HKDF（`node:crypto`）、React 19 + TanStack Query、Vitest、Playwright、Docker Compose。

**Spec:** `docs/superpowers/specs/2026-10-18-private-book-reader-design.md`（5.5 AI 伴读、6.4 服务端 AI 网关、12 安全与隐私、13 验收标准 4）

## Global Constraints

- TypeScript strict，禁止 `any`；共享契约先于使用方（`packages/shared` → `apps/server` / `apps/web`）。
- AI Key 只在服务端解密使用；任何 API 响应、日志、错误信息都不得包含 Key。日志不得记录书籍正文、选中文字、问题或回答内容。
- 只有选中片段与当前页/章的必要上下文会发给第三方 AI；客户端为每段上下文设定上限，服务端再按 8k token 预算裁剪。
- 服务端所有 AI 线程、消息、用量按 `user_id` 隔离；访问他人线程一律 404。
- AI 配额按用户时区计算日/月窗口；请求开始前预占、结束时按实际用量结算，并发请求不能绕过上限。
- 离线时 AI 不可用，界面必须明确提示；已输入的问题不得因网络/额度/上游失败而丢失。
- 上游 Base URL 默认 `https://api.deepseek.com/v1`；仅 `localhost`、`127.0.0.1`、`[::1]`、`host.docker.internal` 允许 HTTP，其余必须 HTTPS。
- 不新增对外暴露端口；服务端仍只能经 Caddy 访问。`AI_FAKE_PROVIDER=1` 只用于本地 E2E/演示，生产禁止设置。
- E2E 是破坏性测试：只允许 localhost；`E2E_ALLOW_REMOTE=1` 仅用于一次性测试环境，永不对生产运行。
- 每个任务结束必须 `pnpm exec turbo run typecheck test` 通过并提交。
- 新增依赖：无。加密、SSE 解析、流式读取全部使用 Node/浏览器内置能力。

## Review Focus

- **Key 与正文不泄漏**：`GET /api/admin/ai`、错误响应、pino 日志、线程列表都不得出现 API Key 或消息正文；测试要抓取日志与响应体断言不含 Key/正文。
- **配额并发**：同一用户同时开两个流，预占之和超过日/月上限时，后一个必须在调用上游前被拒绝；结算后 `used + reserved` 不出现负数或超限漂移。
- **客户端断开**：用户关掉页面/点停止后，上游请求必须被 abort，已收到的部分回答以 `interrupted` 落库，配额按已发生用量结算，服务端不留下悬挂连接。
- **上下文真实性**：解释请求必须携带当前页文字；服务端提示词里能读到书名、位置、选中段落；扫描版无文字层时明确说明材料不足，而不是凭空回答。
- **失败可恢复**：上游超时/额度耗尽/网络错误时，用户已输入的问题仍留在输入框或线程里，可重试；离线状态不发起请求。

---

## 文件结构

**共享**
- 创建 `packages/shared/src/ai.ts`、`packages/shared/src/__tests__/ai-schemas.test.ts`
- 修改 `packages/shared/src/index.ts`、`packages/shared/src/errors.ts`

**服务端**
- 创建 `apps/server/src/ai/{types,crypto,config,prompts,context,gateway,quota,repo,service,routes,admin}.ts`
- 创建 `apps/server/src/ai/fake.ts`（`AI_FAKE_PROVIDER` 的确定性实现）
- 创建 `apps/server/test/{ai-crypto,ai-config,ai-context,ai-gateway,ai-quota,ai-threads,ai-chat,ai-admin}.test.ts`
- 修改 `apps/server/src/db/schema.ts`、`drizzle/0005_ai.sql`、`drizzle/meta/*`
- 修改 `apps/server/src/{config,app,runtime,server,startup}.ts`、`admin/{routes,service}.ts`
- 修改 `apps/server/test/helpers.ts`（注入 `aiClient`、seed 配置/消息）

**阅读内核**
- 修改 `packages/reader-core/src/{types,pdf/engine,epub/engine,reflow/engine}.ts`
- 修改 `packages/reader-core/src/__tests__/{pdf-engine,reflow-engine,factory}.test.ts`
- 创建 `packages/reader-core/src/__tests__/text-context.test.ts`
- 修改 `apps/web/src/features/reader/__tests__/fake-engine.ts`

**Web**
- 创建 `apps/web/src/api/ai.ts`、`apps/web/src/api/__tests__/ai.test.ts`
- 创建 `apps/web/src/features/reader/ai/{AiPanel,AiMessageList,AiThreadList,AiComposer,useAiChat,stream}.tsx|ts`
- 创建 `apps/web/src/features/reader/ai/__tests__/*`
- 修改 `apps/web/src/features/reader/{ReaderPage,ReaderChrome,SelectionMenu,reader.css}.tsx|css`
- 修改 `apps/web/src/features/settings/SettingsPage.tsx`、`apps/web/src/features/settings/__tests__/settings.test.tsx`
- 修改 `apps/web/src/app/auth.tsx`（`refreshUser`）、`apps/web/src/api/client.ts`（`authorizedFetch`）、`apps/web/src/lib/errorMessages.ts`

**E2E / 文档**
- 创建 `apps/web/e2e/ai.spec.ts`
- 修改 `apps/web/e2e/global-setup.ts`（必要时）与 `README.md`、`.env.example`、`docker-compose.yml`
- 修改 `docs/superpowers/plans/2026-10-18-00-roadmap.md`

---

## 任务依赖与并发波次

实现按以下波次推进；同一波次内的任务文件互不重叠，可以并发执行，**不同波次必须等前一波全部通过审查**。

1. 波次 1：Task 1（共享契约）
2. 波次 2：Task 2（数据库与迁移）
3. 波次 3：Task 3（配置、加密、管理员端点）
4. 波次 4（并发）：Task 4（上下文/提示词）、Task 5（网关）、Task 6（配额）、Task 9（阅读内核上下文）、Task 10（Web API/SSE 解析）
5. 波次 5：Task 7（线程 REST）
6. 波次 6：Task 8（流式对话）
7. 波次 7（并发）：Task 11（AI 面板）、Task 13（设置页）
8. 波次 8：Task 12（阅读页集成）
9. 波次 9：Task 14（E2E）
10. 波次 10：Task 15（文档）

---
### Task 1: 共享 AI 契约

**Files:**
- Create: `packages/shared/src/ai.ts`
- Modify: `packages/shared/src/index.ts`、`packages/shared/src/errors.ts`
- Test: `packages/shared/src/__tests__/ai-schemas.test.ts`

**Interfaces:**
- Consumes: `locatorSchema`/`Locator`（`./locators`）、`ErrorCode`（`./errors`）
- Produces（后续任务逐字使用）:

```ts
export const AI_ACTIONS = ['explain', 'summarize', 'ask'] as const;
export type AiAction = (typeof AI_ACTIONS)[number];
export const AI_SUMMARY_SCOPES = ['page', 'chapter'] as const;
export type AiSummaryScope = (typeof AI_SUMMARY_SCOPES)[number];
export const AI_MESSAGE_ROLES = ['user', 'assistant'] as const;
export type AiMessageRole = (typeof AI_MESSAGE_ROLES)[number];
export const AI_MESSAGE_STATUSES = ['streaming', 'complete', 'interrupted', 'failed'] as const;
export type AiMessageStatus = (typeof AI_MESSAGE_STATUSES)[number];
export const AI_STREAM_EVENTS = ['meta', 'delta', 'done', 'error'] as const;

export const AI_CONTEXT_TOKEN_BUDGET = 8_000;
export const AI_PROMPT_HISTORY_MAX_TOKENS = 2_000;
export const AI_MAX_HISTORY_MESSAGES = 20;
export const AI_MAX_OUTPUT_TOKENS = 2_048;
export const AI_MAX_QUESTION_LENGTH = 4_000;
export const AI_MAX_SELECTED_TEXT_LENGTH = 8_000;
export const AI_MAX_PAGE_TEXT_LENGTH = 20_000;
export const AI_MAX_CHAPTER_TEXT_LENGTH = 60_000;
export const AI_THREAD_TITLE_MAX_LENGTH = 80;
export const AI_DEFAULT_DAILY_TOKEN_LIMIT = 100_000;
export const AI_DEFAULT_MONTHLY_TOKEN_LIMIT = 1_000_000;

export interface AiThreadDto {
  id: string;
  bookId: string;
  title: string;
  anchorLocator: Locator | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AiMessageDto {
  id: string;
  threadId: string;
  role: AiMessageRole;
  content: string;
  status: AiMessageStatus;
  action: AiAction | null;
  selectedText: string | null;
  model: string | null;
  promptTokens: number;
  completionTokens: number;
  createdAt: string;
}

export interface AiQuotaWindowDto {
  used: number;
  reserved: number;
  limit: number;
}

export interface AiUsageDto {
  enabled: boolean;
  configured: boolean;
  fakeProvider: boolean;
  model: string | null;
  daily: AiQuotaWindowDto;
  monthly: AiQuotaWindowDto;
}

export interface AiStreamMeta {
  threadId: string;
  userMessageId: string;
  assistantMessageId: string;
  action: AiAction;
  model: string;
  promptVersion: string;
}

export interface AiStreamDone {
  assistantMessageId: string;
  usage: { promptTokens: number; completionTokens: number };
  quota: { daily: AiQuotaWindowDto; monthly: AiQuotaWindowDto };
}

export interface AiStreamErrorPayload {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export const aiChatRequestSchema;   // 见下
export type AiChatRequest = z.infer<typeof aiChatRequestSchema>;
export const aiThreadListQuerySchema; // { bookId: z.uuid() }
```

- `ERROR_CODES` 增加：`AI_DISABLED: 'AI_DISABLED'`、`AI_NOT_CONFIGURED: 'AI_NOT_CONFIGURED'`、`AI_QUOTA_EXCEEDED: 'AI_QUOTA_EXCEEDED'`、`AI_UPSTREAM_FAILED: 'AI_UPSTREAM_FAILED'`、`AI_TIMEOUT: 'AI_TIMEOUT'`。
- `aiChatRequestSchema` 字段与规则：
  - `action: z.enum(AI_ACTIONS)`
  - `scope: z.enum(AI_SUMMARY_SCOPES).optional()`
  - `threadId: z.uuid().optional()`
  - `question: z.string().trim().min(1).max(AI_MAX_QUESTION_LENGTH).optional()`
  - `selectedText: z.string().trim().min(1).max(AI_MAX_SELECTED_TEXT_LENGTH).optional()`
  - `locator: locatorSchema.optional()`
  - `context: z.object({ pageText: z.string().max(AI_MAX_PAGE_TEXT_LENGTH).optional(), chapterText: z.string().max(AI_MAX_CHAPTER_TEXT_LENGTH).optional() }).optional()`
  - `superRefine`：`explain` 必须有 `selectedText`；`ask` 必须有 `question`；`summarize` 必须有 `scope`，且 `page` 要 `context.pageText`、`chapter` 要 `context.chapterText`；错误 path 指向缺失字段。
- 所有 schema 都用 `z.*` 原生 API，不用 `z.record` 的宽松兜底。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest';
import {
  AI_MAX_QUESTION_LENGTH,
  aiChatRequestSchema,
} from '../ai';

const locator = { kind: 'pdf', page: 12, percent: 0.4 };

describe('AI contract', () => {
  it('accepts an explain request with page context', () => {
    const parsed = aiChatRequestSchema.safeParse({
      action: 'explain',
      selectedText: '晦涩的段落',
      locator,
      context: { pageText: '本页正文' },
    });
    expect(parsed.success).toBe(true);
  });

  it('requires selectedText for explain', () => {
    expect(aiChatRequestSchema.safeParse({ action: 'explain' }).success).toBe(false);
  });

  it('requires a question for ask and caps its length', () => {
    expect(aiChatRequestSchema.safeParse({ action: 'ask' }).success).toBe(false);
    expect(
      aiChatRequestSchema.safeParse({
        action: 'ask',
        question: 'x'.repeat(AI_MAX_QUESTION_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(aiChatRequestSchema.safeParse({ action: 'ask', question: '为什么？' }).success).toBe(true);
  });

  it('requires the matching context for each summarize scope', () => {
    expect(aiChatRequestSchema.safeParse({ action: 'summarize', scope: 'page' }).success).toBe(false);
    expect(
      aiChatRequestSchema.safeParse({
        action: 'summarize', scope: 'page', context: { chapterText: '章' },
      }).success,
    ).toBe(false);
    expect(
      aiChatRequestSchema.safeParse({
        action: 'summarize', scope: 'chapter', context: { chapterText: '章' },
      }).success,
    ).toBe(true);
  });

  it('rejects unknown actions and oversized context', () => {
    expect(aiChatRequestSchema.safeParse({ action: 'rewrite' }).success).toBe(false);
    expect(
      aiChatRequestSchema.safeParse({
        action: 'summarize',
        scope: 'chapter',
        context: { chapterText: 'x'.repeat(60_001) },
      }).success,
    ).toBe(false);
  });

  it('accepts a follow-up thread id', () => {
    expect(
      aiChatRequestSchema.safeParse({
        action: 'ask',
        question: '再展开一点',
        threadId: '01a14f19-c2e6-73c7-a934-733f788451cf',
      }).success,
    ).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @bookr/shared test`
Expected: FAIL（`../ai` 不存在）

- [ ] **Step 3: 实现 `packages/shared/src/ai.ts` 并导出**

在 `errors.ts` 的 `ERROR_CODES` 末尾加入五个 AI 错误码；`index.ts` 增加 `export * from './ai';`。DTO 的 id/time 都是字符串，服务端负责 `toISOString()`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @bookr/shared test`
Expected: PASS（原有测试也全绿）

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src/ai.ts packages/shared/src/index.ts packages/shared/src/errors.ts packages/shared/src/__tests__/ai-schemas.test.ts
git commit -m "feat(shared): define the AI companion contract"
```

---
### Task 2: 服务端数据模型与迁移

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Create: `apps/server/drizzle/0005_ai.sql`（用 `pnpm --filter @bookr/server db:generate` 生成后核对 SQL）
- Test: `apps/server/test/ai-schema.test.ts`

**Interfaces:**
- Consumes: `AiAction`、`AiMessageRole`、`AiMessageStatus`、`AiAction`、`AI_DEFAULT_DAILY_TOKEN_LIMIT`、`AI_DEFAULT_MONTHLY_TOKEN_LIMIT`（Task 1）
- Produces:

```ts
// db/schema.ts 追加
export type AiUsagePeriod = 'day' | 'month';
export type AiMessageStatusRow = AiMessageStatus;

export const users = pgTable('users', {
  // ...既有列不变，追加；aiEnabled 默认值由 false 改为 true（只影响新账号，
  // 不回溯改写存量账号）：
  aiEnabled: boolean('ai_enabled').notNull().default(true),
  aiDailyTokenLimit: bigint('ai_daily_token_limit', { mode: 'number' })
    .notNull().default(AI_DEFAULT_DAILY_TOKEN_LIMIT),
  aiMonthlyTokenLimit: bigint('ai_monthly_token_limit', { mode: 'number' })
    .notNull().default(AI_DEFAULT_MONTHLY_TOKEN_LIMIT),
});

export const aiConfig = pgTable('ai_config', {
  id: text('id').primaryKey().default('default'),
  baseUrl: text('base_url').notNull(),
  chatModel: text('chat_model').notNull(),
  reasonerModel: text('reasoner_model').notNull(),
  apiKeyCiphertext: text('api_key_ciphertext').notNull(),
  apiKeyIv: text('api_key_iv').notNull(),
  apiKeyTag: text('api_key_tag').notNull(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const aiThreads = pgTable('ai_threads', {
  id: uuid('id').primaryKey().$defaultFn(newId),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  bookId: uuid('book_id').notNull().references(() => books.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  anchorLocator: jsonb('anchor_locator').$type<Locator>(),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('ai_threads_user_book_updated_idx').on(table.userId, table.bookId, table.updatedAt),
]);

export const aiMessages = pgTable('ai_messages', {
  id: uuid('id').primaryKey().$defaultFn(newId),
  threadId: uuid('thread_id').notNull().references(() => aiThreads.id, { onDelete: 'cascade' }),
  role: text('role').$type<AiMessageRole>().notNull(),
  content: text('content').notNull().default(''),
  status: text('status').$type<AiMessageStatus>().notNull().default('complete'),
  action: text('action').$type<AiAction>(),
  selectedText: text('selected_text'),
  model: text('model'),
  promptVersion: text('prompt_version'),
  promptTokens: integer('prompt_tokens').notNull().default(0),
  completionTokens: integer('completion_tokens').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('ai_messages_thread_created_idx').on(table.threadId, table.createdAt)]);

export const aiUsage = pgTable('ai_usage', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  period: text('period').$type<AiUsagePeriod>().notNull(),
  periodStart: text('period_start').notNull(), // 用户时区下的 YYYY-MM-DD / YYYY-MM
  promptTokens: bigint('prompt_tokens', { mode: 'number' }).notNull().default(0),
  completionTokens: bigint('completion_tokens', { mode: 'number' }).notNull().default(0),
  reservedTokens: bigint('reserved_tokens', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.userId, table.period, table.periodStart] })]);

export type AiThreadRow = typeof aiThreads.$inferSelect;
export type AiMessageRow = typeof aiMessages.$inferSelect;
export type AiConfigRow = typeof aiConfig.$inferSelect;
export type AiUsageRow = typeof aiUsage.$inferSelect;
```

- 迁移 SQL 必须包含：`users` 两列及默认值 `100000`/`1000000`；`ALTER TABLE "users" ALTER COLUMN "ai_enabled" SET DEFAULT true`（只改默认值，不 UPDATE 存量行）；四张新表；`ai_messages(thread_id) ON DELETE CASCADE`；`ai_threads(user_id)`、`ai_threads(book_id)` 级联删除。Drizzle 生成的 `0005_ai.sql` 与 `drizzle/meta/0005_snapshot.json`、`_journal.json` 一并提交。

- [ ] **Step 1: 写失败测试**

```ts
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { aiMessages, aiThreads, users } from '../src/db/schema';
import { resetDb, seedBook, seedUser, testDb } from './helpers';

it('stores AI threads and cascades messages with the thread', async () => {
  await resetDb();
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id, format: 'pdf' });

  const [thread] = await testDb.insert(aiThreads).values({
    userId: user.id,
    bookId: book.id,
    title: '解释一段话',
    anchorLocator: { kind: 'pdf', page: 2, percent: 0.2 },
  }).returning();
  await testDb.insert(aiMessages).values({
    threadId: thread!.id,
    role: 'user',
    content: '为什么要这样写？',
    status: 'complete',
  });

  await testDb.delete(aiThreads).where(eq(aiThreads.id, thread!.id));
  expect(await testDb.select().from(aiMessages)).toHaveLength(0);
});

it('gives new accounts the default AI quotas', async () => {
  await resetDb();
  const user = await seedUser('member');
  const [row] = await testDb.select({
    daily: users.aiDailyTokenLimit,
    monthly: users.aiMonthlyTokenLimit,
  }).from(users).where(eq(users.id, user.id));
  expect(row).toEqual({ daily: 100_000, monthly: 1_000_000 });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @bookr/server test -- ai-schema`
Expected: FAIL（`aiThreads` 未导出）

- [ ] **Step 3: 修改 schema 并生成迁移**

Run: `pnpm --filter @bookr/server db:generate`
打开生成的 SQL 逐条核对上表；若 Drizzle 未给 `users` 新列写默认值，手工补齐 `DEFAULT 100000` / `DEFAULT 1000000` 后再运行测试。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @bookr/server test -- ai-schema`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/db/schema.ts apps/server/drizzle apps/server/test/ai-schema.test.ts
git commit -m "feat(server): add AI threads, messages, usage and config tables"
```

---
### Task 3: 配置、密钥加密与管理员端点

**Files:**
- Modify: `apps/server/src/config.ts`、`apps/server/src/app.ts`、`apps/server/src/server.ts`、`apps/server/src/runtime.ts`
- Create: `apps/server/src/ai/{types,crypto,config,admin}.ts`
- Modify: `apps/server/test/helpers.ts`（`buildTestConfig` 合并 `ai`、`AppDeps.aiClient` 默认假实现）
- Modify: `.env.example`、`docker-compose.yml`
- Test: `apps/server/test/{ai-crypto,ai-admin}.test.ts`、`apps/server/test/config.test.ts`（追加 AI 配置用例）

**Interfaces:**
- Consumes: `AiAction` 等（Task 1）、`aiConfig` 表（Task 2）、`auditLogs`
- Produces:

```ts
// config.ts
export interface AppConfig {
  // ...既有字段不变
  ai: {
    fakeProvider: boolean;
    configSecret?: string;
    contextTokenBudget: number;
    requestTimeoutMs: number;
    bootstrap: {
      apiKey: string;
      baseUrl: string;
      chatModel: string;
      reasonerModel: string;
    } | null;
  };
}
export const DEFAULT_AI_BASE_URL = 'https://api.deepseek.com/v1';
export const DEFAULT_AI_CHAT_MODEL = 'deepseek-chat';
export const DEFAULT_AI_REASONER_MODEL = 'deepseek-reasoner';

// ai/crypto.ts
export interface EncryptedSecret { ciphertext: string; iv: string; tag: string }
export function deriveConfigKey(secret: string): Buffer;
export function configKeyFor(config: Pick<AppConfig, 'jwtSecret' | 'ai'>): Buffer;
export function encryptSecret(plaintext: string, key: Buffer): EncryptedSecret;
export function decryptSecret(secret: EncryptedSecret, key: Buffer): string;

// ai/config.ts
export interface AiRuntimeConfig {
  baseUrl: string;
  chatModel: string;
  reasonerModel: string;
  apiKey: string;
  fakeProvider: boolean;
}
export interface AiConfigView {
  configured: boolean;
  fakeProvider: boolean;
  baseUrl: string | null;
  chatModel: string | null;
  reasonerModel: string | null;
  hasApiKey: boolean;
  updatedAt: string | null;
}
export function normalizeAiBaseUrl(raw: string): string;
export function normalizeModelName(raw: string): string;
export async function readAiConfig(deps: Pick<AppDeps, 'db' | 'config'>): Promise<AiRuntimeConfig | null>;
export async function readAiConfigView(deps: Pick<AppDeps, 'db' | 'config'>): Promise<AiConfigView>;
export async function writeAiConfig(
  deps: Pick<AppDeps, 'db' | 'config' | 'clock'>,
  actorId: string | null,
  input: { baseUrl?: string; chatModel?: string; reasonerModel?: string; apiKey?: string },
): Promise<AiConfigView>;
export async function deleteAiConfig(deps: Pick<AppDeps, 'db'>): Promise<void>;
export async function bootstrapAiConfig(deps: Pick<AppDeps, 'db' | 'config' | 'clock'>): Promise<'created' | 'skipped'>;

// ai/admin.ts
export function registerAiAdminRoutes(app: FastifyInstance, deps: AppDeps): void;
```

- `ai/types.ts` 同时定义（后续任务共用）:

```ts
export interface AiChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface AiTokenUsage { promptTokens: number; completionTokens: number }
export interface AiStreamRequest {
  model: string;
  messages: AiChatMessage[];
  maxTokens: number;
  temperature: number;
  signal: AbortSignal;
}
export type AiStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'usage'; usage: AiTokenUsage };
export interface AiClient {
  readonly name: string;
  streamChat(request: AiStreamRequest): AsyncIterable<AiStreamEvent>;
}
export class AiUpstreamError extends Error {
  readonly statusCode?: number;
  readonly retryable: boolean;
  constructor(message: string, options?: { statusCode?: number; retryable?: boolean });
}
export function createUnavailableAiClient(): AiClient;
```

- 环境变量（`configSchema` 追加）：
  - `AI_CONFIG_SECRET`：可选，`z.string().min(32)`；缺省时 `configKeyFor` 从 `JWT_SECRET` 经 HKDF-SHA256 派生（salt `bookr-ai-config-salt`，info `bookr-ai-config-v1`）。在 `.env.example` 注明「轮换 JWT_SECRET 后需重新录入 AI Key」。
  - `AI_FAKE_PROVIDER`：可选布尔，接受 `1/true/0/false`，默认 `false`；为真时 `readAiConfig` 返回内置假配置（`fakeProvider: true`），不需要数据库行。
  - `AI_API_KEY` / `AI_BASE_URL` / `AI_CHAT_MODEL` / `AI_REASONER_MODEL`：可选，只在数据库尚无 `ai_config` 行时用于首次引导（`bootstrapAiConfig`）。`AI_API_KEY` 未设置时 `bootstrap` 为 `null`。
  - `AI_CONTEXT_TOKEN_BUDGET`：默认 `8000`，范围 1000–32000。
  - `AI_REQUEST_TIMEOUT_MS`：默认 `60000`，范围 5000–120000。
- `normalizeAiBaseUrl`：`new URL`；协议必须 `https:`，或 `http:` 且 hostname ∈ `localhost`/`127.0.0.1`/`[::1]`/`::1`/`host.docker.internal`；禁止用户名/密码/query/hash；去掉末尾 `/`；不合法抛 `Error('Invalid AI base URL')`。
- `normalizeModelName`：trim，长度 1–64，不得包含空白或控制字符。
- `writeAiConfig`：读现有行合并；首次写入必须提供 `apiKey`（否则抛 `AppError(400, VALIDATION_FAILED, { field: 'apiKey' })`）；`apiKey` 只在本次加密，绝不写日志；写 `audit_logs`（action `ai.config.update`，metadata 只含 baseUrl/model/keyChanged）。
- `readAiConfig`：数据库行存在时用 `configKeyFor(deps.config)` 解密；解密失败返回 `null` 并由上层按「未配置」处理（不抛带密文细节的错误）。
- `bootstrapAiConfig`：仅当 `bootstrap !== null` 且表为空时写入，`actorId = null`；写入后再写 audit `ai.config.bootstrap`（metadata 不含 key）。
- Admin 路由：
  - `GET /api/admin/ai` → `AiConfigView`
  - `PUT /api/admin/ai` body `{ baseUrl?: string, chatModel?: string, reasonerModel?: string, apiKey?: string(8..256) }`，至少一个字段；返回 `AiConfigView`
  - `DELETE /api/admin/ai` → 204，写 audit `ai.config.delete`
  - 全部 `[requireAuth, requireAdmin]`。
- `server.ts` 在迁移成功后 `await bootstrapAiConfig(deps)`，失败只记日志不阻止启动；`AI_FAKE_PROVIDER=1` 时启动日志 `warn` 一次「AI fake provider enabled — never use in production」。
- 日志脱敏：`LOG_REDACT_PATHS` 增加 `req.body.apiKey`、`apiKey`、`*.apiKey`、`*.*.apiKey`。
- `.env.example` 增加上述变量与安全说明；`docker-compose.yml` 的 server 环境透传 `AI_CONFIG_SECRET`、`AI_FAKE_PROVIDER`、`AI_API_KEY`、`AI_BASE_URL`、`AI_CHAT_MODEL`、`AI_REASONER_MODEL`、`AI_CONTEXT_TOKEN_BUDGET`、`AI_REQUEST_TIMEOUT_MS`，默认值保持关闭。
- `buildTestConfig` 深合并 `ai`：签名改为 `export type TestConfigOverrides = Partial<Omit<AppConfig, 's3' | 'ai'>> & { s3?: Partial<AppConfig['s3']>; ai?: Partial<AppConfig['ai']> };`，测试默认 `{ fakeProvider: false, configSecret: 'test-ai-config-secret-at-least-32-chars', contextTokenBudget: 8000, requestTimeoutMs: 60000, bootstrap: null }`。

- [ ] **Step 1: 写失败测试（加密与管理员）**

```ts
import { describe, expect, it } from 'vitest';
import { deriveConfigKey, encryptSecret, decryptSecret } from '../src/ai/crypto';
import { authHeader, createTestApp, resetDb, seedUser } from './helpers';

it('round-trips an encrypted secret and rejects tampering', () => {
  const key = deriveConfigKey('a-config-secret-that-is-long-enough-123');
  const secret = encryptSecret('sk-test-123456', key);
  expect(secret.ciphertext).not.toContain('sk-test');
  expect(decryptSecret(secret, key)).toBe('sk-test-123456');
  expect(() => decryptSecret({ ...secret, tag: Buffer.alloc(16).toString('base64') }, key))
    .toThrow('Could not decrypt the AI key');
});

it('derives a different key from a different secret', () => {
  const a = deriveConfigKey('a'.repeat(32));
  const b = deriveConfigKey('b'.repeat(32));
  expect(a.equals(b)).toBe(false);
  expect(a).toHaveLength(32);
});

it('never returns the API key from the admin API and audits changes', async () => {
  await resetDb();
  const { app } = await createTestApp();
  const admin = await seedUser('admin');
  const headers = await authHeader(admin);
  const secret = 'sk-live-secret-value-123';

  const saved = await app.inject({
    method: 'PUT', url: '/api/admin/ai', headers,
    payload: { apiKey: secret, chatModel: 'deepseek-chat' },
  });
  expect(saved.statusCode).toBe(200);
  expect(saved.body).not.toContain(secret);

  const view = await app.inject({ method: 'GET', url: '/api/admin/ai', headers });
  expect(view.json()).toMatchObject({ configured: true, hasApiKey: true, chatModel: 'deepseek-chat' });
  expect(view.body).not.toContain(secret);

  const cleared = await app.inject({ method: 'DELETE', url: '/api/admin/ai', headers });
  expect(cleared.statusCode).toBe(204);
  const after = await app.inject({ method: 'GET', url: '/api/admin/ai', headers });
  expect(after.json()).toMatchObject({ configured: false });
});

it('rejects non-admin config access and unsafe base URLs', async () => {
  await resetDb();
  const { app } = await createTestApp();
  const member = await seedUser('member');
  expect((await app.inject({ method: 'GET', url: '/api/admin/ai', headers: await authHeader(member) })).statusCode)
    .toBe(403);

  const admin = await seedUser('admin');
  const response = await app.inject({
    method: 'PUT',
    url: '/api/admin/ai',
    headers: await authHeader(admin),
    payload: { apiKey: 'sk-12345678', baseUrl: 'http://evil.example.com/v1' },
  });
  expect(response.statusCode).toBe(400);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @bookr/server test -- ai-crypto ai-admin`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现加密、配置服务与管理员路由，并接入启动**

同时把 `AppDeps` 加 `aiClientFactory: (config: AiRuntimeConfig) => AiClient`（本任务先用 `createUnavailableAiClientFactory()`，它返回的客户端 `streamChat` 抛 `AiUpstreamError('AI client is not configured', { retryable: false })`；Task 5 实现真实/假客户端，Task 8 替换为运行时工厂）。`runtime.ts` 与 `buildTestDeps` 都提供该字段，避免后续任务反复改签名。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @bookr/server test -- ai-crypto ai-admin config`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/config.ts apps/server/src/app.ts apps/server/src/server.ts apps/server/src/runtime.ts apps/server/src/ai apps/server/test/helpers.ts apps/server/test/ai-crypto.test.ts apps/server/test/ai-admin.test.ts apps/server/test/config.test.ts .env.example docker-compose.yml
git commit -m "feat(server): encrypt AI provider settings behind admin routes"
```

---
### Task 4: 上下文组装与提示词模板

**Files:**
- Create: `apps/server/src/ai/prompts.ts`、`apps/server/src/ai/context.ts`
- Test: `apps/server/test/ai-context.test.ts`

**Interfaces:**
- Consumes: `AiChatMessage`（`ai/types.ts`）、`AI_*` 常量与 `AiAction`/`AiSummaryScope`/`Locator`（`@bookr/shared`）
- Produces:

```ts
// ai/prompts.ts
export const PROMPT_VERSION = 'p5.1';
export interface PromptBook { title: string; author: string | null }
export function systemPromptFor(action: AiAction, scope?: AiSummaryScope): string;
export function describeLocator(locator: Locator | undefined): string;

// ai/context.ts
export function estimateTokens(text: string): number;
export function estimateMessagesTokens(messages: AiChatMessage[]): number;
export function trimToTokenBudget(text: string, budget: number): { text: string; truncated: boolean };
export function trimAroundSelection(
  text: string,
  selection: string,
  maxChars: number,
): { text: string; truncated: boolean };
export interface AssemblePromptInput {
  action: AiAction;
  scope?: AiSummaryScope;
  book: PromptBook;
  locator?: Locator;
  selectedText?: string;
  question?: string;
  pageText?: string;
  chapterText?: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  contextTokenBudget?: number;
  historyTokenBudget?: number;
}
export interface AssembledPrompt {
  messages: AiChatMessage[];
  promptTokens: number;
  contextChars: number;
  truncated: boolean;
}
export function assemblePrompt(input: AssemblePromptInput): AssembledPrompt;
```

- `estimateTokens`：逐码点计数——`codePointAt(0) >= 0x2e80` 记 1 token；其余非空白字符记 0.25；空白记 0.1；最后 `Math.ceil`。空串返回 0。
- `trimToTokenBudget`：未超预算原样返回。超了用二分查找最长前缀使估算 ≤ budget，返回前缀 + `\n…（已截断）`（截断标记不计入预算）。budget ≤ 0 返回 `{ text: '', truncated: text.length > 0 }`。
- `trimAroundSelection`：文本不超 `maxChars` 原样返回；超了先找 `selection.slice(0, 64)` 的首个位置，找到则以它为中心取 `maxChars` 窗口，找不到取开头；只在末尾补一个 `…`（因此结果长度最多 `maxChars + 1`）。
- `describeLocator`：`pdf` → `第 ${page} 页`；`reflow` → `源页 ${sourcePage}`；`epub` → `进度 ${Math.round(percent*100)}%`；若 `percent` 存在再追加 `（全书 ${Math.round(percent*100)}%）`；无 locator → `未提供位置`。
- 提示词（中文、版本化）：
  - 系统消息统一以 `你是「纸墨书房」的阅读伴读。` 开头，声明「只依据本次提供的书名、位置、选中段落与本页/本章文字回答；材料不足时直接说明缺少什么，不得编造原文未出现的事实；引用原文用「」；不确定的一般知识必须标注『以下为一般知识』」。
  - `explain` 追加：「用通俗语言解释选中段落，先给一句话结论，再分点说明关键词与逻辑，控制在 400 字内」。
  - `summarize/page`：「总结当前页的主要信息，用 3–6 条要点，不引入本页没有的内容」；`summarize/chapter` 同理但针对本章。
  - `ask`：「回答用户的问题；优先引用上下文，必要时说明上下文不足」。
- `assemblePrompt` 的消息顺序：`system` → 历史（从新到旧取到 `AI_PROMPT_HISTORY_MAX_TOKENS`、最多 `AI_MAX_HISTORY_MESSAGES` 条，再按原顺序发送）→ 一条 `user` 消息。最后这条按以下模板拼装（空段落整段省略）：

```text
【书名】《...》
【作者】...
【位置】第 12 页（全书 40%）
【本页文字】
...
【本章文字】
...
【选中段落】
...
【问题】
...
```

- 上下文选择：
  - `explain`：优先 `pageText`；为空时退回 `chapterText`，并在文字前加 `（本页没有可用文字，以下为本章片段）`。
  - `summarize/page`：只用 `pageText`。
  - `summarize/chapter`：只用 `chapterText`。
  - `ask`：优先 `pageText`，为空退回 `chapterText`；`selectedText` 与 `question` 都要包含。
- 裁剪：所选上下文先 `trimAroundSelection(..., selectedText ?? '', 20000)`，再 `trimToTokenBudget(..., contextTokenBudget ?? AI_CONTEXT_TOKEN_BUDGET)`；`truncated` 为任一截断的或。历史消息内容也各自 `trimToTokenBudget` 到剩余历史预算。
- `promptTokens = estimateMessagesTokens(messages)`；`contextChars` 是实际放进消息的上下文与选中文字字符数之和。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest';
import { AI_CONTEXT_TOKEN_BUDGET, AI_MAX_HISTORY_MESSAGES } from '@bookr/shared';
import {
  assemblePrompt,
  estimateTokens,
  trimAroundSelection,
  trimToTokenBudget,
} from '../src/ai/context';
import { PROMPT_VERSION, describeLocator, systemPromptFor } from '../src/ai/prompts';

const book = { title: '深入理解计算机系统', author: 'Bryant' };
const locator = { kind: 'pdf' as const, page: 12, percent: 0.4 };

it('estimates CJK and ASCII tokens deterministically', () => {
  expect(estimateTokens('')).toBe(0);
  expect(estimateTokens('你好世界')).toBe(4);
  expect(estimateTokens('hello')).toBe(2);
  expect(estimateTokens('你好 world')).toBe(4);
});

it('trims context to the token budget with a marker', () => {
  const trimmed = trimToTokenBudget('字'.repeat(1000), 100);
  expect(trimmed.truncated).toBe(true);
  expect(trimmed.text.startsWith('字'.repeat(100))).toBe(true);
  expect(trimmed.text).toContain('已截断');
});

it('keeps a window around the selection', () => {
  const text = `${'前'.repeat(100)}选中文字${'后'.repeat(100)}`;
  const trimmed = trimAroundSelection(text, '选中文字', 60);
  expect(trimmed.truncated).toBe(true);
  expect(trimmed.text).toContain('选中文字');
  expect(trimmed.text.length).toBeLessThanOrEqual(61);
});

it('includes book, location, page and selection in the explain prompt', () => {
  const result = assemblePrompt({
    action: 'explain', book, locator,
    selectedText: '程序如何运行',
    pageText: '本页正文第一段。',
    history: [],
  });
  const last = result.messages.at(-1)!.content;
  expect(last).toContain('深入理解计算机系统');
  expect(last).toContain('第 12 页');
  expect(last).toContain('本页正文第一段');
  expect(last).toContain('程序如何运行');
  expect(result.messages[0]!.role).toBe('system');
  expect(result.promptTokens).toBeGreaterThan(0);
  expect(systemPromptFor('explain')).toContain('不得编造');
});

it('falls back to chapter text when the page has no text layer', () => {
  const result = assemblePrompt({
    action: 'explain', book,
    selectedText: '扫描页上的文字',
    pageText: '', chapterText: '本章正文。',
    history: [],
  });
  expect(result.messages.at(-1)!.content).toContain('本页没有可用文字');
  expect(result.messages.at(-1)!.content).toContain('本章正文');
});

it('uses only the requested scope for summaries', () => {
  const page = assemblePrompt({
    action: 'summarize', scope: 'page', book,
    pageText: '本页内容', chapterText: '本章内容', history: [],
  });
  expect(page.messages.at(-1)!.content).toContain('本页内容');
  expect(page.messages.at(-1)!.content).not.toContain('本章内容');

  const chapter = assemblePrompt({
    action: 'summarize', scope: 'chapter', book,
    pageText: '本页内容', chapterText: '本章内容', history: [],
  });
  expect(chapter.messages.at(-1)!.content).toContain('本章内容');
});

it('caps history by count and tokens and keeps chronological order', () => {
  const history = Array.from({ length: AI_MAX_HISTORY_MESSAGES + 5 }, (_, index) => ({
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `第${index}条 ${'长'.repeat(3000)}`,
  }));
  const result = assemblePrompt({
    action: 'ask', book, question: '现在呢？', pageText: '本页', history,
  });
  const contents = result.messages.map((message) => message.content);
  expect(contents.some((content) => content.includes(`第${history.length - 1}条`))).toBe(true);
  expect(contents.some((content) => content.includes('第0条'))).toBe(false);
  expect(result.promptTokens).toBeLessThan(AI_CONTEXT_TOKEN_BUDGET + 3_000);
});

it('renders a stable prompt version and locator labels', () => {
  expect(PROMPT_VERSION).toBe('p5.1');
  expect(describeLocator(locator)).toBe('第 12 页（全书 40%）');
  expect(describeLocator(undefined)).toBe('未提供位置');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @bookr/server test -- ai-context`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `prompts.ts` 与 `context.ts`**

不要在日志里打印 `assemblePrompt` 的输入或输出。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @bookr/server test -- ai-context`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/ai/prompts.ts apps/server/src/ai/context.ts apps/server/test/ai-context.test.ts
git commit -m "feat(server): assemble AI context within a token budget"
```

---
### Task 5: OpenAI 兼容网关与确定性假提供方

**Files:**
- Create: `apps/server/src/ai/gateway.ts`、`apps/server/src/ai/fake.ts`
- Test: `apps/server/test/ai-gateway.test.ts`

**Interfaces:**
- Consumes: `AiClient`、`AiStreamRequest`、`AiStreamEvent`、`AiTokenUsage`、`AiUpstreamError`（`ai/types.ts`）
- Produces:

```ts
// ai/gateway.ts
export interface OpenAiCompatibleOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}
export class OpenAiCompatibleClient implements AiClient {
  readonly name: 'openai-compatible';
  constructor(baseUrl: string, apiKey: string, options?: OpenAiCompatibleOptions);
  streamChat(request: AiStreamRequest): AsyncIterable<AiStreamEvent>;
}

// ai/fake.ts
export interface FakeAiOptions {
  reply?: string | ((request: AiStreamRequest) => string);
  chunkSize?: number;
  delayMs?: number;
  /** Number of deltas to emit before failing; omit for a full reply. */
  failAfter?: number;
}
export class FakeAiClient implements AiClient {
  readonly name: 'fake';
  constructor(options?: FakeAiOptions);
  readonly lastRequest: AiStreamRequest | null; // 供测试断言提示词
  streamChat(request: AiStreamRequest): AsyncIterable<AiStreamEvent>;
}
```

- `OpenAiCompatibleClient` 在每次对话开始时按当前配置构造，Key 只存在于该实例生命周期内，管理员改 Key 后下一次请求立即生效。
- 请求：`POST ${baseUrl}/chat/completions`，头 `authorization: Bearer <key>`、`content-type: application/json`；体 `{ model, messages, stream: true, stream_options: { include_usage: true }, max_tokens, temperature }`。
- 超时：`AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)])`（默认 60000）。外部 `signal` 中止时抛 `DOMException('Aborted', 'AbortError')`；超时抛 `new AiUpstreamError('AI request timed out', { retryable: true })`。
- 非 2xx：不读取/不记录响应体，抛 `AiUpstreamError('AI provider returned HTTP <status>', { statusCode, retryable: status === 429 || status >= 500 })`。
- 解析：按 `\n` 增量读取 `data:` 行；`[DONE]` 结束；忽略空行、注释与非 `data:` 行。`choices[0].delta.content` 为非空字符串时发 `{ type: 'delta', text }`；顶层 `usage` 存在时发 `{ type: 'usage', usage: { promptTokens: usage.prompt_tokens ?? 0, completionTokens: usage.completion_tokens ?? 0 } }`。JSON 无法解析时抛 `AiUpstreamError('Malformed AI stream', { retryable: false })`。
- `FakeAiClient`：默认回复 `【模拟 AI 回答】已收到上下文，这是本地假提供方返回的流式内容。`；按 `chunkSize`（默认 8 字符）切片，每片之间 `await delay(delayMs ?? 5)`；最后发 `usage`，值为按字符数估算的 `{ promptTokens: ceil(所有消息字符/2), completionTokens: ceil(reply.length/2) }`；`failAfter` 到达后抛 `AiUpstreamError('Fake AI failure', { retryable: true })`。`lastRequest` 记录最近一次请求，测试用它断言上下文确实进入提示词。
- `AI_FAKE_PROVIDER=1` 时工厂返回 `FakeAiClient`；否则返回 `new OpenAiCompatibleClient(config.baseUrl, config.apiKey, { timeoutMs: deps.config.ai.requestTimeoutMs })`。工厂的签名由 Task 3 定为 `aiClientFactory: (config: AiRuntimeConfig) => AiClient`，本任务实现两类客户端，Task 8 替换运行时的占位工厂。

- [ ] **Step 1: 写失败测试**

```ts
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { FakeAiClient } from '../src/ai/fake';
import { OpenAiCompatibleClient } from '../src/ai/gateway';
import { AiUpstreamError, type AiStreamRequest } from '../src/ai/types';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function serveSse(
  handler: (response: import('node:http').ServerResponse) => void,
): Promise<{ baseUrl: string; requests: Array<{ headers: unknown; body: string }> }> {
  const requests: Array<{ headers: unknown; body: string }> = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += String(chunk); });
    request.on('end', () => {
      requests.push({ headers: request.headers, body });
      handler(response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

function request(overrides: Partial<AiStreamRequest> = {}): AiStreamRequest {
  return {
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: '解释这段话' }],
    maxTokens: 128,
    temperature: 0.3,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collect(client: { streamChat(r: AiStreamRequest): AsyncIterable<unknown> }, input: AiStreamRequest) {
  const events: Array<{ type: string; text?: string; usage?: unknown }> = [];
  for await (const event of client.streamChat(input)) {
    events.push(event as { type: string; text?: string; usage?: unknown });
  }
  return events;
}


it('streams deltas and final usage from an OpenAI-compatible provider', async () => {
  const { baseUrl, requests } = await serveSse((response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"content":"第一"}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"content":"段"}}]}\n\n');
    response.write('data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\n');
    response.end('data: [DONE]\n\n');
  });
  const client = new OpenAiCompatibleClient(baseUrl, 'sk-test-secret');
  const events = await collect(client, request());

  expect(events.filter((event) => event.type === 'delta').map((event) => event.text).join(''))
    .toBe('第一段');
  expect(events.at(-1)).toEqual({
    type: 'usage',
    usage: { promptTokens: 12, completionTokens: 3 },
  });
  expect(requests[0]!.headers).toMatchObject({ authorization: 'Bearer sk-test-secret' });
  expect(requests[0]!.body).toContain('"stream":true');
});

it('maps provider failures to retryable upstream errors without leaking the body', async () => {
  const { baseUrl } = await serveSse((response) => {
    response.writeHead(429, { 'content-type': 'application/json' });
    response.end('{"error":{"message":"secret prompt text"}}');
  });
  const client = new OpenAiCompatibleClient(baseUrl, 'sk-test-secret');
  await expect(collect(client, request())).rejects.toMatchObject({
    name: 'AiUpstreamError',
    statusCode: 429,
    retryable: true,
  });
});

it('rejects malformed frames as non-retryable', async () => {
  const { baseUrl } = await serveSse((response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: not-json\n\n');
  });
  const client = new OpenAiCompatibleClient(baseUrl, 'sk-test-secret');
  await expect(collect(client, request())).rejects.toBeInstanceOf(AiUpstreamError);
});

it('honours an external abort', async () => {
  const { baseUrl } = await serveSse((response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"content":"慢"}}]}\n\n');
  });
  const controller = new AbortController();
  const client = new OpenAiCompatibleClient(baseUrl, 'sk-test-secret');
  const iterator = client.streamChat(request({ signal: controller.signal }))[Symbol.asyncIterator]();
  await iterator.next();
  controller.abort();
  await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
});

it('fakes deterministic chunks, usage and failures', async () => {
  const fake = new FakeAiClient({ chunkSize: 4, delayMs: 0 });
  const events = await collect(fake, request());
  expect(events.filter((event) => event.type === 'delta').length).toBeGreaterThan(1);
  expect(events.at(-1)!.type).toBe('usage');
  expect(fake.lastRequest?.messages.at(-1)!.content).toContain('解释这段话');

  const failing = new FakeAiClient({ chunkSize: 1, delayMs: 0, failAfter: 2 });
  await expect(collect(failing, request())).rejects.toMatchObject({ retryable: true });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @bookr/server test -- ai-gateway`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `gateway.ts` 与 `fake.ts`**

读取响应体使用 `response.body.getReader()` + `TextDecoder`；不要在异常消息里拼接响应体。测试中的 `serveSse` 只用于本地，不引入新依赖。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @bookr/server test -- ai-gateway`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/ai/gateway.ts apps/server/src/ai/fake.ts apps/server/test/ai-gateway.test.ts
git commit -m "feat(server): add an OpenAI-compatible streaming gateway"
```

---
### Task 6: 配额预占、结算与按用户时区的窗口

**Files:**
- Create: `apps/server/src/ai/quota.ts`
- Test: `apps/server/test/ai-quota.test.ts`

**Interfaces:**
- Consumes: `aiUsage` 表（Task 2）、`AiTokenUsage`（`ai/types.ts`）、`AppError`/`ERROR_CODES`
- Produces:

```ts
export interface QuotaLimits { daily: number; monthly: number }
export interface AiQuotaWindow { used: number; reserved: number; limit: number }
export interface QuotaSnapshot { daily: AiQuotaWindow; monthly: AiQuotaWindow }
export interface QuotaReserveInput {
  userId: string;
  timezone: string;
  estimate: number;
  limits: QuotaLimits;
  now: Date;
}
export interface QuotaReservation {
  userId: string;
  daily: { periodStart: string; estimate: number };
  monthly: { periodStart: string; estimate: number };
}
export function periodKeys(now: Date, timezone: string): { day: string; month: string };
export async function readQuota(
  db: Database,
  input: Omit<QuotaReserveInput, 'estimate'>,
): Promise<QuotaSnapshot>;
export async function reserveQuota(db: Database, input: QuotaReserveInput): Promise<QuotaReservation>;
export async function settleQuota(
  db: Database,
  reservation: QuotaReservation,
  actual: AiTokenUsage,
  now: Date,
): Promise<QuotaSnapshot>;
export async function releaseQuota(
  db: Database,
  reservation: QuotaReservation,
  now: Date,
): Promise<QuotaSnapshot>;
```

- `periodKeys`：用 `Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)` 取用户本地日期并按 `type` 拼成 `YYYY-MM-DD`，`day = 'YYYY-MM-DD'`、`month = 'YYYY-MM'`；timezone 非法或为空时退回 `'UTC'`。
- `reserveQuota`：`estimate` 向上取整且至少 1。
  - 在事务中先执行 `SELECT pg_advisory_xact_lock(hashtext(${'ai-quota:' + userId}))`，同一用户的预占串行化。
  - 对 day/month 各执行 upsert：不存在则插入 `(user, period, periodStart, reservedTokens=estimate)`；存在则 `reserved_tokens = reserved_tokens + estimate`。
  - upsert 后读取两行，若任一 `used + reserved > limit`，抛 `new AppError(429, ERROR_CODES.AI_QUOTA_EXCEEDED, { daily, monthly })`（details 用更新后的窗口），事务回滚，两个窗口都不留下预占。
  - 返回 `{ userId, daily: { periodStart, estimate }, monthly: { periodStart, estimate } }`。
- `settleQuota`：事务内按保留的 period/periodStart 更新：
  - `reserved_tokens = greatest(reserved_tokens - estimate, 0)`
  - `prompt_tokens += actual.promptTokens`、`completion_tokens += actual.completionTokens`、`updated_at = now`
  - 返回最新 `QuotaSnapshot`。
- `releaseQuota`：等价于 `settleQuota(..., { promptTokens: 0, completionTokens: 0 }, now)`。
- `readQuota`：读用户当前 day/month 行；没有行则 `used=0, reserved=0`；`limit` 来自入参。
- 数值一律过 `Number(...)` 并 `Math.max(0, ...)`；不得出现负数。

- [ ] **Step 1: 写失败测试**

```ts
import { expect, it } from 'vitest';
import { periodKeys, readQuota, releaseQuota, reserveQuota, settleQuota } from '../src/ai/quota';
import { resetDb, seedUser, testDb } from './helpers';

const limits = { daily: 100_000, monthly: 1_000_000 };
const now = new Date('2026-10-19T09:00:00.000Z');

it('uses the user timezone for day and month keys', () => {
  const lateUtc = new Date('2026-10-19T17:30:00.000Z');
  expect(periodKeys(lateUtc, 'Asia/Shanghai')).toEqual({ day: '2026-10-20', month: '2026-10' });
  expect(periodKeys(lateUtc, 'UTC')).toEqual({ day: '2026-10-19', month: '2026-10' });
  expect(periodKeys(lateUtc, 'not/a-zone')).toEqual({ day: '2026-10-19', month: '2026-10' });
});

it('reserves, settles and reports the actual usage', async () => {
  await resetDb();
  const user = await seedUser('member');
  const reservation = await reserveQuota(testDb, {
    userId: user.id, timezone: 'Asia/Shanghai', estimate: 50_000, limits, now,
  });
  // Reservation alone counts against the window.
  expect(await readQuota(testDb, { userId: user.id, timezone: 'Asia/Shanghai', limits, now }))
    .toMatchObject({ daily: { used: 0, reserved: 50_000, limit: 100_000 } });

  const after = await settleQuota(testDb, reservation, { promptTokens: 10_000, completionTokens: 2_000 }, now);
  expect(after.daily).toEqual({ used: 12_000, reserved: 0, limit: 100_000 });
  expect(after.monthly).toEqual({ used: 12_000, reserved: 0, limit: 1_000_000 });
});

it('serialises concurrent reservations and rejects the one that would exceed the limit', async () => {
  await resetDb();
  const user = await seedUser('member');
  const input = { userId: user.id, timezone: 'Asia/Shanghai', estimate: 60_000, limits, now };

  const results = await Promise.allSettled([
    reserveQuota(testDb, input),
    reserveQuota(testDb, input),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const rejected = results.find((result) => result.status === 'rejected');
  expect(rejected).toBeDefined();
  if (rejected?.status === 'rejected') {
    expect(rejected.reason).toMatchObject({ statusCode: 429, code: 'AI_QUOTA_EXCEEDED' });
  }

  const quota = await readQuota(testDb, { userId: user.id, timezone: 'Asia/Shanghai', limits, now });
  expect(quota.daily.reserved).toBe(60_000);
});


it('starts a fresh window after the user-local day rolls over', async () => {
  await resetDb();
  const user = await seedUser('member');
  const reservation = await reserveQuota(testDb, {
    userId: user.id, timezone: 'Asia/Shanghai', estimate: 1_000, limits, now,
  });
  await settleQuota(testDb, reservation, { promptTokens: 900, completionTokens: 100 }, now);

  const nextDay = new Date('2026-10-20T09:00:00.000Z');
  const quota = await readQuota(testDb, {
    userId: user.id, timezone: 'Asia/Shanghai', limits, now: nextDay,
  });
  expect(quota.daily.used).toBe(0);
  // The month window still carries the usage.
  expect(quota.monthly.used).toBe(1_000);
});

it('keeps reserved and used non-negative and releases a failed request', async () => {
  await resetDb();
  const user = await seedUser('member');
  const reservation = await reserveQuota(testDb, {
    userId: user.id, timezone: 'UTC', estimate: 2_000, limits, now,
  });
  const quota = await releaseQuota(testDb, reservation, now);
  expect(quota.daily).toEqual({ used: 0, reserved: 0, limit: 100_000 });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @bookr/server test -- ai-quota`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `quota.ts`**

`pg_advisory_xact_lock` 的 key 用 `hashtext('ai-quota:' || userId)`；事务内一次拿到锁，避免两个请求都看到同样的剩余额度。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @bookr/server test -- ai-quota`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/ai/quota.ts apps/server/test/ai-quota.test.ts
git commit -m "feat(server): reserve and settle per-user AI token quotas"
```

---
### Task 7: 线程/消息仓储与只读 REST + 用量/开关

**Files:**
- Create: `apps/server/src/ai/repo.ts`、`apps/server/src/ai/service.ts`、`apps/server/src/ai/routes.ts`
- Modify: `apps/server/src/app.ts`（注册 AI 路由）
- Test: `apps/server/test/ai-threads.test.ts`

**Interfaces:**
- Consumes: 表（Task 2）、`AiThreadDto`/`AiMessageDto`/`AiUsageDto`（Task 1）、`readQuota`（Task 6）、`readAiConfigView`（Task 3）
- Produces:

```ts
// ai/repo.ts
export interface InsertThreadInput {
  id?: string; userId: string; bookId: string; title: string;
  anchorLocator: Locator | null; now: Date;
}
export interface InsertMessageInput {
  id?: string; threadId: string; role: AiMessageRole; content?: string;
  status?: AiMessageStatus; action?: AiAction | null; selectedText?: string | null;
  model?: string | null; promptVersion?: string | null;
  promptTokens?: number; completionTokens?: number; now: Date;
}
export interface ThreadWithCount extends AiThreadRow { messageCount: number }
export async function insertThread(tx: ReadingTransaction, input: InsertThreadInput): Promise<AiThreadRow>;
export async function findThreadRow(db: Database, userId: string, threadId: string): Promise<AiThreadRow | undefined>;
export async function listThreadRows(db: Database, userId: string, bookId: string): Promise<ThreadWithCount[]>;
export async function insertMessage(tx: ReadingTransaction, input: InsertMessageInput): Promise<AiMessageRow>;
export async function updateMessage(
  tx: ReadingTransaction,
  messageId: string,
  patch: Partial<Pick<AiMessageRow, 'content' | 'status' | 'promptTokens' | 'completionTokens'>>,
  now: Date,
): Promise<AiMessageRow | undefined>;
export async function listMessageRows(db: Database, threadId: string, limit?: number): Promise<AiMessageRow[]>;
export async function deleteThreadRow(db: Database, userId: string, threadId: string): Promise<boolean>;

// ai/service.ts
export function toThreadDto(row: ThreadWithCount): AiThreadDto;
export function toMessageDto(row: AiMessageRow): AiMessageDto;
export async function listThreads(deps: AppDeps, userId: string, bookId: string): Promise<AiThreadDto[]>;
export async function getThreadDetail(
  deps: AppDeps, userId: string, threadId: string,
): Promise<{ thread: AiThreadDto; messages: AiMessageDto[] }>;
export async function removeThread(deps: AppDeps, userId: string, threadId: string): Promise<void>;
export async function getAiUsage(deps: AppDeps, userId: string): Promise<AiUsageDto>;
export async function setAiEnabled(deps: AppDeps, userId: string, enabled: boolean): Promise<boolean>;

// ai/routes.ts
export function registerAiRoutes(app: FastifyInstance, deps: AppDeps): void;
```

- 路由（全部 `makeRequireAuth`）：
  - `GET /api/books/:id/ai/threads`：书不存在或已软删除 → 404；返回 `{ items }`，按 `updated_at DESC`。
  - `GET /api/ai/threads/:id`：不存在或不属于调用者 → 404；返回 `{ thread, messages }`，消息按 `created_at ASC`（同毫秒按 `id` 稳定排序），最多 200 条。
  - `DELETE /api/ai/threads/:id`：不存在或不属于调用者 → 404；成功 204，消息级联删除。
  - `GET /api/ai/usage`：读用户 `timezone`/`aiEnabled`/两个限额，`readQuota`，`readAiConfigView`；`configured` 为假提供方或数据库有配置；`model` 取 `chatModel`。
  - `PATCH /api/me/ai` body `{ enabled: boolean }`：更新 `users.ai_enabled`，返回 `{ enabled }`。
- DTO 时间统一 `toISOString()`；`role/status/action` 原样透出；`messageCount` 用 `Number(...)`。
- 删除线程是硬删除（消息 `ON DELETE CASCADE`）；P6 若需要历史再改为墓碑。

- [ ] **Step 1: 写失败测试**

```ts
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { aiMessages, aiThreads, aiUsage, books } from '../src/db/schema';
import { periodKeys } from '../src/ai/quota';
import {
  authHeader, createTestApp, resetDb, seedBook, seedUser, testDb,
} from './helpers';

async function seedThread(userId: string, bookId: string) {
  const [thread] = await testDb.insert(aiThreads).values({
    userId, bookId, title: '解释一段话',
    anchorLocator: { kind: 'pdf', page: 2, percent: 0.2 },
  }).returning();
  await testDb.insert(aiMessages).values([
    { threadId: thread!.id, role: 'user', content: '为什么？', action: 'ask', status: 'complete' },
    { threadId: thread!.id, role: 'assistant', content: '因为……', status: 'complete' },
  ]);
  return thread!;
}

it('lists, reads and deletes only the caller\'s threads', async () => {
  await resetDb();
  const { app } = await createTestApp();
  const owner = await seedUser('member');
  const other = await seedUser('member');
  const book = await seedBook({ uploadedBy: owner.id, format: 'pdf' });
  const thread = await seedThread(owner.id, book.id);

  const list = await app.inject({
    method: 'GET', url: `/api/books/${book.id}/ai/threads`, headers: await authHeader(owner),
  });
  expect(list.statusCode).toBe(200);
  expect(list.json().items).toMatchObject([{ id: thread.id, messageCount: 2 }]);

  const detail = await app.inject({
    method: 'GET', url: `/api/ai/threads/${thread.id}`, headers: await authHeader(owner),
  });
  expect(detail.statusCode).toBe(200);
  expect(detail.json().messages.map((message: { role: string }) => message.role))
    .toEqual(['user', 'assistant']);

  const otherHeaders = await authHeader(other);
  expect((await app.inject({ method: 'GET', url: `/api/ai/threads/${thread.id}`, headers: otherHeaders })).statusCode)
    .toBe(404);
  expect((await app.inject({ method: 'DELETE', url: `/api/ai/threads/${thread.id}`, headers: otherHeaders })).statusCode)
    .toBe(404);
  expect((await app.inject({ method: 'GET', url: `/api/books/${book.id}/ai/threads`, headers: otherHeaders })).json().items)
    .toEqual([]);

  expect((await app.inject({ method: 'DELETE', url: `/api/ai/threads/${thread.id}`, headers: await authHeader(owner) })).statusCode)
    .toBe(204);
  expect(await testDb.select().from(aiMessages)).toHaveLength(0);
});


it('reports usage, enablement and configuration', async () => {
  await resetDb();
  const { app } = await createTestApp();
  const user = await seedUser('member');
  const headers = await authHeader(user);
  const keys = periodKeys(new Date(), 'Asia/Shanghai');
  await testDb.insert(aiUsage).values({
    userId: user.id, period: 'day', periodStart: keys.day,
    promptTokens: 1_000, completionTokens: 234,
  });

  const usage = await app.inject({ method: 'GET', url: '/api/ai/usage', headers });
  expect(usage.statusCode).toBe(200);
  expect(usage.json()).toMatchObject({
    enabled: true,
    configured: false,
    model: null,
    daily: { used: 1_234, reserved: 0, limit: 100_000 },
    monthly: { limit: 1_000_000 },
  });

  const toggled = await app.inject({
    method: 'PATCH', url: '/api/me/ai', headers, payload: { enabled: false },
  });
  expect(toggled.json()).toEqual({ enabled: false });
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers });
  expect(me.json().aiEnabled).toBe(false);
});

it('refuses threads for a book that is gone', async () => {
  await resetDb();
  const { app } = await createTestApp();
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id, format: 'pdf' });
  await testDb.update(books).set({ deletedAt: new Date() }).where(eq(books.id, book.id));

  const response = await app.inject({
    method: 'GET', url: `/api/books/${book.id}/ai/threads`, headers: await authHeader(user),
  });
  expect(response.statusCode).toBe(404);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @bookr/server test -- ai-threads`
Expected: FAIL（路由不存在）

- [ ] **Step 3: 实现仓储、服务与路由，并在 `app.ts` 注册**

`listMessageRows` 先按 `created_at DESC, id DESC` 取 200 条再反转，保证返回最旧的 200 条且顺序稳定。`getThreadDetail` 的 `thread` DTO 的 `messageCount` 与消息条数一致。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @bookr/server test -- ai-threads`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/ai/repo.ts apps/server/src/ai/service.ts apps/server/src/ai/routes.ts apps/server/src/app.ts apps/server/test/ai-threads.test.ts
git commit -m "feat(server): expose AI threads, usage and the user toggle"
```

---
### Task 8: 流式对话端点（线程创建、上下文、配额、持久化）

**Files:**
- Create: `apps/server/src/ai/chat.ts`
- Modify: `apps/server/src/ai/routes.ts`、`apps/server/src/runtime.ts`、`apps/server/test/helpers.ts`、`apps/server/src/app.ts`（如路由注册已存在则只改 routes）
- Test: `apps/server/test/ai-chat.test.ts`

**Interfaces:**
- Consumes: Task 3/4/5/6/7 的全部产出、`aiChatRequestSchema`（Task 1）
- Produces:

```ts
// ai/chat.ts
export interface PreparedChat {
  threadId: string;
  userMessageId: string;
  assistantMessageId: string;
  model: string;
  promptVersion: string;
  client: AiClient;
  messages: AiChatMessage[];
  promptTokens: number;
  reservation: QuotaReservation;
  timezone: string;
  limits: QuotaLimits;
}
export interface ChatSink {
  meta(meta: AiStreamMeta): void;
  delta(text: string): void;
  done(done: AiStreamDone): void;
  error(payload: AiStreamErrorPayload): void;
}
export async function prepareChat(
  deps: AppDeps,
  userId: string,
  bookId: string,
  body: AiChatRequest,
): Promise<PreparedChat>;
export async function executeChat(
  deps: AppDeps,
  prepared: PreparedChat,
  sink: ChatSink,
  signal: AbortSignal,
): Promise<void>;

// ai/routes.ts 追加
app.post('/api/books/:id/ai/chat', { preHandler: requireAuth, bodyLimit: 1_048_576 }, ...)
```

- **prepareChat**（所有错误都在进入 SSE 之前以 JSON 返回）：
  1. 读用户 `aiEnabled/timezone/aiDailyTokenLimit/aiMonthlyTokenLimit`；`aiEnabled === false` → `AppError(403, AI_DISABLED)`。
  2. `readAiConfig(deps)`；null → `AppError(503, AI_NOT_CONFIGURED, { reason: 'missing_config' })`。
  3. 书必须存在且 `deleted_at IS NULL`，否则 `AppError(404, NOT_FOUND)`。
  4. 线程：有 `threadId` 时必须属于该用户且 `bookId` 相同，否则 404；没有则创建：
     - 标题：`explain` → `解释：${selectedText.slice(0, 40)}`；`ask` → `提问：${question.slice(0, 40)}`；`summarize` → `总结本页`/`总结本章`；统一 `slice(0, AI_THREAD_TITLE_MAX_LENGTH)`。
     - `anchorLocator = body.locator ?? null`。
  5. 读该线程最近 200 条消息作为历史，只保留 role 为 user/assistant 且 content 非空、status ∈ `complete|interrupted` 的消息。
  6. `assemblePrompt({ action, scope, book: {title, author}, locator, selectedText, question, pageText: body.context?.pageText, chapterText: body.context?.chapterText, history, contextTokenBudget: deps.config.ai.contextTokenBudget })`。
  7. `estimate = promptTokens + AI_MAX_OUTPUT_TOKENS`，`reserveQuota`（用用户两个限额与时区）；失败（429）直接抛出。
  8. 在同一事务中插入 user 消息与 assistant 占位（`status: 'streaming'`、`content: ''`、`model`、`promptVersion`、`action`、`selectedText`），并更新线程 `updated_at`。插入失败则 `releaseQuota` 后原样抛出。
  9. 返回 prepared；`client = deps.aiClientFactory(aiConfig)`。
- 用户消息内容：`explain` → `selectedText`；`ask` → `question`；`summarize` → `总结本页`/`总结本章`。
- **executeChat**：
  - 先 `sink.meta({ threadId, userMessageId, assistantMessageId, action, model, promptVersion })`。
  - 迭代 `client.streamChat({ model, messages, maxTokens: AI_MAX_OUTPUT_TOKENS, temperature: 0.3, signal })`；每个 `delta` 追加到 `answer` 并 `sink.delta(text)`；`usage` 事件记录。
  - 正常结束：`actual = usage ?? { promptTokens: prepared.promptTokens, completionTokens: estimateTokens(answer) }`；`settleQuota`；`updateMessage` 写 `content/status='complete'/tokens`；`sink.done({ assistantMessageId, usage: actual, quota })`。
  - 外部 abort：与正常结束同样结算（上游确实收到请求），但状态写 `interrupted`，不发 `done`。
  - 上游错误：状态写 `failed`，已收到的部分内容保留；结算 `usage ?? { promptTokens: promptTokens, completionTokens: estimateTokens(answer) }`；发 `error`：超时消息 → `AI_TIMEOUT`，其余 → `AI_UPSTREAM_FAILED`，`retryable` 取上游错误；用户可见消息固定为 `AI 服务暂时不可用，请稍后重试` 或 `AI 响应超时，请重试`，不得包含上游原文。
  - 所有分支都必须结算配额一次（用布尔标记防重复）；未知异常只记录 `errorName`。
- **路由**：
  - `aiChatRequestSchema.parse(request.body)`；`prepareChat` 成功后 `reply.hijack()`，`writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' })`。
  - 帧格式：`event: meta|delta|done|error\ndata: <JSON>\n\n`；`raw.write` 返回 false 时 `await once(raw, 'drain')`（5 秒超时后放弃并 abort 上游）。
  - 在 `raw.on('close')` 时若尚未正常结束则 `controller.abort()`；`finally` 中标记结束并 `raw.end()`。
  - 客户端断开后不得继续写；写失败只触发 abort，不抛到 Fastify。
- **运行时工厂**：`runtime.ts` 改为
  ```ts
  aiClientFactory: (aiConfig) => aiConfig.fakeProvider
    ? new FakeAiClient()
    : new OpenAiCompatibleClient(aiConfig.baseUrl, aiConfig.apiKey, {
        timeoutMs: config.ai.requestTimeoutMs,
      }),
  ```
- **测试依赖**：`buildTestDeps(overrides, extra)` 与 `createTestApp(overrides, options, extra)` 接受 `extra.aiClientFactory`；默认工厂返回 `new FakeAiClient({ chunkSize: 4, delayMs: 0 })`。测试可注入捕获实例。
- **日志**：只记录 `{ userId, threadId, action, promptTokens, completionTokens, aborted, errorName }`，绝不记录消息内容。

- [ ] **Step 1: 写失败测试**

```ts
import { setTimeout as delay } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { expect, it } from 'vitest';
import { FakeAiClient } from '../src/ai/fake';
import { aiMessages, aiThreads, aiUsage, users } from '../src/db/schema';
import {
  authHeader, buildTestConfig, createTestApp, resetDb, seedBook, seedUser, testDb,
} from './helpers';

interface SseEvent { event: string; data: Record<string, unknown> }

function parseFrames(text: string): SseEvent[] {
  return text.split('\n\n').filter(Boolean).map((frame) => {
    const lines = frame.split('\n');
    const event = lines.find((line) => line.startsWith('event: '))!.slice(7);
    const data = lines.find((line) => line.startsWith('data: '))!.slice(6);
    return { event, data: JSON.parse(data) as Record<string, unknown> };
  });
}

async function startApp(aiClientFactory: () => FakeAiClient) {
  const { app } = await createTestApp(
    buildTestConfig({ ai: { fakeProvider: true } }),
    {},
    { aiClientFactory },
  );
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, url };
}

async function stopApp(app: FastifyInstance): Promise<void> {
  app.server.closeAllConnections();
  await app.close();
}

const explainBody = {
  action: 'explain',
  selectedText: '程序如何运行',
  locator: { kind: 'pdf', page: 2, percent: 0.2 },
  context: { pageText: '本页正文：程序由指令组成。' },
};

it('streams an explanation and persists both messages', async () => {
  await resetDb();
  const fake = new FakeAiClient({ chunkSize: 4, delayMs: 0 });
  const { app, url } = await startApp(() => fake);
  const user = await seedUser('member');
  const book = await seedBook({
    uploadedBy: user.id, format: 'pdf',
    title: '深入理解计算机系统', author: 'Bryant',
  });
  const headers = await authHeader(user);

  const response = await fetch(`${url}/api/books/${book.id}/ai/chat`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(explainBody),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const events = parseFrames(await response.text());

  expect(events.map((event) => event.event)).toContain('meta');
  expect(events.at(-1)!.event).toBe('done');
  expect(events.filter((event) => event.event === 'delta').map((event) => event.data.text).join(''))
    .toContain('模拟 AI 回答');

  const meta = events.find((event) => event.event === 'meta')!.data;
  const messages = await testDb.select().from(aiMessages);
  expect(messages).toHaveLength(2);
  expect(messages.find((message) => message.role === 'user')!.content).toBe('程序如何运行');
  const assistant = messages.find((message) => message.role === 'assistant')!;
  expect(assistant).toMatchObject({ status: 'complete', action: 'explain' });
  expect(assistant.content).toContain('模拟 AI 回答');
  expect(meta).toMatchObject({ threadId: assistant.threadId, assistantMessageId: assistant.id });

  const prompt = fake.lastRequest!.messages.map((message) => message.content).join('\n');
  expect(prompt).toContain('程序如何运行');
  expect(prompt).toContain('本页正文：程序由指令组成。');
  expect(prompt).toContain('深入理解');

  const usage = await testDb.select().from(aiUsage);
  expect(usage.length).toBe(2);
  expect(usage.every((row) => row.reservedTokens === 0)).toBe(true);

  await stopApp(app);
});


it('rejects disabled accounts, missing configuration and exhausted quotas before streaming', async () => {
  await resetDb();
  const fake = new FakeAiClient({ delayMs: 0 });
  const { app, url } = await startApp(() => fake);
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id, format: 'pdf' });
  const headers = await authHeader(user);
  const post = () => fetch(`${url}/api/books/${book.id}/ai/chat`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(explainBody),
  });

  await testDb.update(users).set({ aiEnabled: false }).where(eq(users.id, user.id));
  const disabled = await post();
  expect(disabled.status).toBe(403);
  expect((await disabled.json()).error.code).toBe('AI_DISABLED');

  await testDb.update(users).set({ aiEnabled: true, aiDailyTokenLimit: 10 }).where(eq(users.id, user.id));
  const quota = await post();
  expect(quota.status).toBe(429);
  expect((await quota.json()).error.code).toBe('AI_QUOTA_EXCEEDED');
  expect(fake.lastRequest).toBeNull();
  expect(await testDb.select().from(aiMessages)).toHaveLength(0);

  await stopApp(app);
});

it('returns 503 when no provider is configured', async () => {
  await resetDb();
  const fake = new FakeAiClient({ delayMs: 0 });
  const { app } = await createTestApp(buildTestConfig(), {}, { aiClientFactory: () => fake });
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id, format: 'pdf' });
  const response = await app.inject({
    method: 'POST', url: `/api/books/${book.id}/ai/chat`,
    headers: await authHeader(user), payload: explainBody,
  });
  expect(response.statusCode).toBe(503);
  expect(response.json().error.code).toBe('AI_NOT_CONFIGURED');
  await app.close();
});

it('refuses a thread that belongs to another account', async () => {
  await resetDb();
  const fake = new FakeAiClient({ delayMs: 0 });
  const { app, url } = await startApp(() => fake);
  const owner = await seedUser('member');
  const other = await seedUser('member');
  const book = await seedBook({ uploadedBy: owner.id, format: 'pdf' });
  const [thread] = await testDb.insert(aiThreads).values({
    userId: owner.id, bookId: book.id, title: '别人的线程',
  }).returning();

  const response = await fetch(`${url}/api/books/${book.id}/ai/chat`, {
    method: 'POST',
    headers: { ...(await authHeader(other)), 'content-type': 'application/json' },
    body: JSON.stringify({ ...explainBody, threadId: thread!.id }),
  });
  expect(response.status).toBe(404);
  await response.text();
  expect(fake.lastRequest).toBeNull();
  await stopApp(app);
});

it('persists a partial answer when the client disconnects', async () => {
  await resetDb();
  const fake = new FakeAiClient({ chunkSize: 2, delayMs: 30 });
  const { app, url } = await startApp(() => fake);
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id, format: 'pdf' });
  const controller = new AbortController();
  const response = await fetch(`${url}/api/books/${book.id}/ai/chat`, {
    method: 'POST',
    headers: { ...(await authHeader(user)), 'content-type': 'application/json' },
    body: JSON.stringify(explainBody),
    signal: controller.signal,
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let received = '';
  while (!received.includes('event: delta')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += decoder.decode(chunk.value, { stream: true });
  }
  const meta = parseFrames(received).find((event) => event.event === 'meta')!.data;
  controller.abort();

  let assistant: typeof aiMessages.$inferSelect | undefined;
  for (let attempt = 0; attempt < 50 && assistant?.status !== 'interrupted'; attempt += 1) {
    await delay(20);
    [assistant] = await testDb.select().from(aiMessages)
      .where(eq(aiMessages.id, String(meta.assistantMessageId)));
  }
  expect(assistant?.status).toBe('interrupted');
  expect(assistant?.content.length).toBeGreaterThan(0);

  const usage = await testDb.select().from(aiUsage);
  expect(usage.every((row) => row.reservedTokens === 0)).toBe(true);
  expect(usage.some((row) => row.promptTokens > 0)).toBe(true);
  await stopApp(app);
});

it('reports an upstream failure and keeps the partial answer', async () => {
  await resetDb();
  const fake = new FakeAiClient({ chunkSize: 2, delayMs: 0, failAfter: 2 });
  const { app, url } = await startApp(() => fake);
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id, format: 'pdf' });

  const response = await fetch(`${url}/api/books/${book.id}/ai/chat`, {
    method: 'POST',
    headers: { ...(await authHeader(user)), 'content-type': 'application/json' },
    body: JSON.stringify(explainBody),
  });
  const events = parseFrames(await response.text());
  expect(events.map((event) => event.event)).toEqual(
    expect.arrayContaining(['meta', 'delta', 'error']),
  );
  expect(events.some((event) => event.event === 'done')).toBe(false);
  expect(events.at(-1)!.data).toMatchObject({ code: 'AI_UPSTREAM_FAILED', retryable: true });

  const assistant = (await testDb.select().from(aiMessages))
    .find((message) => message.role === 'assistant')!;
  expect(assistant.status).toBe('failed');
  expect(assistant.content.length).toBeGreaterThan(0);
  await stopApp(app);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @bookr/server test -- ai-chat`
Expected: FAIL（`prepareChat` 不存在）

- [ ] **Step 3: 实现 `chat.ts`、路由与运行时工厂**

SSE 写入失败（客户端断开）只能触发 abort；`finally` 必须尝试 `raw.end()`，但不得在已断开时抛错。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @bookr/server test -- ai-chat`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/ai/chat.ts apps/server/src/ai/routes.ts apps/server/src/runtime.ts apps/server/src/app.ts apps/server/test/helpers.ts apps/server/test/ai-chat.test.ts
git commit -m "feat(server): stream AI answers over SSE with quota settlement"
```

---
### Task 9: 阅读内核文本上下文 API

**Files:**
- Modify: `packages/reader-core/src/types.ts`
- Create: `packages/reader-core/src/text-context.ts`
- Modify: `packages/reader-core/src/pdf/engine.ts`、`packages/reader-core/src/epub/engine.ts`、`packages/reader-core/src/reflow/engine.ts`
- Modify: `packages/reader-core/src/__tests__/{pdf-engine,reflow-engine}.test.ts`
- Create: `packages/reader-core/src/__tests__/text-context.test.ts`
- Modify: `apps/web/src/features/reader/__tests__/fake-engine.ts`

**Interfaces:**
- Consumes: `Locator`/`ReflowPack`（`@bookr/shared`）、`ReflowPackIndex`/`indexForPack`
- Produces:

```ts
// types.ts
export type ReaderContextScope = 'page' | 'chapter';
export interface ReaderTextContext {
  scope: ReaderContextScope;
  text: string;
  label: string;
  truncated: boolean;
}
export interface ReaderEngine {
  // ...既有方法不变
  getTextContext(scope: ReaderContextScope, maxChars?: number): Promise<ReaderTextContext>;
}

// text-context.ts
export const DEFAULT_CONTEXT_MAX_CHARS = 20_000;
export function normalizeContextText(text: string): string;
export function capContextText(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean };
export function pdfPageText(items: Array<{ str?: string; hasEOL?: boolean }>): string;
export function pdfChapterRange(
  currentPage: number,
  tocPages: number[],
  pageCount: number,
): { start: number; end: number };
export function epubTextFromDocument(document: Document): string;
export function reflowChapterText(
  index: ReflowPackIndex,
  sourcePage: number,
  blockId: string | null,
  maxChars: number,
): { text: string; label: string; truncated: boolean };
```

- `normalizeContextText`：` ` → 空格；连续 3 个以上换行折叠为 2 个；行尾空白去掉；整体 `trim()`；不改变中文之间的空格。
- `capContextText`：`maxChars <= 0` 返回空；超长截到 `maxChars` 并在末尾加 `…`，`truncated = true`；`…` 不占 `maxChars` 之外（`text.length <= maxChars + 1`）。
- `pdfPageText`：按顺序拼接 `str`；`hasEOL` 为真时补 `\n`，否则补一个空格；最后 `normalizeContextText`。
- `pdfChapterRange`：`tocPages` 去重升序；`start` = 不大于 `currentPage` 的最大 toc 页，没有则 `currentPage`；`end` = 大于 `start` 的最近的 toc 页减 1，没有则 `min(pageCount, start + 19)`；保证 `start >= 1`、`end >= start`、`end <= pageCount`。
- `epubTextFromDocument`：`document.body?.innerText ?? document.body?.textContent ?? ''`，再 `normalizeContextText`；`document` 为 null 时返回空串。
- `reflowChapterText`：把 pack 内所有文本块按页展平；从当前 `(sourcePage, blockId)`（找不到则当前页第一个文本块）向前找最近的 `type === 'heading'` 块作为起点；从起点向后直到下一个 heading（不含）收集文本；`label` 为起点 heading 文本，否则 `第 N 页`；最后 `capContextText`。没有文本时返回空串与 `第 N 页`。
- 引擎实现：
  - **PDF**：`open` 时把 `toc` 存到实例字段。`page`：当前页 `getPage` → `getTextContent()` → `pdfPageText`，`label = 第 N 页`。`chapter`：用 `pdfChapterRange(currentPage, 扁平化 toc 的 pdf 页码, pageCount)` 逐页取文本、以 `\n\n` 连接直到超过 `maxChars`；`label` 取起点对应的 toc 标题（没有则 `第 N 页`）。扫描页文本为空时仍返回空 text 而不是抛错。
  - **EPUB**：从 `rendition.getContents()` 取当前 `contents.document`，`epubTextFromDocument`；`label` 优先匹配 `lastLocator.href` 的 toc 标题，否则 `document.title`，再否则 `本章`。`page` 与 `chapter` 都返回当前章节文本（EPUB 无固定分页），`scope` 原样回填。
  - **Reflow**：`page` 用 `index.textBlocksOnPage(sourcePage)` 的 `text` 连接；`chapter` 用 `reflowChapterText`；`sourcePage` 取自 `currentLocator()`，blockId 存在时传入。
  - 所有实现都接受 `maxChars ?? DEFAULT_CONTEXT_MAX_CHARS`，并返回 `truncated`。
- `fake-engine.ts` 增加 `getTextContext: vi.fn(async (scope) => ({ scope, text: scope === 'page' ? '模拟本页正文' : '模拟本章正文', label: scope === 'page' ? '第 2 页' : '第一章', truncated: false }))`。

- [ ] **Step 1: 写失败测试**

```ts
import type { ReflowPack } from '@bookr/shared';
import { describe, expect, it } from 'vitest';
import { indexForPack } from '../reflow/pack';
import {
  capContextText,
  epubTextFromDocument,
  normalizeContextText,
  pdfChapterRange,
  pdfPageText,
  reflowChapterText,
} from '../text-context';

function pack(): ReflowPack {
  return {
    schemaVersion: 1,
    source: { sha256: 'a'.repeat(64), pageCount: 2 },
    generatedAt: '2026-10-18T08:00:00.000Z',
    tool: { name: 'bookr-preprocess', version: '1.0.0' },
    quality: {
      pages: 2, textBlocks: 4, fallbackPages: [], ocrPages: [],
      avgConfidence: null, warnings: [],
    },
    toc: [],
    pages: [
      {
        page: 1, width: 600, height: 800,
        blocks: [
          { id: 'h1', type: 'heading', level: 1, text: '第一章', rect: { x: 0, y: 0, w: 1, h: 0.1 } },
          { id: 'p1', type: 'paragraph', text: '第一章正文', rect: { x: 0, y: 0.1, w: 1, h: 0.1 } },
        ],
      },
      {
        page: 2, width: 600, height: 800,
        blocks: [
          { id: 'h2', type: 'heading', level: 1, text: '第二章', rect: { x: 0, y: 0, w: 1, h: 0.1 } },
          { id: 'p2', type: 'paragraph', text: '第二章正文', rect: { x: 0, y: 0.1, w: 1, h: 0.1 } },
        ],
      },
    ],
  };
}

it('normalizes whitespace and caps text', () => {
  expect(normalizeContextText('  第一段\n\n\n\n第二段  ')).toBe('第一段\n\n第二段');
  expect(capContextText('abcdef', 3)).toEqual({ text: 'abc…', truncated: true });
  expect(capContextText('abc', 3)).toEqual({ text: 'abc', truncated: false });
  expect(capContextText('abc', 0)).toEqual({ text: '', truncated: true });
});

it('joins PDF text items with line breaks and spaces', () => {
  expect(pdfPageText([
    { str: 'Hello' }, { str: 'world' }, { str: 'next line', hasEOL: true }, { str: 'end' },
  ])).toBe('Hello world next line\nend');
});

it('computes a chapter range from the outline', () => {
  expect(pdfChapterRange(5, [1, 4, 9], 20)).toEqual({ start: 4, end: 8 });
  expect(pdfChapterRange(5, [], 20)).toEqual({ start: 5, end: 20 });
  expect(pdfChapterRange(1, [1, 4], 20)).toEqual({ start: 1, end: 3 });
  expect(pdfChapterRange(18, [1, 4], 20)).toEqual({ start: 18, end: 20 });
});

it('extracts EPUB chapter text from a document', () => {
  const document = new DOMParser().parseFromString(
    '<html><body><p>第一段</p><p>第二段</p></body></html>',
    'text/html',
  );
  expect(epubTextFromDocument(document)).toContain('第一段');
});

it('collects reflow text from the current heading to the next one', () => {
  const result = reflowChapterText(indexForPack(pack()), 1, 'p1', 10_000);
  expect(result.label).toBe('第一章');
  expect(result.text).toContain('第一章正文');
  expect(result.text).not.toContain('第二章正文');

  const capped = reflowChapterText(indexForPack(pack()), 1, 'p1', 3);
  expect(capped.truncated).toBe(true);
});
```

在 `pdf-engine.test.ts` 的 mock 中补充：

```ts
const mock = vi.hoisted(() => ({
  renderCalls: [] as number[],
  failedPages: new Set<number>(),
  pageCount: 10,
  textByPage: {} as Record<number, Array<{ str: string; hasEOL?: boolean }>>,
  outline: [] as Array<{ title: string; dest: unknown }>,
}));

// getPage 返回对象中追加：
getTextContent: async () => ({ items: mock.textByPage[pageNumber] ?? [] }),
// 顶部返回对象中追加：
getOutline: async () => mock.outline,
```

并追加测试：

```ts
it('returns page and outline chapter text for the AI companion', async () => {
  mock.textByPage = {
    1: [{ str: '第一章开头' }],
    2: [{ str: '本页第一句。' }, { str: '本页第二句。' }],
    3: [{ str: '第二章开头' }],
  };
  mock.outline = [
    { title: '第一章', dest: [{ num: 1 }] },
    { title: '第二章', dest: [{ num: 3 }] },
  ];
  const { engine } = await openReader('single', 2);
  try {
    const page = await engine.getTextContext('page');
    expect(page).toMatchObject({ scope: 'page', label: '第 2 页' });
    expect(page.text).toContain('本页第一句');

    const chapter = await engine.getTextContext('chapter');
    expect(chapter.text).toContain('本页第一句');
    expect(chapter.text).not.toContain('第二章开头');
  } finally {
    await engine.destroy();
  }
});
```

在 `reflow-engine.test.ts` 追加：

```ts
it('returns page and chapter text for the AI companion', async () => {
  const { engine } = await openWith(makePack());
  try {
    const page = await engine.getTextContext('page');
    expect(page.text).toContain('p1-b1 的正文');

    const chapter = await engine.getTextContext('chapter');
    expect(chapter.label).toContain('第 p1-b0 节');
    expect(chapter.text).toContain('p1-b1 的正文');
    expect(chapter.text).not.toContain('p3-b1 的正文');
  } finally {
    await engine.destroy();
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @bookr/reader-core test`
Expected: FAIL（`getTextContext` 未定义）

- [ ] **Step 3: 实现 `text-context.ts` 与三个引擎**

PDF 的 outline 页码映射复用 `TocItem.locator`；若 toc 项不是 pdf locator 则跳过。EPUB 的 `renditionContents` 已有私有方法，直接复用。所有读取失败（页面未加载、文档已销毁）都返回空文本，不向 UI 抛错。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @bookr/reader-core test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/reader-core/src apps/web/src/features/reader/__tests__/fake-engine.ts
git commit -m "feat(reader-core): expose page and chapter text for AI context"
```

---
### Task 10: Web API 客户端与 SSE 解析

**Files:**
- Modify: `apps/web/src/api/client.ts`
- Create: `apps/web/src/api/ai.ts`、`apps/web/src/features/reader/ai/stream.ts`
- Test: `apps/web/src/api/__tests__/ai.test.ts`、`apps/web/src/features/reader/ai/__tests__/stream.test.ts`

**Interfaces:**
- Consumes: `AiChatRequest`/`AiThreadDto`/`AiMessageDto`/`AiUsageDto`/`AiStream*`（`@bookr/shared`）、`ApiError`/`errorFromResponse`/`getTokens`（`api/client.ts`）
- Produces:

```ts
// api/client.ts
/** Same auth/refresh handling as apiFetch, but returns the raw Response. */
export async function authorizedFetch(path: string, init?: RequestInit): Promise<Response>;

// features/reader/ai/stream.ts
export interface SseFrame { event: string; data: string }
export class AiStreamProtocolError extends Error {}
export function createSseParser(onFrame: (frame: SseFrame) => void): {
  push(chunk: string): void;
  flush(): void;
};
export async function readSseStream(
  stream: ReadableStream<Uint8Array>,
  onFrame: (frame: SseFrame) => void,
): Promise<void>;

// api/ai.ts
export async function fetchAiUsage(): Promise<AiUsageDto>;
export async function fetchAiThreads(bookId: string): Promise<AiThreadDto[]>;
export async function fetchAiThread(threadId: string): Promise<{ thread: AiThreadDto; messages: AiMessageDto[] }>;
export async function deleteAiThread(threadId: string): Promise<void>;
export async function setAiEnabled(enabled: boolean): Promise<boolean>;
export interface AiStreamHandlers {
  onMeta(meta: AiStreamMeta): void;
  onDelta(text: string): void;
  onDone(done: AiStreamDone): void;
  onError(payload: AiStreamErrorPayload): void;
}
export async function streamAiChat(
  bookId: string,
  body: AiChatRequest,
  handlers: AiStreamHandlers,
  options?: { signal?: AbortSignal },
): Promise<void>;
```

- `authorizedFetch`：抽出 `apiFetch` 现有的 401 处理逻辑（最新 token 比较、共享 refresh、网络失败不登出、401/403 才 endSession），成功后**不读取 body**；`!response.ok` 时 `throw await errorFromResponse(response)`。`apiFetch` 改为调用它，行为与现有测试一致。
- `createSseParser`：把输入按行处理；`\r\n` 归一化为 `\n`；空行结束一帧；`event:` 设置事件名（缺省 `message`）；`data:` 多行用 `\n` 连接；忽略 `:` 注释行与其他字段。`flush()` 时若缓冲里有完整帧则派发，残留不完整帧抛 `AiStreamProtocolError('AI 流意外结束')`。
- `readSseStream`：`getReader()` + `TextDecoder` 增量解码，逐块 `push`，结束时 `flush`；不做 JSON 解析。
- `streamAiChat`：
  - `authorizedFetch(`/api/books/${bookId}/ai/chat`, { method: 'POST', body: JSON.stringify(body), signal })`；非 2xx 已在 `authorizedFetch` 抛 `ApiError`。
  - 用 `readSseStream`；对 `meta/delta/done/error` 帧 `JSON.parse` 后调用对应 handler；未知事件忽略；JSON 解析失败抛 `AiStreamProtocolError`。
  - 收到 `error` 帧调用 `onError` 后正常返回（不再抛）；流结束前既没有 `done` 也没有 `error` 时抛 `AiStreamProtocolError('AI 流意外结束')`。
  - AbortSignal 中止时让 `AbortError` 原样抛出，调用方据此区分「用户点停止」。

- [ ] **Step 1: 写失败测试**

```ts
import { afterEach, expect, it, vi } from 'vitest';
import { setTokens } from '../../../api/client';
import { streamAiChat } from '../../../api/ai';
import {
  AiStreamProtocolError,
  createSseParser,
  readSseStream,
  type SseFrame,
} from '../stream';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it('parses frames across chunk boundaries, CRLF and multi-line data', () => {
  const frames: SseFrame[] = [];
  const parser = createSseParser((frame) => frames.push(frame));
  parser.push('event: meta\r\ndata: {"a":1}\r\n\r\n:: comment\r\nevent: delta\ndata: line1\ndata: line2\n');
  parser.push('\n');
  parser.flush();
  expect(frames).toEqual([
    { event: 'meta', data: '{"a":1}' },
    { event: 'delta', data: 'line1\nline2' },
  ]);
});

it('throws on an incomplete trailing frame', () => {
  const parser = createSseParser(() => undefined);
  parser.push('event: delta\ndata: {"text":"x"}\n');
  expect(() => parser.flush()).toThrow(AiStreamProtocolError);
});

it('reads a stream and dispatches the AI events', async () => {
  setTokens({
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token-which-is-long-enough',
    expiresIn: 900,
  });
  const fetchMock = vi.fn(async () => new Response(streamOf([
    'event: meta\ndata: {"threadId":"t1","userMessageId":"u1","assistantMessageId":"a1",',
    '"action":"explain","model":"deepseek-chat","promptVersion":"p5.1"}\n\n',
    'event: delta\ndata: {"text":"你好"}\n\n',
    'event: done\ndata: {"assistantMessageId":"a1","usage":{"promptTokens":3,"completionTokens":2},',
    '"quota":{"daily":{"used":5,"reserved":0,"limit":100},"monthly":{"used":5,"reserved":0,"limit":1000}}}\n\n',
  ]), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
  vi.stubGlobal('fetch', fetchMock);
  const handlers = {
    onMeta: vi.fn(), onDelta: vi.fn(), onDone: vi.fn(), onError: vi.fn(),
  };

  await streamAiChat('book-1', {
    action: 'explain',
    selectedText: '一段话',
    context: { pageText: '本页' },
  }, handlers);

  expect(handlers.onMeta).toHaveBeenCalledWith(expect.objectContaining({ threadId: 't1' }));
  expect(handlers.onDelta).toHaveBeenCalledWith('你好');
  expect(handlers.onDone).toHaveBeenCalledWith(expect.objectContaining({ assistantMessageId: 'a1' }));
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/books/book-1/ai/chat',
    expect.objectContaining({ method: 'POST' }),
  );
});


it('surfaces an error frame without throwing', async () => {
  setTokens({
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token-which-is-long-enough',
    expiresIn: 900,
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(streamOf([
    'event: error\ndata: {"code":"AI_UPSTREAM_FAILED","message":"AI 服务暂时不可用，请稍后重试","retryable":true}\n\n',
  ]), { status: 200 })));
  const onError = vi.fn();
  await streamAiChat('book-1', { action: 'ask', question: '为什么？' }, {
    onMeta: vi.fn(), onDelta: vi.fn(), onDone: vi.fn(), onError,
  });
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'AI_UPSTREAM_FAILED' }));
});

it('turns a pre-stream HTTP failure into an ApiError', async () => {
  setTokens({
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token-which-is-long-enough',
    expiresIn: 900,
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ error: { code: 'AI_QUOTA_EXCEEDED', message: '额度已用尽' } }),
    { status: 429, headers: { 'content-type': 'application/json' } },
  )));
  await expect(streamAiChat('book-1', { action: 'ask', question: '为什么？' }, {
    onMeta: vi.fn(), onDelta: vi.fn(), onDone: vi.fn(), onError: vi.fn(),
  })).rejects.toMatchObject({ status: 429, code: 'AI_QUOTA_EXCEEDED' });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @bookr/web test -- ai.test stream.test`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `authorizedFetch`、SSE 解析与 API 封装**

`authorizedFetch` 与 `apiFetch` 共用 401 处理，改动后必须跑现有 `api/__tests__/client.test.ts`，确认刷新/登出行为不变。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @bookr/web test -- ai.test stream.test client.test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/api/client.ts apps/web/src/api/ai.ts apps/web/src/api/__tests__/ai.test.ts apps/web/src/features/reader/ai/stream.ts apps/web/src/features/reader/ai/__tests__/stream.test.ts
git commit -m "feat(web): add the AI API client and SSE parser"
```

---
### Task 11: AI 面板与对话状态

**Files:**
- Create: `apps/web/src/features/reader/ai/{useAiChat.ts,AiPanel.tsx,AiMessageList.tsx,AiThreadList.tsx,AiComposer.tsx}`
- Modify: `apps/web/src/features/reader/reader.css`
- Test: `apps/web/src/features/reader/ai/__tests__/{use-ai-chat.test.tsx,ai-panel.test.tsx}`

**Interfaces:**
- Consumes: Task 10 的 `api/ai.ts`、`streamAiChat`；`Ai*Dto`/`AiChatRequest`（`@bookr/shared`）；`ReaderContextScope`（`@bookr/reader-core`）
- Produces:

```ts
export interface AiContextSource {
  getTextContext(scope: ReaderContextScope): Promise<{ text: string; label: string }>;
  currentLocator(): Locator | null;
}
export interface AiApi {
  fetchThreads(bookId: string): Promise<AiThreadDto[]>;
  fetchThread(threadId: string): Promise<{ thread: AiThreadDto; messages: AiMessageDto[] }>;
  fetchUsage(): Promise<AiUsageDto>;
  deleteThread(threadId: string): Promise<void>;
  streamChat: typeof streamAiChat;
}
export type AiDisabledReason = 'offline' | 'disabled' | 'unconfigured' | 'quota' | null;
export interface AiChatController {
  threads: AiThreadDto[];
  activeThread: AiThreadDto | null;
  messages: AiMessageDto[];
  usage: AiUsageDto | null;
  loading: boolean;
  streaming: boolean;
  error: string | null;
  disabledReason: AiDisabledReason;
  canSend: boolean;
  openThread(threadId: string): Promise<void>;
  newThread(): void;
  explain(selection: { text: string; locator: Locator }): Promise<boolean>;
  summarize(scope: 'page' | 'chapter'): Promise<boolean>;
  ask(question: string, selection?: { text: string; locator: Locator }): Promise<boolean>;
  send(question: string): Promise<boolean>;
  stop(): void;
  retry(): Promise<boolean>;
  removeThread(threadId: string): Promise<void>;
  refreshUsage(): Promise<void>;
  dismissError(): void;
}
export interface UseAiChatOptions {
  bookId: string;
  offline: boolean;
  context: AiContextSource;
  api?: Partial<AiApi>;
}
export function useAiChat(options: UseAiChatOptions): AiChatController;

export interface AiPanelProps {
  controller: AiChatController;
  offline: boolean;
  onClose(): void;
  /** 选中「提问」后的引用；提交时随问题一起发送。 */
  pendingSelection?: { text: string; locator: Locator } | null;
  onClearPending?: () => void;
}
export function AiPanel(props: AiPanelProps): JSX.Element;
```

- Hook 行为：
  - `bookId === ''` 时不做任何请求（`loading = false`）。否则挂载时并行 `fetchThreads(bookId)` 与 `fetchUsage()`；线程按服务端顺序（最新在前），自动打开第一条；没有线程则展示空状态。`context`/`api`/`offline` 用 ref 保存，只有 `bookId` 变化才重新加载，避免 ReaderPage 每次重渲染都重新请求。
  - 加载失败：`usage` 读取失败时 `loading = false`、`canSend = false`，设置 `error = '无法读取 AI 状态，请稍后重试'`；线程列表读取失败只清空列表，不阻塞对话。
  - `disabledReason` 优先级：`offline` → `usage.enabled === false` → `usage.configured === false` → `daily.used + daily.reserved >= daily.limit` 或 monthly 同 → `null`。`usage === null` 时 `loading` 为真、`canSend` 为假。
  - `canSend = !streaming && !loading && disabledReason === null`。
  - `explain`：取 `context.getTextContext('page')`，发送 `{ action: 'explain', selectedText, locator, context: { pageText } }`；上下文获取失败时仍发送 `selectedText`（不阻断解释）。
  - `summarize`：取对应 scope 的文本，文本为空时设置 `error = '暂时无法获取本页文字，请稍后再试'` 并返回 false；否则发送 `{ action: 'summarize', scope, locator, context: { pageText | chapterText } }`。
  - `ask`：`selection` 存在时取本页文本、带上 `selectedText + locator`，并**新建线程**（不带 `threadId`）；没有 `selection` 时，若已有 `activeThread` 则作为追问带上 `threadId`，否则新建线程。
  - `send`：在 `activeThread` 中追问（`threadId` + `action: 'ask'` + `question` + 当前页文本）；无 active thread 时等同 `ask`。
  - 每次请求先把一条临时 user 消息与一条 `status: 'streaming'` 的临时 assistant 消息加入 `messages`；`meta` 到达时用服务端 id 替换临时 id 并记录 `activeThread`；`delta` 追加到 assistant 内容；`done` 更新 usage 的 daily/monthly、清空 `streaming`，再 `fetchThread` 刷新消息与线程列表；`error` 把 assistant 标记 `failed`、设置用户可读 `error`，再刷新；`AbortError` 表示用户停止：把 assistant 标记 `interrupted`，不显示错误，刷新。
  - 收到 `done` 返回 `true`；错误帧、协议错误、请求前失败返回 `false`（调用方保留输入框内容）；`AbortError` 表示用户主动停止，返回 `false`。
  - 如果请求在 `meta` 到达前就失败（未配置/额度/网络），移除两条临时消息，避免留下不存在的线程；问题原文仍由调用方保留在输入框。
  - `stop()` abort 当前请求；`retry()` 用最近一次请求体重发（同一线程，会新增一条用户消息）；`removeThread` 删除后从列表移除，若删的是 active 则打开下一条或清空。
  - 所有网络失败统一映射为中文（离线、额度、未配置、服务不可用、超时），不显示原始错误对象。

- 面板结构与文案：
  - 根节点 `<aside role="complementary" aria-label="AI 伴读">`；头部标题「AI 伴读」、按钮「新对话」「历史」「关闭」。
  - 工具条按钮「总结本页」「总结本章」；无 active thread 时也可用。
  - 线程列表：每条显示标题与 `updatedAt` 的本地日期；删除按钮第一次点击变为「确认删除？」，3 秒内第二次点击才调用 `removeThread`。
  - 消息：user 消息显示动作标签（解释/提问/总结）+ 可选引用块（`selectedText`）+ 内容；assistant 消息用 `white-space: pre-wrap` 展示纯文本；`status === 'interrupted'` 显示「已停止」，`failed` 显示「未完成」；流式时末尾显示闪烁光标（CSS 动画，`prefers-reduced-motion` 下关闭）。
  - 错误条 `role="alert"`，带「重试」与「关闭」；重试调用 `controller.retry()`。
  - 输入区：`textarea aria-label="向 AI 提问"`，Enter 发送、Shift+Enter 换行；发送按钮在 `canSend` 为假或输入为空时禁用；流式时显示「停止」。
  - 禁用提示映射：`offline` → 「离线时 AI 不可用，联网后自动恢复」；`disabled` → 「AI 伴读已在设置中关闭」；`unconfigured` → 「AI 尚未配置，请联系管理员」；`quota` → 「今日或本月额度已用尽，额度会按用户时区重置」。
  - 底部用量：「今日 1,234 / 100,000 tokens · 本月 12,345 / 1,000,000 tokens」；数值用 `toLocaleString('zh-CN')`。
  - 空状态：「选中一段文字点「解释」，或总结本页/本章」。
- CSS 追加到 `reader.css` 的「AI 面板」段：沿用 `.reader-panel` 的纸色/边框/阴影变量；`.ai-messages` 可滚动、`overflow-wrap: anywhere`；引用块左边框用 `var(--reader-accent)`；移动端宽度 `min(360px, 100vw)`。

- [ ] **Step 1: 写失败测试（hook）**

```tsx
import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { AiChatRequest, AiMessageDto, AiThreadDto, AiUsageDto } from '@bookr/shared';
import type { AiStreamHandlers } from '../../../api/ai';
import { useAiChat, type AiApi } from '../useAiChat';

const usage: AiUsageDto = {
  enabled: true, configured: true, fakeProvider: true, model: 'fake-chat',
  daily: { used: 0, reserved: 0, limit: 100_000 },
  monthly: { used: 0, reserved: 0, limit: 1_000_000 },
};
const thread: AiThreadDto = {
  id: 'thread-1', bookId: 'book-1', title: '解释一段话', anchorLocator: null,
  messageCount: 0, createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z',
};
const assistant: AiMessageDto = {
  id: 'assistant-1', threadId: 'thread-1', role: 'assistant', content: '回答',
  status: 'complete', action: null, selectedText: null, model: 'fake-chat',
  promptTokens: 3, completionTokens: 2, createdAt: '2026-10-19T00:00:00.000Z',
};

function apiWith(overrides: Partial<AiApi> = {}): AiApi {
  return {
    fetchThreads: vi.fn(async () => []),
    fetchThread: vi.fn(async () => ({
      thread,
      messages: [{ ...assistant, id: 'user-1', role: 'user', content: '问题' }, assistant],
    })),
    fetchUsage: vi.fn(async () => usage),
    deleteThread: vi.fn(async () => undefined),
    streamChat: vi.fn(async (_bookId: string, _body: AiChatRequest, handlers: AiStreamHandlers) => {
      handlers.onMeta({
        threadId: 'thread-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1',
        action: 'explain', model: 'fake-chat', promptVersion: 'p5.1',
      });
      handlers.onDelta('回答');
      handlers.onDone({
        assistantMessageId: 'assistant-1',
        usage: { promptTokens: 3, completionTokens: 2 },
        quota: {
          daily: { used: 5, reserved: 0, limit: 100_000 },
          monthly: { used: 5, reserved: 0, limit: 1_000_000 },
        },
      });
    }),
    ...overrides,
  };
}
```


const locator = { kind: 'pdf' as const, page: 2, percent: 0.2 };
const context = {
  getTextContext: vi.fn(async (scope: 'page' | 'chapter') => ({
    text: scope === 'page' ? '本页正文' : '本章正文',
    label: scope === 'page' ? '第 2 页' : '第一章',
  })),
  currentLocator: () => locator,
};

it('opens the latest thread and explains the selection with page context', async () => {
  const api = apiWith({ fetchThreads: vi.fn(async () => [thread]) });
  const { result } = renderHook(() => useAiChat({ bookId: 'book-1', offline: false, context, api }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  await waitFor(() => expect(api.fetchThread).toHaveBeenCalledWith('thread-1'));

  await act(async () => {
    await result.current.explain({ text: '选中文字', locator });
  });
  expect(api.streamChat).toHaveBeenCalledWith(
    'book-1',
    expect.objectContaining({
      action: 'explain',
      selectedText: '选中文字',
      locator,
      context: { pageText: '本页正文' },
    }),
    expect.anything(),
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  await waitFor(() => expect(result.current.usage?.daily.used).toBe(5));
  expect(result.current.error).toBeNull();
});

it('blocks sending when the account disabled AI or the quota is exhausted', async () => {
  const disabled = apiWith({
    fetchUsage: vi.fn(async () => ({ ...usage, enabled: false, daily: { ...usage.daily, used: 100_000 } })),
  });
  const disabledHook = renderHook(() => useAiChat({ bookId: 'book-1', offline: false, context, api: disabled }));
  await waitFor(() => expect(disabledHook.result.current.disabledReason).toBe('disabled'));
  await act(async () => {
    expect(await disabledHook.result.current.ask('问题')).toBe(false);
  });
  expect(disabled.streamChat).not.toHaveBeenCalled();

  const exhausted = apiWith({
    fetchUsage: vi.fn(async () => ({ ...usage, daily: { ...usage.daily, used: 100_000 } })),
  });
  const exhaustedHook = renderHook(() => useAiChat({ bookId: 'book-1', offline: false, context, api: exhausted }));
  await waitFor(() => expect(exhaustedHook.result.current.disabledReason).toBe('quota'));
  expect(exhaustedHook.result.current.canSend).toBe(false);
});
```


it('shows a friendly error and keeps the question available for retry', async () => {
  const api = apiWith({
    streamChat: vi.fn(async (_bookId: string, _body: AiChatRequest, handlers: AiStreamHandlers) => {
      handlers.onMeta({
        threadId: 'thread-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1',
        action: 'ask', model: 'fake-chat', promptVersion: 'p5.1',
      });
      handlers.onDelta('半句');
      handlers.onError({
        code: 'AI_UPSTREAM_FAILED', message: 'AI 服务暂时不可用，请稍后重试', retryable: true,
      });
    }),
    fetchThread: vi.fn(async () => ({
      thread,
      messages: [
        { ...assistant, id: 'user-1', role: 'user', content: '问题' },
        { ...assistant, status: 'failed', content: '半句' },
      ],
    })),
  });
  const { result } = renderHook(() => useAiChat({ bookId: 'book-1', offline: false, context, api }));
  await waitFor(() => expect(result.current.loading).toBe(false));

  await act(async () => {
    // 失败返回 false，输入框据此保留问题原文。
    expect(await result.current.ask('问题')).toBe(false);
  });
  expect(result.current.error).toContain('暂时不可用');
  await waitFor(() => expect(result.current.messages.at(-1)?.status).toBe('failed'));
  expect(result.current.canSend).toBe(true);
});

it('reports offline and aborts a running stream on stop', async () => {
  const offlineHook = renderHook(() => useAiChat({ bookId: 'book-1', offline: true, context, api: apiWith() }));
  await waitFor(() => expect(offlineHook.result.current.disabledReason).toBe('offline'));

  let captured: AbortSignal | undefined;
  const api = apiWith({
    streamChat: vi.fn((_bookId: string, _body: AiChatRequest, handlers: AiStreamHandlers, options?: { signal?: AbortSignal }) => {
      captured = options?.signal;
      handlers.onMeta({
        threadId: 'thread-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1',
        action: 'ask', model: 'fake-chat', promptVersion: 'p5.1',
      });
      return new Promise<void>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')));
      });
    }),
  });
  const { result } = renderHook(() => useAiChat({ bookId: 'book-1', offline: false, context, api }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  act(() => { void result.current.ask('问题'); });
  await waitFor(() => expect(result.current.streaming).toBe(true));
  act(() => result.current.stop());
  await waitFor(() => expect(captured?.aborted).toBe(true));
  await waitFor(() => expect(result.current.streaming).toBe(false));
});
```

- [ ] **Step 2: 写失败测试（面板）**

```tsx
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type { AiMessageDto } from '@bookr/shared';
import { AiPanel } from '../AiPanel';
import type { AiChatController } from '../useAiChat';

const messages: AiMessageDto[] = [
  {
    id: 'u1', threadId: 't1', role: 'user', content: '为什么要这样写？',
    status: 'complete', action: 'explain', selectedText: '程序由指令组成',
    model: null, promptTokens: 0, completionTokens: 0,
    createdAt: '2026-10-19T00:00:00.000Z',
  },
  {
    id: 'a1', threadId: 't1', role: 'assistant', content: '因为指令是执行单位。',
    status: 'complete', action: null, selectedText: null, model: 'fake-chat',
    promptTokens: 3, completionTokens: 5, createdAt: '2026-10-19T00:00:01.000Z',
  },
];

function controller(overrides: Partial<AiChatController> = {}): AiChatController {
  return {
    threads: [], activeThread: null, messages: [], usage: {
      enabled: true, configured: true, fakeProvider: true, model: 'fake-chat',
      daily: { used: 1_234, reserved: 0, limit: 100_000 },
      monthly: { used: 12_345, reserved: 0, limit: 1_000_000 },
    },
    loading: false, streaming: false, error: null, disabledReason: null, canSend: true,
    openThread: vi.fn(), newThread: vi.fn(), explain: vi.fn(async () => true),
    summarize: vi.fn(async () => true), ask: vi.fn(async () => true),
    send: vi.fn(async () => true), stop: vi.fn(), retry: vi.fn(async () => true),
    removeThread: vi.fn(), refreshUsage: vi.fn(), dismissError: vi.fn(),
    ...overrides,
  };
}

it('renders messages, the quote and usage, and sends a follow-up', async () => {
  const ask = vi.fn(async () => true);
  render(<AiPanel controller={controller({ messages, ask })} offline={false} onClose={vi.fn()} />);

  const panel = screen.getByRole('complementary', { name: 'AI 伴读' });
  expect(within(panel).getByText('程序由指令组成')).toBeInTheDocument();
  expect(within(panel).getByText('因为指令是执行单位。')).toBeInTheDocument();
  expect(within(panel).getByText(/今日 1,234 \/ 100,000/)).toBeInTheDocument();

  await userEvent.type(within(panel).getByLabelText('向 AI 提问'), '再展开一点{Enter}');
  expect(ask).toHaveBeenCalledWith('再展开一点');
});

it('offers summaries and explains disabled states', async () => {
  const summarize = vi.fn(async () => true);
  render(<AiPanel controller={controller({ summarize })} offline={false} onClose={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: '总结本页' }));
  expect(summarize).toHaveBeenCalledWith('page');
  await userEvent.click(screen.getByRole('button', { name: '总结本章' }));
  expect(summarize).toHaveBeenCalledWith('chapter');

  render(<AiPanel controller={controller({ disabledReason: 'offline', canSend: false })} offline onClose={vi.fn()} />);
  expect(screen.getByText('离线时 AI 不可用，联网后自动恢复')).toBeInTheDocument();
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @bookr/web test -- use-ai-chat ai-panel`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现 hook、组件与样式**

hook 中的临时消息 id 用 `temp-${Date.now()}-${Math.random()}`；服务端 `meta` 到达后替换。所有刷新失败不得清空已有消息。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @bookr/web test -- use-ai-chat ai-panel`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/features/reader/ai apps/web/src/features/reader/reader.css
git commit -m "feat(web): add the AI companion panel and chat state"
```

---
### Task 12: 阅读页集成（选中菜单、AI 面板、离线状态）

**Files:**
- Modify: `apps/web/src/features/reader/{ReaderPage,ReaderChrome,SelectionMenu}.tsx`
- Modify: `apps/web/src/features/reader/ai/AiPanel.tsx`（接收待提问选区）、`apps/web/test/setup.ts`
- Test: `apps/web/src/features/reader/__tests__/reader-ai.test.tsx`、`reader-controls.test.tsx`（追加）

**Interfaces:**
- Consumes: `useAiChat`/`AiPanel`（Task 11）、`ReaderEngine.getTextContext`（Task 9）、`AiApi`（Task 11）
- Produces:

```ts
// ReaderChrome.tsx
export type ReaderPanelName = 'toc' | 'settings' | 'annotations' | 'bookmarks' | 'ai';

// SelectionMenu.tsx
export interface SelectionMenuProps {
  // ...既有 props 不变
  onExplain: () => void;
  onSummarizePage: () => void;
  onAsk: () => void;
}

// AiPanel.tsx 追加 props
export interface AiPanelProps {
  controller: AiChatController;
  offline: boolean;
  onClose(): void;
  /** 选中「提问」后的引用；提交时随问题一起发送。 */
  pendingSelection?: { text: string; locator: Locator } | null;
  onClearPending?: () => void;
}

// ReaderPage.tsx
export interface ReaderPageProps {
  engineFactory?: (kind: ReaderEngineKind) => ReaderEngine;
  /** 测试注入的 AI API；生产使用默认实现。 */
  aiApi?: Partial<AiApi>;
}
```

- `ReaderChrome`：工具条新增「AI」按钮（`aria-pressed={activePanel === 'ai'}`），快捷键 `i`/`I` 切换；面板名加入 `'ai'`。
- `SelectionMenu`：在颜色与「写批注」之后加入「解释」「总结本页」「提问」三个按钮；点击后由 `ReaderPage` 关闭菜单（按钮本身只调用回调）。
- `ReaderPage`：
  - 监听 `window` 的 `online`/`offline` 事件维护 `online` 状态（与现有 `isOnline()` 一致：无 `navigator` 视为在线）。
  - `const ai = useAiChat({ bookId: bookId ?? '', offline: !online, context, api: aiApi })`；`context.getTextContext` 通过 `engineRef`/`currentLocatorRef` 读取，引擎未就绪时抛错由 hook 处理；`context.currentLocator()` 返回 `currentLocatorRef.current`。
  - 选中「解释」：`setSelection(null); setPanel('ai'); void ai.explain({ text: selection.text, locator: selection.locator })`。
  - 选中「总结本页」：`setSelection(null); setPanel('ai'); void ai.summarize('page')`。
  - 选中「提问」：`setSelection(null); setPanel('ai'); setPendingSelection({ text, locator })`；面板提交时调用 `async (question) => { const ok = await ai.ask(question, pendingSelection ?? undefined); if (ok) setPendingSelection(null); return ok; }`。
  - 工具条「AI」：`togglePanel('ai')`；面板关闭只隐藏，不中止流（流由页面级 hook 持有）。
  - 面板渲染：`panel === 'ai'` 时渲染 `<AiPanel controller={ai} offline={!online} onClose={() => setPanel(null)} pendingSelection={pendingSelection} onClearPending={() => setPendingSelection(null)} />`；切换书籍/账号时清空 `pendingSelection`。
  - 键盘快捷键：`i` 与现有 `t`/`n`/`b` 同一 switch，打开 AI 面板；`Escape` 先关面板的行为保持不变。
- `AiPanel`：
  - 有 `pendingSelection` 时在输入框上方显示引用块与「移除」按钮；提交文本后调用 `controller.ask(text, pendingSelection)`，成功才调用 `onClearPending`；关闭面板不丢 pendingSelection。
  - 解释/总结按钮触发的流即时显示；面板关闭再打开时仍能看到当前消息（来自页面级 hook）。

- [ ] **Step 1: 写失败测试**

```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { AiChatRequest, AiUsageDto } from '@bookr/shared';
import type { AiStreamHandlers } from '../../../api/ai';
import { setTokens } from '../../../api/client';
import { ReaderPage } from '../ReaderPage';
import { createFakeEngine } from './fake-engine';
import { createFakeSyncEngine, createMemoryRepository } from '../../../../test/memory-repository';
import { renderWithSync } from '../../../../test/sync-harness';

const usage: AiUsageDto = {
  enabled: true, configured: true, fakeProvider: true, model: 'fake-chat',
  daily: { used: 0, reserved: 0, limit: 100_000 },
  monthly: { used: 0, reserved: 0, limit: 1_000_000 },
};

function aiApi(streamChat = vi.fn(async (_bookId: string, _body: AiChatRequest, handlers: AiStreamHandlers) => {
  handlers.onMeta({
    threadId: 't1', userMessageId: 'u1', assistantMessageId: 'a1',
    action: 'explain', model: 'fake-chat', promptVersion: 'p5.1',
  });
  handlers.onDelta('这是解释。');
  handlers.onDone({
    assistantMessageId: 'a1',
    usage: { promptTokens: 3, completionTokens: 4 },
    quota: { daily: { used: 7, reserved: 0, limit: 100_000 }, monthly: usage.monthly },
  });
})) {
  return {
    fetchThreads: vi.fn(async () => []),
    fetchThread: vi.fn(async () => ({
      thread: {
        id: 't1', bookId: 'book-csapp', title: '解释', anchorLocator: null,
        messageCount: 2, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
      messages: [],
    })),
    fetchUsage: vi.fn(async () => usage),
    deleteThread: vi.fn(async () => undefined),
    streamChat,
  };
}

function renderReader(api = aiApi()) {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  const engine = createFakeEngine('pdf');
  const router = createMemoryRouter(
    [{ path: '/books/:id/read', element: <ReaderPage engineFactory={() => engine} aiApi={api} /> }],
    { initialEntries: ['/books/book-csapp/read'] },
  );
  renderWithSync(<RouterProvider router={router} />, {
    repo: createMemoryRepository(), engine: createFakeSyncEngine(),
  });
  return { engine, api };
}


it('explains a selection with the current page context', async () => {
  const { engine, api } = renderReader();
  await screen.findByRole('heading', { name: '深入理解计算机系统' });
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  engine.emit('selection', {
    text: '选中文字',
    locator: { kind: 'pdf', page: 2, percent: 0.2 },
    rect: { left: 10, top: 10, width: 100, height: 20 },
  });
  expect(screen.getByRole('button', { name: '总结本页' })).toBeInTheDocument();
  await userEvent.click(await screen.findByRole('button', { name: '解释' }));

  await waitFor(() => expect(api.streamChat).toHaveBeenCalled());
  expect(api.streamChat.mock.calls[0]![1]).toMatchObject({
    action: 'explain',
    selectedText: '选中文字',
    context: { pageText: '模拟本页正文' },
  });
  expect(await screen.findByRole('complementary', { name: 'AI 伴读' })).toBeInTheDocument();
});

it('asks a question about the selection from the panel composer', async () => {
  const { engine, api } = renderReader();
  await screen.findByRole('heading', { name: '深入理解计算机系统' });
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  engine.emit('selection', {
    text: '程序由指令组成',
    locator: { kind: 'pdf', page: 2, percent: 0.2 },
    rect: { left: 10, top: 10, width: 100, height: 20 },
  });
  await userEvent.click(await screen.findByRole('button', { name: '提问' }));
  const panel = await screen.findByRole('complementary', { name: 'AI 伴读' });
  expect(panel).toHaveTextContent('程序由指令组成');

  await userEvent.type(screen.getByLabelText('向 AI 提问'), '为什么？{Enter}');
  await waitFor(() => expect(api.streamChat).toHaveBeenCalled());
  expect(api.streamChat.mock.calls[0]![1]).toMatchObject({
    action: 'ask',
    question: '为什么？',
    selectedText: '程序由指令组成',
  });
});

it('shows the offline notice when the network drops', async () => {
  const { engine } = renderReader();
  await screen.findByRole('heading', { name: '深入理解计算机系统' });
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  window.dispatchEvent(new Event('offline'));
  await userEvent.click(screen.getByRole('button', { name: 'AI' }));

  expect(await screen.findByText('离线时 AI 不可用，联网后自动恢复')).toBeInTheDocument();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  window.dispatchEvent(new Event('online'));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @bookr/web test -- reader-ai`
Expected: FAIL（按钮/面板不存在）

- [ ] **Step 3: 实现菜单、快捷键、面板接入与在线状态**

`useAiChat` 增加 `bookId` 为空时跳过加载（测试与路由保护）；`SelectionMenu` 的「解释/提问」按钮沿用 `.reader-selection-action` 样式，不新增 CSS 依赖。`test/setup.ts` 补默认处理器：`GET /api/ai/usage` 返回 `enabled: true, configured: true` 的零用量，`GET /api/books/:id/ai/threads` 返回 `{ items: [] }`，否则既有 ReaderPage 测试会因 hook 的请求触发 MSW `onUnhandledRequest: 'error'`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @bookr/web test -- reader-ai reader-controls reader-page reader-annotations`
Expected: PASS（既有阅读测试不回归）

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/features/reader apps/web/src/features/reader/__tests__/reader-ai.test.tsx apps/web/src/features/reader/__tests__/reader-controls.test.tsx
git commit -m "feat(web): wire AI explain and ask into the reader"
```

---
### Task 13: 设置页 AI 区（开关、隐私说明、用量）

**Files:**
- Modify: `apps/web/src/app/auth.tsx`、`apps/web/src/features/settings/SettingsPage.tsx`
- Modify: `apps/web/test/setup.ts`（默认 `/api/ai/usage` 与 `PATCH /api/me/ai` 处理器）
- Test: `apps/web/src/features/settings/__tests__/settings.test.tsx`（追加）

**Interfaces:**
- Consumes: `fetchAiUsage`、`setAiEnabled`（Task 10）
- Produces:

```ts
// app/auth.tsx
export interface AuthContextValue {
  // ...既有字段不变
  /** Re-reads /api/auth/me and updates the cached profile. */
  refreshUser(): Promise<void>;
}
```

- `AuthProvider`：`refreshUser` 调 `fetchCurrentUser()`，成功后 `writeCachedUser` + `setUser`；失败原样抛出（由调用方决定是否提示），不清 token、不登出。
- `SettingsPage` 新增 `<section aria-labelledby="settings-ai-title">`：
  - 标题「AI 伴读」。
  - `useQuery({ queryKey: ['ai-usage'], queryFn: fetchAiUsage })`；加载中显示「正在读取 AI 状态…」；失败显示「无法读取 AI 状态，请稍后重试」。
  - 开关：`<input type="checkbox" aria-label="启用 AI 伴读" checked={usage.enabled} disabled={mutation.isPending || !usage.configured} onChange=...>`；调用 `setAiEnabled(next)`，成功后 `refreshUser()` 并 invalidate `['ai-usage']`，失败回滚并显示「AI 开关保存失败，请重试」。
  - 隐私说明（逐字）：「AI 请求只包含选中文字、当前页或本章的必要片段以及书名作者，不会发送整本书；服务商 Key 只保存在服务器。关闭后不会再发起任何 AI 请求。」
  - 配置/用量：
    - `configured === false` → 「AI 尚未配置，请联系管理员」。
    - `fakeProvider === true` → 「当前使用本地假提供方（仅用于测试）」。
    - 额度：`今日 {used} / {limit} tokens · 本月 {used} / {limit} tokens`；`used + reserved` 达到 `limit` 时追加「（额度已用尽）」。
  - 所有数字 `toLocaleString('zh-CN')`。
- `apps/web/test/setup.ts` 默认处理器：
  - `GET /api/ai/usage` → `{ enabled: true, configured: true, fakeProvider: false, model: 'deepseek-chat', daily: { used: 1000, reserved: 0, limit: 100000 }, monthly: { used: 5000, reserved: 0, limit: 1000000 } }`
  - `PATCH /api/me/ai` → 读取 body 返回 `{ enabled }`。

- [ ] **Step 1: 写失败测试（追加到 `settings.test.tsx`）**

```tsx
it('shows AI usage, the privacy note and saves the AI toggle', async () => {
  let enabled = true;
  const patched: boolean[] = [];
  server.use(
    http.get('/api/ai/usage', () =>
      HttpResponse.json({
        enabled,
        configured: true,
        fakeProvider: false,
        model: 'deepseek-chat',
        daily: { used: 1_000, reserved: 0, limit: 100_000 },
        monthly: { used: 5_000, reserved: 0, limit: 1_000_000 },
      }),
    ),
    http.patch('/api/me/ai', async ({ request }) => {
      const body = (await request.json()) as { enabled: boolean };
      patched.push(body.enabled);
      enabled = body.enabled;
      return HttpResponse.json({ enabled });
    }),
  );

  renderSettings(createEngine().engine);

  const section = await screen.findByRole('region', { name: 'AI 伴读' });
  expect(within(section).getByText(/今日 1,000 \/ 100,000 tokens/)).toBeInTheDocument();
  expect(within(section).getByText(/不会发送整本书/)).toBeInTheDocument();

  const toggle = within(section).getByRole('checkbox', { name: '启用 AI 伴读' });
  expect(toggle).toBeChecked();
  await userEvent.click(toggle);
  await waitFor(() => expect(patched).toEqual([false]));
  await waitFor(() => expect(toggle).not.toBeChecked());
});

it('explains when AI is not configured', async () => {
  server.use(
    http.get('/api/ai/usage', () =>
      HttpResponse.json({
        enabled: true,
        configured: false,
        fakeProvider: false,
        model: null,
        daily: { used: 0, reserved: 0, limit: 100_000 },
        monthly: { used: 0, reserved: 0, limit: 1_000_000 },
      }),
    ),
  );

  renderSettings(createEngine().engine);
  const section = await screen.findByRole('region', { name: 'AI 伴读' });
  expect(within(section).getByText('AI 尚未配置，请联系管理员')).toBeInTheDocument();
  expect(within(section).getByRole('checkbox', { name: '启用 AI 伴读' })).toBeDisabled();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @bookr/web test -- settings`
Expected: FAIL（AI 区不存在）

- [ ] **Step 3: 实现 `refreshUser` 与设置区，补默认 MSW 处理器**

开关只在服务端成功后才反映新值；失败时保持旧值并显示错误，避免界面与服务器不一致。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @bookr/web test -- settings auth`
Expected: PASS（既有设置/登录测试不回归）

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/app/auth.tsx apps/web/src/features/settings/SettingsPage.tsx apps/web/src/features/settings/__tests__/settings.test.tsx apps/web/test/setup.ts
git commit -m "feat(web): expose the AI toggle, usage and privacy note in settings"
```

---
### Task 14: 端到端验收（解释 / 追问 / 总结 / 离线 / 关闭）

**Files:**
- Create: `apps/web/e2e/ai.spec.ts`
- Modify: `apps/web/e2e/helpers.ts`（导出 `waitForPdfReady(page, needle = 'quick brown fox')`/`waitForPdfSpan`/`selectPdfText`）、`apps/web/e2e/sync.spec.ts`（改为从 helpers 导入，断言不变）
- Modify: `apps/web/e2e/global-setup.ts`（在注释中说明 AI fake provider 前提，不改断言）

**前置条件：** 目标 Compose 栈的 server 环境设置 `AI_FAKE_PROVIDER=1`（`.env` 中设置后 `docker compose up -d server`）。E2E 的 `beforeAll` 读取 `/api/ai/usage`，若 `fakeProvider !== true` 直接给出明确错误，避免误以为 AI 功能坏了。

**Interfaces:**
- Consumes: 现有 `adminAuth`/`registerFreshReader`/`uploadAndRename`/`openBook`/`readerAuth`/`revealChrome`/`deleteE2EBooks`；Task 12 的 UI 文案
- Produces: 5 个验收场景

- [ ] **Step 1: 写 E2E**

```ts
import { expect, test } from '@playwright/test';
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';
import {
  READER_PASSWORD, adminAuth, deleteE2EBooks, openBook, readerAuth,
  registerFreshReader, revealChrome, selectPdfText, uploadAndRename, waitForPdfReady,
} from './helpers';

const TITLE = '端到端 AI 伴读';
const FIXTURE = 'e2e/fixtures/reader.pdf';
const PHRASE = 'quick brown fox';
const FAKE_REPLY = '已收到上下文';

test.afterEach(async ({ request }) => {
  await deleteE2EBooks(request);
});

async function openAiPanel(page: Page): Promise<void> {
  await revealChrome(page);
  await page.getByRole('button', { name: 'AI' }).click();
  await expect(page.getByRole('complementary', { name: 'AI 伴读' })).toBeVisible();
}

async function expectFakeReply(page: Page): Promise<void> {
  await expect(page.getByText(FAKE_REPLY, { exact: false }).last()).toBeVisible({
    timeout: 20_000,
  });
}

async function threadCount(request: APIRequestContext, headers: Awaited<ReturnType<typeof readerAuth>>, bookId: string) {
  const response = await request.get(`/api/books/${bookId}/ai/threads`, { headers });
  expect(response.status()).toBe(200);
  return (await response.json()) as { items: Array<{ messageCount: number }> };
}
```

（真实文件追加测试主体；以下为必须覆盖的 5 个 `test(...)`。）

1. **选中解释**：注册新读者 → 上传 fixture 并重命名 → 打开书 → `waitForPdfReady` → `selectPdfText(page, PHRASE)` → 点「解释」→ 面板出现（若未自动出现，点「AI」）→ `expectFakeReply` → `readerAuth` 后 `GET /api/books/:id/ai/threads` 断言线程数 1 且 `messageCount === 2`。
2. **追问**：在上一场景的同一测试中继续（或独立测试重跑解释）→ 在「向 AI 提问」输入「再展开一点」并 Enter → 再 `expectFakeReply` 一次（等待第二条 assistant 文本）→ 服务端线程 `messageCount === 4`。
3. **总结本页**：打开书 → 点「AI」→ 点「总结本页」→ `expectFakeReply`；面板中出现「总结」标签的消息。
4. **离线**：打开书 → 打开 AI 面板 → `await context.setOffline(true)` → 断言「离线时 AI 不可用，联网后自动恢复」→ `await context.setOffline(false)`。
5. **关闭 AI**：打开 `/settings` → AI 区取消勾选「启用 AI 伴读」→ 返回书 → 打开 AI 面板 → 断言「AI 伴读已在设置中关闭」。

```ts
test.beforeAll(async ({ request }) => {
  const headers = await adminAuth(request);
  const usage = await request.get('/api/ai/usage', { headers });
  expect(usage.status()).toBe(200);
  expect(
    (await usage.json()).fakeProvider,
    'E2E requires AI_FAKE_PROVIDER=1 on the disposable stack (see README)',
  ).toBe(true);
});

test('explains a selection and keeps the thread for follow-ups', async ({ page, request, context }) => {
  const reader = await registerFreshReader(page, request);
  await uploadAndRename(page, FIXTURE, TITLE);
  const bookId = await openBook(page, TITLE);
  await waitForPdfReady(page, PHRASE);
  await selectPdfText(page, PHRASE);

  await page.getByRole('button', { name: '解释' }).click();
  await expect(page.getByRole('complementary', { name: 'AI 伴读' })).toBeVisible();
  await expectFakeReply(page);

  const headers = await readerAuth(request, reader.username, READER_PASSWORD);
  await expect
    .poll(async () => (await threadCount(request, headers, bookId)).items[0]?.messageCount, {
      timeout: 15_000,
    })
    .toBe(2);

  await page.getByLabel('向 AI 提问').fill('再展开一点');
  await page.getByLabel('向 AI 提问').press('Enter');
  await expect
    .poll(async () => (await threadCount(request, headers, bookId)).items[0]?.messageCount, {
      timeout: 20_000,
    })
    .toBe(4);
});

test('summarizes the current page', async ({ page, request }) => {
  await registerFreshReader(page, request);
  await uploadAndRename(page, FIXTURE, TITLE);
  await openBook(page, TITLE);
  await waitForPdfReady(page, PHRASE);
  await openAiPanel(page);
  await page.getByRole('button', { name: '总结本页' }).click();
  await expectFakeReply(page);
});

test('marks AI unavailable while offline', async ({ page, request, context }) => {
  await registerFreshReader(page, request);
  await uploadAndRename(page, FIXTURE, TITLE);
  await openBook(page, TITLE);
  await waitForPdfReady(page, PHRASE);
  await openAiPanel(page);
  await context.setOffline(true);
  await expect(page.getByText('离线时 AI 不可用，联网后自动恢复')).toBeVisible();
  await context.setOffline(false);
});

test('honours the settings toggle', async ({ page, request }) => {
  await registerFreshReader(page, request);
  await uploadAndRename(page, FIXTURE, TITLE);
  const bookId = await openBook(page, TITLE);
  await waitForPdfReady(page, PHRASE);

  await page.goto('/settings');
  const section = page.getByRole('region', { name: 'AI 伴读' });
  await section.getByRole('checkbox', { name: '启用 AI 伴读' }).uncheck();
  await expect(section.getByRole('checkbox', { name: '启用 AI 伴读' })).not.toBeChecked();

  await page.goto(`/books/${bookId}/read`);
  await waitForPdfReady(page, PHRASE);
  await openAiPanel(page);
  await expect(page.getByText('AI 伴读已在设置中关闭')).toBeVisible();
});
```

- [ ] **Step 2: 运行 E2E（仅本机 Compose，且已设 `AI_FAKE_PROVIDER=1`）**

Run: `docker compose up -d --build server web && pnpm --filter @bookr/web e2e -- ai.spec.ts`
Expected: 4 passed（解释+追问算一个测试）

- [ ] **Step 3: 全量回归**

Run: `pnpm --filter @bookr/web e2e`
Expected: 13 passed（原 9 + AI 4），无重试

- [ ] **Step 4: 提交**

```bash
git add apps/web/e2e/ai.spec.ts apps/web/e2e/helpers.ts apps/web/e2e/sync.spec.ts apps/web/e2e/global-setup.ts
git commit -m "test(e2e): cover AI explain, follow-up, summary, offline and opt-out"
```

---
### Task 15: 文档与路线图

**Files:**
- Modify: `README.md`、`docs/superpowers/plans/2026-10-18-00-roadmap.md`、本计划文件（勾选完成项）

**内容：**
- README 新增「AI 伴读」一节：
  - 部署配置：`.env` 中 `AI_API_KEY`（首次启动加密入库，确认入库后可将其从 `.env` 移除，数据库保留密文）、`AI_BASE_URL` 默认 `https://api.deepseek.com/v1`、`AI_CHAT_MODEL`/`AI_REASONER_MODEL`；也可登录管理员后通过 `PUT /api/admin/ai` 修改（示例 curl 用 `$ADMIN_TOKEN` 和 `$AI_KEY`，不写真实值）。
  - `AI_CONFIG_SECRET` 可选；缺省时从 `JWT_SECRET` 派生，轮换 `JWT_SECRET` 后需重新录入 Key。
  - 隐私边界：只发送选中文字、当前页/章片段、书名作者；不发送整本书；日志不记录正文；Key 永不下发浏览器；用户可在设置页关闭。
  - 配额：默认每日 100,000 / 每月 1,000,000 tokens，管理员可通过 `PATCH /api/admin/members/:id` 的 `aiDailyTokenLimit`/`aiMonthlyTokenLimit` 调整；窗口按用户时区计算。
  - `AI_FAKE_PROVIDER=1` **仅用于本地 E2E/演示**，生产严禁设置；启动日志会警告。
  - E2E 前置：在 `.env` 设置 `AI_FAKE_PROVIDER=1` 并重启 server，否则 `ai.spec.ts` 会在 `beforeAll` 明确失败。
  - 已知限制：离线不可用 AI；扫描版 PDF 无文字层时解释会明确说明材料不足；EPUB 的「本页」按当前章节文本处理；线程/消息是服务端权威数据，不进入同步变更日志；用户主动停止的回答按已发生的提示词用量计费。
- 环境变量表追加 AI 行；故障排查追加「AI 未配置」「额度用尽」「上游超时」的检查路径（`GET /api/ai/usage`、`GET /api/admin/ai`、server 日志只含 token 计数）。
- 路线图：05 行改为「已交付」，计划文件列表加入 `2026-10-18-05-ai-companion.md`（状态「已交付」）。
- 本计划：把已完成任务的 checkbox 勾上；在文件末尾追加「交付记录」，写明最终 HEAD、测试数量、E2E 结果与未覆盖事项（由执行者在验证后填写）。

- [ ] **Step 1: 更新 README 与路线图**
- [ ] **Step 2: 勾选本计划并填写交付记录（数字取自最终验证）**
- [ ] **Step 3: 提交**

```bash
git add README.md .env.example docs/superpowers/plans
git commit -m "docs: document the AI companion deployment and privacy model"
```

---

## 计划自检

- 规格覆盖：5.5 的全部能力（解释/总结/追问/线程/上下文预算/SSE/配额/隐私/失败处理）分别落在 Task 1、4、5、6、7、8、11、12、13；5.8 的管理员 AI 配置以 `PUT /api/admin/ai` 提供 API，管理界面留给 P8；笔记分析（5.5 第 4 项）按路线图属于 P6，本计划只预留 `reasonerModel` 配置。
- AI 线程/消息不进入 P4 同步日志：它们是服务端权威且只能在线产生；跨设备通过 REST 读取。P6 若需要离线查看再扩展同步实体。
- 类型一致性：`AiChatRequest`/`AiThreadDto`/`AiMessageDto`/`AiUsageDto`/`AiStream*` 全部来自 `@bookr/shared`；`AiClient`/`AiRuntimeConfig`/`QuotaSnapshot` 只在服务端内部；Web 侧 `AiApi` 注入与生产 API 同名。
- Review Focus 的每条都有对应测试：Key/正文不泄漏（Task 3、8）、配额并发（Task 6）、客户端断开（Task 8）、上下文真实性（Task 4、8、12）、失败可恢复（Task 8、11）。
