# 管理、备份与发布（P8）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 按任务逐项实现。步骤用复选框（`- [ ]`）跟踪。

**Goal:** 把前七阶段做出来的系统真正交付出去：管理后台补齐系统设置（注册开关、默认时区、AI 服务商）、审计日志与备份状态；备份机与服务器导出脚本把心跳上报到服务端，服务端在备份失败、备份机静默、磁盘不足时通过 Webhook 告警（可去重、可恢复）；新增深度健康检查 `/readyz` 与恢复演练脚本；Web 可安装为 PWA；桌面与 Android 有可复现的发布配置与版本一致性检查；最后用验收清单和端到端测试封板。

**Architecture:** 管理数据写入三张新表：`system_settings`（单行）、`backup_reports`（心跳记录）、`monitor_states`（告警状态机）与 `alert_events`（告警投递记录）。备份脚本在服务器主机与备份 PC 上运行，通过 `X-Backup-Token` 或管理员 JWT 调用 `POST /api/admin/backup/heartbeat`；服务端内嵌一个 5 分钟一次的监控循环，把「连续未成功 / 备份机静默 / 磁盘低 / 最近失败」翻译成 Webhook 告警，用状态表实现「进入异常发一次、同异常 24 小时内不重复、恢复后再次异常重新发」。管理后台全部走现有 `/api/admin/*` 鉴权，Web 端新增设置、审计、备份三个页面。发布侧不重写任何运行时：PWA 用清单与图标补齐可安装性，Tauri/Capacitor 只补发布签名、版本对齐与构建脚本。

**Tech Stack:** TypeScript strict、Fastify 5、PostgreSQL 16 + Drizzle、Zod 4、React 19 + TanStack Query、Vitest、MSW、Playwright、Bash、PowerShell（一次性生成 PWA 图标）、Tauri 2、Capacitor 7 / Gradle。

**Spec:** `docs/superpowers/specs/2026-10-18-private-book-reader-design.md`（5.8 管理后台、11 部署与运维、12 安全与隐私、13 验收标准 8/9）

## Global Constraints

- TypeScript strict，禁止 `any`；共享契约（`packages/shared`）先于使用方定义。
- 所有管理接口必须 `requireAuth + requireAdmin`；成员访问一律 403；未登录 401。
- 备份心跳接口是唯一例外：允许 `X-Backup-Token`（服务端 `BACKUP_TOKEN`，至少 32 字符，常数时间比较）或管理员 JWT；两者都不满足时 401，且绝不在响应里透露 token 是否正确存在。
- 日志与告警内容不得包含书籍正文、笔记内容、AI Key、备份 token；告警只发状态与计数。
- 数据库迁移随发布执行；新增表必须同时更新迁移文件与 drizzle meta。
- 注册开关只影响新注册：关闭后即使持有有效邀请码也不能创建账号；已登录用户不受影响。默认时区只作用于新注册用户，修改不回算已有用户。
- 告警去重语义：同一异常在持续期间 24 小时内最多发一次；异常恢复后再次发生必须重新告警。
- PWA 图标必须是真实 PNG（正确尺寸与 PNG 签名），maskable 图标内容位于中心 80% 安全区。
- 原生发布不新增 npm 运行时依赖；Android 发布签名材料（`keystore.properties`、`*.jks`）不得入库。
- E2E 是破坏性测试：只允许 localhost；`E2E_ALLOW_REMOTE=1` 仅用于一次性测试环境，绝不能对生产运行。
- 并发执行的服务端测试各自使用独立的 `TEST_DATABASE_URL`，避免共享 `bookr_test` 时的 TRUNCATE 竞争。
- 每个任务结束必须 `pnpm exec turbo run typecheck test` 通过并提交。

## Review Focus

- **注册开关竞态**：关闭注册后，同时到达的两个有效邀请码注册请求都不能创建账号；开关读取与用户插入必须在同一事务语义下保持一致，错误信息明确（“注册暂未开放”）。
- **心跳认证**：错误/缺失 `X-Backup-Token` 不得写库；token 比较必须常数时间；未配置 `BACKUP_TOKEN` 时该通道关闭，但管理员 JWT 仍可用。
- **告警状态机**：同一异常持续期间 24 小时内只发一次；恢复后再次异常必须重新发；Webhook 投递失败要记录并允许下一轮重试，不能吞掉。
- **备份静默判定**：服务器导出成功但备份 PC 24 小时无上报，仍要告警；两个来源互不掩盖；服务器尚未产生任何成功备份时也要提示。
- **管理页 360px**：成员、设置、审计、备份四个页面在 360px 宽度下不横向滚动，表格改为可读的堆叠布局或安全横向滚动容器；危险开关有明确文案与二次确认。

---

## 文件结构

**共享**
- 创建 `packages/shared/src/admin.ts`、`packages/shared/src/__tests__/admin.test.ts`
- 修改 `packages/shared/src/index.ts`

**服务端**
- 修改 `apps/server/src/db/schema.ts`、新增 `apps/server/drizzle/0008_admin_backup.sql` 与 `drizzle/meta/*`
- 创建 `apps/server/src/settings/service.ts`、`apps/server/src/audit/service.ts`
- 创建 `apps/server/src/backup/{repo,service,routes}.ts`
- 创建 `apps/server/src/monitor/{check,notify,loop}.ts`
- 修改 `apps/server/src/admin/{routes,service}.ts`、`apps/server/src/auth/service.ts`
- 修改 `apps/server/src/config.ts`、`apps/server/src/app.ts`、`apps/server/src/server.ts`
- 创建 `apps/server/test/{admin-backup-schema,system-settings,audit-log,backup-heartbeat,monitor-alerts,readyz}.test.ts`
- 修改 `apps/server/test/{admin.test.ts,config.test.ts}`

**Web**
- 修改 `apps/web/src/api/admin.ts`、`apps/web/src/features/admin/MembersPage.tsx`
- 创建 `apps/web/src/features/admin/{AdminTabs,AdminSettingsPage,AuditPage,BackupsPage}.tsx`
- 创建 `apps/web/src/features/admin/__tests__/{admin-settings,admin-audit,admin-backups}.test.tsx`
- 修改 `apps/web/src/app/router.tsx`、`apps/web/test/setup.ts`
- 修改 `apps/web/index.html`，创建 `apps/web/public/manifest.webmanifest`、`apps/web/public/icons/*.png`
- 创建 `apps/web/test/pwa-manifest.test.ts`、`scripts/generate-pwa-icons.ps1`

**发布与运维**
- 创建 `scripts/check-native-config.mjs`、`scripts/build-android.sh`、`scripts/build-desktop.sh`
- 修改 `apps/mobile/android/app/build.gradle`、`apps/mobile/android/.gitignore`、`apps/desktop/src-tauri/tauri.conf.json`
- 创建 `apps/mobile/android/keystore.properties.example`
- 创建 `scripts/lib/heartbeat.sh`、`scripts/restore-drill.sh`
- 修改 `scripts/{backup-export.sh,pull-backup.sh}`
- 修改 `.github/workflows/ci.yml`、`package.json`（`check:native`）
- 创建 `docs/operations/{native-builds,acceptance-checklist}.md`

**E2E / 文档**
- 创建 `apps/web/e2e/{admin,pwa}.spec.ts`
- 修改 `README.md`、`docs/superpowers/plans/2026-10-18-00-roadmap.md`

---

## 任务依赖与并发波次

同一波次内任务的文件互不重叠，可以并发执行；不同波次必须等前一波全部通过审查。

1. 波次 1（并发）：Task 1（共享契约）、Task 2（数据库迁移）
2. 波次 2（并发）：Task 3（设置/审计/存储榜服务端）、Task 5（PWA）、Task 6（原生发布配置）、Task 7（备份脚本与演练）
3. 波次 3（并发）：Task 4（备份心跳/告警/健康检查服务端）、Task 8（管理后台 Web）
4. 波次 4：Task 9（E2E、验收清单、文档与交付记录）

服务端并发任务（Task 3、Task 4）在验证时分别使用
`TEST_DATABASE_URL=postgres://bookr:bookr@localhost:5432/bookr_admin_settings_test` 与
`.../bookr_admin_backup_test`（测试进程会自行迁移）；Task 2 使用 `.../bookr_admin_schema_test`。
控制器负责先创建这三个空库。

---

### Task 1: 共享管理契约

**Files:**
- Create: `packages/shared/src/admin.ts`
- Create: `packages/shared/src/__tests__/admin.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `z`（zod 4）、`isValidTimeZone`（`./stats`）
- Produces（后续任务逐字使用）:

```ts
// packages/shared/src/admin.ts
export const DEFAULT_USER_TIMEZONE = 'Asia/Shanghai';
export const BACKUP_STALE_HOURS = 24;
export const BACKUP_REPORTS_LIMIT = 20;
export const ALERT_EVENTS_LIMIT = 10;

export interface SystemSettingsDto {
  registrationEnabled: boolean;
  defaultTimezone: string;
  updatedAt: string | null;
}

export const updateSystemSettingsSchema: z.ZodType<UpdateSystemSettingsInput>;
export interface UpdateSystemSettingsInput {
  registrationEnabled?: boolean;
  defaultTimezone?: string;
}
// 规则：至少一个字段；`.strict()` 拒绝未知字段；timezone 去空白后 1..64 且 isValidTimeZone。

export interface AuditLogEntryDto {
  id: string;
  userId: string | null;
  displayName: string | null;
  action: string;
  target: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}
export interface AuditLogPageDto {
  items: AuditLogEntryDto[];
  page: number;
  pageSize: number;
  total: number;
}

export interface AdminStorageOverviewDto {
  totalBytes: number;
  usedBytes: number;
  perMember: Array<{ userId: string; displayName: string; usedBytes: number }>;
  topBooks: Array<{ id: string; title: string; sizeBytes: number }>;
}

export const BACKUP_SOURCES = ['server-export', 'backup-pc'] as const;
export type BackupSource = (typeof BACKUP_SOURCES)[number];
export const BACKUP_REPORT_STATUSES = ['success', 'failure'] as const;
export type BackupReportStatus = (typeof BACKUP_REPORT_STATUSES)[number];

export const backupHeartbeatSchema: z.ZodType<BackupHeartbeatInput>;
export interface BackupHeartbeatInput {
  source: BackupSource;
  status: BackupReportStatus;
  startedAt: string;   // ISO 8601，必须带时区偏移
  finishedAt: string;
  bytes?: number;
  diskFreeBytes?: number;
  diskTotalBytes?: number;
  message?: string;
}

export interface BackupReportDto {
  id: string;
  source: BackupSource;
  status: BackupReportStatus;
  startedAt: string;
  finishedAt: string;
  bytes: number | null;
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
  message: string | null;
  receivedAt: string;
}

export interface AlertEventDto {
  id: string;
  key: string;
  severity: 'warning' | 'critical';
  message: string;
  sentAt: string;
  status: 'sent' | 'failed';
  error: string | null;
}

export interface BackupStatusDto {
  lastSuccessAt: string | null;
  lastServerExportAt: string | null;
  lastBackupPcAt: string | null;
  backupStale: boolean;
  backupPcSilent: boolean;
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
  diskLow: boolean;
  reports: BackupReportDto[];
  alerts: AlertEventDto[];
}
```

`backupHeartbeatSchema` 规则：`z.iso.datetime({ offset: true })`；`bytes`/`diskFreeBytes`/`diskTotalBytes` 为非负安全整数；`message` 去空白后最长 1000；`finishedAt ≥ startedAt`；两者都给出时 `diskFreeBytes ≤ diskTotalBytes`；用 `superRefine` 实现跨字段校验。

- [ ] **Step 1: 写失败测试**

创建 `packages/shared/src/__tests__/admin.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  BACKUP_STALE_HOURS,
  backupHeartbeatSchema,
  updateSystemSettingsSchema,
} from '../admin';

describe('updateSystemSettingsSchema', () => {
  it('接受单个字段并去除时区空白', () => {
    expect(updateSystemSettingsSchema.parse({ defaultTimezone: ' America/New_York ' }))
      .toEqual({ defaultTimezone: 'America/New_York' });
    expect(updateSystemSettingsSchema.parse({ registrationEnabled: false }))
      .toEqual({ registrationEnabled: false });
  });
  it('拒绝空对象、未知字段与非法时区', () => {
    expect(updateSystemSettingsSchema.safeParse({}).success).toBe(false);
    expect(updateSystemSettingsSchema.safeParse({ registration: false }).success).toBe(false);
    for (const defaultTimezone of ['', '   ', 'Mars/Olympus', 'x'.repeat(65)]) {
      expect(updateSystemSettingsSchema.safeParse({ defaultTimezone }).success).toBe(false);
    }
  });
});

describe('backupHeartbeatSchema', () => {
  const base = {
    source: 'server-export',
    status: 'success',
    startedAt: '2026-10-19T03:15:00+08:00',
    finishedAt: '2026-10-19T03:21:00+08:00',
  };
  it('接受带偏移的时间与可选容量字段', () => {
    expect(backupHeartbeatSchema.parse({
      ...base,
      bytes: 1024,
      diskFreeBytes: 500,
      diskTotalBytes: 1000,
      message: ' ok ',
    })).toMatchObject({ bytes: 1024, message: 'ok' });
  });
  it('拒绝倒序时间、负数与空闲大于总量', () => {
    expect(backupHeartbeatSchema.safeParse({
      ...base,
      startedAt: '2026-10-19T04:00:00+08:00',
      finishedAt: '2026-10-19T03:00:00+08:00',
    }).success).toBe(false);
    expect(backupHeartbeatSchema.safeParse({ ...base, bytes: -1 }).success).toBe(false);
    expect(backupHeartbeatSchema.safeParse({
      ...base,
      diskFreeBytes: 2,
      diskTotalBytes: 1,
    }).success).toBe(false);
    expect(backupHeartbeatSchema.safeParse({ ...base, source: 'usb' }).success).toBe(false);
    expect(backupHeartbeatSchema.safeParse({ ...base, status: 'partial' }).success).toBe(false);
  });
  it('要求带时区偏移', () => {
    expect(backupHeartbeatSchema.safeParse({
      ...base,
      startedAt: '2026-10-19T03:15:00',
      finishedAt: '2026-10-19T03:21:00',
    }).success).toBe(false);
  });
  it('24 小时是固定的过期阈值', () => {
    expect(BACKUP_STALE_HOURS).toBe(24);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @bookr/shared test -- admin`
Expected: FAIL，提示找不到 `../admin`。

- [ ] **Step 3: 实现契约**

按 Interfaces 实现 `packages/shared/src/admin.ts`；在 `packages/shared/src/index.ts` 末尾加 `export * from './admin';`。schema 使用 `.strict()` 与 `superRefine`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @bookr/shared test -- admin`
Expected: PASS。

- [ ] **Step 5: 全仓类型检查**

Run: `pnpm exec turbo run typecheck --filter=@bookr/shared`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/shared
git commit -m "feat(shared): add admin, audit and backup contracts"
```

---

### Task 2: 管理数据表与迁移

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Create: `apps/server/drizzle/0008_admin_backup.sql`、`apps/server/drizzle/meta/0008_snapshot.json`、更新 `apps/server/drizzle/meta/_journal.json`
- Test: `apps/server/test/admin-backup-schema.test.ts`

**Interfaces:**
- Consumes: `newId`、现有 `users` 表、`createdAt()` 辅助
- Produces: 以下 Drizzle 表（后续任务逐字使用字段名）

```ts
export const systemSettings = pgTable('system_settings', {
  id: text('id').primaryKey(),                       // 固定为 'global'
  registrationEnabled: boolean('registration_enabled').notNull().default(true),
  defaultTimezone: text('default_timezone').notNull().default('Asia/Shanghai'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
});

export const backupReports = pgTable('backup_reports', {
  id: uuid('id').primaryKey().$defaultFn(newId),
  source: text('source').notNull(),                  // server-export | backup-pc
  status: text('status').notNull(),                  // success | failure
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }).notNull(),
  bytes: bigint('bytes', { mode: 'number' }),
  diskFreeBytes: bigint('disk_free_bytes', { mode: 'number' }),
  diskTotalBytes: bigint('disk_total_bytes', { mode: 'number' }),
  message: text('message'),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('backup_reports_received_idx').on(table.receivedAt),
  index('backup_reports_source_received_idx').on(table.source, table.receivedAt),
]);

export const monitorStates = pgTable('monitor_states', {
  key: text('key').primaryKey(),                     // backup-stale | backup-pc-silent | disk-low | backup-failure
  active: boolean('active').notNull().default(false),
  lastAlertAt: timestamp('last_alert_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const alertEvents = pgTable('alert_events', {
  id: uuid('id').primaryKey().$defaultFn(newId),
  key: text('key').notNull(),
  severity: text('severity').notNull(),              // warning | critical
  message: text('message').notNull(),
  status: text('status').notNull(),                  // sent | failed
  error: text('error'),
  sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('alert_events_key_sent_idx').on(table.key, table.sentAt)]);
```

- [ ] **Step 1: 写失败测试**

创建 `apps/server/test/admin-backup-schema.test.ts`：

```ts
import { newId } from '@bookr/shared';
import { eq } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import {
  alertEvents, backupReports, monitorStates, systemSettings,
} from '../src/db/schema';
import { resetDb, testDb } from './helpers';

const NOW = new Date('2026-10-19T04:00:00.000Z');

beforeEach(async () => {
  await resetDb();
});

it('system settings default to open registration and Shanghai', async () => {
  await testDb.insert(systemSettings).values({ id: 'global' });
  const [row] = await testDb.select().from(systemSettings).where(eq(systemSettings.id, 'global'));
  expect(row).toMatchObject({ registrationEnabled: true, defaultTimezone: 'Asia/Shanghai' });
});

it('stores backup reports with nullable capacity and a received timestamp', async () => {
  const id = newId();
  await testDb.insert(backupReports).values({
    id,
    source: 'server-export',
    status: 'success',
    startedAt: NOW,
    finishedAt: NOW,
    bytes: 1024,
    diskFreeBytes: 500,
    diskTotalBytes: 1000,
  });
  const [row] = await testDb.select().from(backupReports).where(eq(backupReports.id, id));
  expect(row).toMatchObject({ source: 'server-export', status: 'success', bytes: 1024 });
  expect(row?.receivedAt).toBeInstanceOf(Date);
});

it('tracks monitor state and alert deliveries', async () => {
  await testDb.insert(monitorStates).values({ key: 'backup-stale', active: true, lastAlertAt: NOW });
  await testDb.insert(alertEvents).values({
    id: newId(), key: 'backup-stale', severity: 'critical',
    message: '备份 24 小时未成功', status: 'failed', error: 'ECONNREFUSED',
  });
  const [state] = await testDb.select().from(monitorStates);
  const [event] = await testDb.select().from(alertEvents);
  expect(state).toMatchObject({ key: 'backup-stale', active: true });
  expect(event).toMatchObject({ status: 'failed', error: 'ECONNREFUSED' });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `TEST_DATABASE_URL=postgres://bookr:bookr@localhost:5432/bookr_admin_schema_test pnpm --filter @bookr/server test -- admin-backup-schema`
Expected: FAIL，表不存在或导出缺失。

- [ ] **Step 3: 实现 schema 与迁移**

在 `db/schema.ts` 追加四张表；替换 `import { ... }` 中的类型（`bigint`、`boolean` 已在用则复用）。执行：

```bash
cd apps/server && pnpm exec drizzle-kit generate --name admin_backup
```

检查生成的 `0008_admin_backup.sql` 含四张表与索引，meta journal 追加 0008。

- [ ] **Step 4: 运行测试确认通过**

Run: `TEST_DATABASE_URL=postgres://bookr:bookr@localhost:5432/bookr_admin_schema_test pnpm --filter @bookr/server test -- admin-backup-schema`
Expected: PASS（测试会自行迁移）。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/db/schema.ts apps/server/drizzle apps/server/test/admin-backup-schema.test.ts
git commit -m "feat(server): add admin settings, backup and alert tables"
```

---

### Task 3: 系统设置、审计日志与存储榜（服务端）

**Files:**
- Create: `apps/server/src/settings/service.ts`
- Create: `apps/server/src/audit/service.ts`
- Modify: `apps/server/src/admin/routes.ts`
- Modify: `apps/server/src/admin/service.ts`（`storageOverview` 增加 `topBooks`）
- Modify: `apps/server/src/auth/service.ts`（注册开关与默认时区）
- Test: `apps/server/test/system-settings.test.ts`
- Test: `apps/server/test/audit-log.test.ts`
- Modify: `apps/server/test/admin.test.ts`（存储 Top 榜）

**Interfaces:**
- Consumes: `SystemSettingsDto`、`UpdateSystemSettingsInput`、`updateSystemSettingsSchema`、`AuditLogEntryDto`、`AuditLogPageDto`、`AdminStorageOverviewDto`（Task 1）；`systemSettings`、`auditLogs`、`users`、`books`（Task 2 / 现有）
- Produces:

```ts
// apps/server/src/settings/service.ts
export const SYSTEM_SETTINGS_ID = 'global';
export const DEFAULT_SYSTEM_SETTINGS: SystemSettingsDto; // registrationEnabled: true, defaultTimezone: 'Asia/Shanghai', updatedAt: null
export async function readSystemSettings(
  db: Database | Transaction,
): Promise<{ registrationEnabled: boolean; defaultTimezone: string; updatedAt: Date | null }>;
export async function updateSystemSettings(
  deps: AppDeps, adminId: string, patch: UpdateSystemSettingsInput,
): Promise<SystemSettingsDto>;

// apps/server/src/audit/service.ts
export interface AuditLogQuery { page: number; pageSize: number }
export async function listAuditEntries(deps: AppDeps, query: AuditLogQuery): Promise<AuditLogPageDto>;

// apps/server/src/admin/service.ts
export interface StorageOverview {
  totalBytes: number;
  usedBytes: number;
  perMember: Array<{ userId: string; displayName: string; usedBytes: number }>;
  topBooks: Array<{ id: string; title: string; sizeBytes: number }>;
}
```

HTTP：
- `GET /api/admin/settings` → `SystemSettingsDto`
- `PATCH /api/admin/settings` → `SystemSettingsDto`
- `GET /api/admin/audit?page=1&pageSize=30` → `AuditLogPageDto`（`pageSize` 1..100，默认 30）

行为：
- `readSystemSettings` 无行时返回默认值（不写库）；`updateSystemSettings` 在一个事务里 upsert `id='global'`、写 `updatedBy`/`updatedAt`，并插入审计 `action='admin.settings.update'`、`metadata={ changes: patch }`。
- `listAuditEntries` 按 `createdAt DESC, id DESC` 排序，左连接 `users` 取 `displayName`；`total` 用 `count(*)`；`metadata` 原样返回。
- 注册：`registerUser` 在打开事务后、锁邀请码前读取设置；`registrationEnabled === false` 时抛 `AppError(403, ERROR_CODES.FORBIDDEN)`，消息“注册暂未开放”。新用户插入时显式写 `timezone: settings.defaultTimezone`（不再依赖列默认值）。
- 存储 Top 榜：`books` 中 `deletedAt IS NULL` 按 `books.size DESC, createdAt ASC` 取前 10，字段 `{ id, title, sizeBytes: books.size }`（Drizzle 列名 `size` 对应 `original_size`）；bigint 转安全整数。

- [ ] **Step 1: 写失败测试（设置）**

创建 `apps/server/test/system-settings.test.ts`：

```ts
import { newId } from '@bookr/shared';
import { eq } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { auditLogs, invites, users } from '../src/db/schema';
import { authHeader, buildTestApp, resetDb, seedUser, testDb, type SeededUser } from './helpers';

let app: FastifyInstance;
let admin: SeededUser;

beforeEach(async () => {
  await resetDb();
  app = await buildTestApp();
  admin = await seedUser('admin');
});

it('returns defaults before anything is stored', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/admin/settings', headers: await authHeader(admin) });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    registrationEnabled: true,
    defaultTimezone: 'Asia/Shanghai',
    updatedAt: null,
  });
});

it('patches, persists and audits one setting', async () => {
  const response = await app.inject({
    method: 'PATCH', url: '/api/admin/settings', headers: await authHeader(admin),
    payload: { registrationEnabled: false, defaultTimezone: ' Europe/Berlin ' },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ registrationEnabled: false, defaultTimezone: 'Europe/Berlin' });
  const audit = await testDb.select().from(auditLogs).where(eq(auditLogs.action, 'admin.settings.update'));
  expect(audit).toHaveLength(1);
  expect(audit[0]?.metadata).toEqual({ changes: { registrationEnabled: false, defaultTimezone: 'Europe/Berlin' } });
});

it('rejects invalid input and members', async () => {
  const member = await seedUser('member');
  for (const payload of [{}, { defaultTimezone: 'Mars/Olympus' }, { registration: false }]) {
    const response = await app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: await authHeader(admin), payload });
    expect(response.statusCode, JSON.stringify(payload)).toBe(400);
  }
  const denied = await app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: await authHeader(member), payload: { registrationEnabled: false } });
  expect(denied.statusCode).toBe(403);
});

it('blocks registration while disabled and applies the default timezone when enabled', async () => {
  await app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: await authHeader(admin), payload: { registrationEnabled: false } });
  await testDb.insert(invites).values({
    code: 'ABCDEFGHJK', createdBy: admin.id, expiresAt: new Date(Date.now() + 3_600_000),
  });
  const blocked = await app.inject({
    method: 'POST', url: '/api/auth/register',
    payload: { inviteCode: 'ABCDEFGHJK', username: 'blocked', password: 'a-long-password', displayName: '被拒' },
  });
  expect(blocked.statusCode).toBe(403);
  expect((await testDb.select().from(users)).some((row) => row.username === 'blocked')).toBe(false);

  await app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: await authHeader(admin), payload: { registrationEnabled: true, defaultTimezone: 'America/New_York' } });
  const created = await app.inject({
    method: 'POST', url: '/api/auth/register',
    payload: { inviteCode: 'ABCDEFGHJK', username: 'newbie', password: 'a-long-password', displayName: '新人' },
  });
  expect(created.statusCode).toBe(201);
  const [row] = await testDb.select().from(users).where(eq(users.username, 'newbie'));
  expect(row?.timezone).toBe('America/New_York');
});
```

- [ ] **Step 2: 写失败测试（审计与存储榜）**

创建 `apps/server/test/audit-log.test.ts`：

```ts
import { beforeEach, expect, it } from 'vitest';
import { auditLogs } from '../src/db/schema';
import { authHeader, buildTestApp, resetDb, seedUser, testDb } from './helpers';

beforeEach(async () => {
  await resetDb();
});

it('lists newest first with a joined member name and pagination total', async () => {
  const app = await buildTestApp();
  const admin = await seedUser('admin');
  const member = await seedUser('member');
  const base = Date.parse('2026-10-19T00:00:00.000Z');
  for (let index = 0; index < 25; index += 1) {
    await testDb.insert(auditLogs).values({
      userId: member.id,
      action: 'book.delete',
      target: `book-${index}`,
      createdAt: new Date(base + index * 1_000),
    });
  }
  await testDb.insert(auditLogs).values({ userId: null, action: 'auth.login', target: null });

  const first = await app.inject({ method: 'GET', url: '/api/admin/audit?page=1&pageSize=20', headers: await authHeader(admin) });
  expect(first.statusCode).toBe(200);
  const page = first.json();
  expect(page).toMatchObject({ page: 1, pageSize: 20, total: 26 });
  expect(page.items).toHaveLength(20);
  expect(page.items[0]?.action).toBe('auth.login');
  expect(page.items[1]).toMatchObject({ displayName: member.displayName, action: 'book.delete' });
  const second = await app.inject({ method: 'GET', url: '/api/admin/audit?page=2&pageSize=20', headers: await authHeader(admin) });
  expect(second.json().items).toHaveLength(6);
});

it('rejects members and invalid pagination', async () => {
  const app = await buildTestApp();
  const member = await seedUser('member');
  expect((await app.inject({ method: 'GET', url: '/api/admin/audit', headers: await authHeader(member) })).statusCode).toBe(403);
  const admin = await seedUser('admin');
  expect((await app.inject({ method: 'GET', url: '/api/admin/audit?pageSize=101', headers: await authHeader(admin) })).statusCode).toBe(400);
});
```

在 `apps/server/test/admin.test.ts` 追加：

```ts
it('ranks the ten largest live books', async () => {
  await resetDb();
  const app = await buildTestApp();
  const admin = await seedUser('admin');
  for (let index = 0; index < 12; index += 1) {
    await seedBook({ uploadedBy: admin.id, title: `书${index}`, size: 100 + index });
  }
  await seedBook({ uploadedBy: admin.id, title: '回收站', size: 9_999, deletedAt: new Date() });
  const body = (await app.inject({ method: 'GET', url: '/api/admin/storage', headers: await authHeader(admin) })).json();
  expect(body.topBooks).toHaveLength(10);
  expect(body.topBooks[0]).toEqual({ id: expect.any(String), title: '书11', sizeBytes: 111 });
  expect(body.topBooks.some((book: { title: string }) => book.title === '回收站')).toBe(false);
});
```

`seedBook` 的体积字段名是 `size`（DB 列 `original_size`），已由 `test/helpers.ts` 提供；`seedBook` 同时支持 `deletedAt`。

- [ ] **Step 3: 运行测试确认失败**

Run: `TEST_DATABASE_URL=postgres://bookr:bookr@localhost:5432/bookr_admin_settings_test pnpm --filter @bookr/server test -- system-settings audit-log admin`
Expected: FAIL，路由 404 / 字段缺失。

- [ ] **Step 4: 实现**

按 Interfaces 实现 `settings/service.ts`、`audit/service.ts`，在 `admin/routes.ts` 注册两个设置路由与审计路由；扩展 `admin/service.ts` 的 `storageOverview`；在 `auth/service.ts` 的注册事务里读取设置并写入时区。

注意：`registerUser` 读取设置必须使用事务客户端 `tx`，与邀请码锁定处于同一事务。

- [ ] **Step 5: 运行测试确认通过**

Run: `TEST_DATABASE_URL=postgres://bookr:bookr@localhost:5432/bookr_admin_settings_test pnpm --filter @bookr/server test -- system-settings audit-log admin`
Expected: PASS。

- [ ] **Step 6: 类型检查、全量测试与提交**

```bash
TEST_DATABASE_URL=postgres://bookr:bookr@localhost:5432/bookr_admin_settings_test pnpm --filter @bookr/server test
pnpm exec turbo run typecheck
git add apps/server
git commit -m "feat(server): add system settings, audit log and storage ranking"
```

---

### Task 4: 备份心跳、告警与深度健康检查（服务端）

**Files:**
- Create: `apps/server/src/backup/repo.ts`
- Create: `apps/server/src/backup/service.ts`
- Create: `apps/server/src/backup/routes.ts`
- Create: `apps/server/src/monitor/notify.ts`
- Create: `apps/server/src/monitor/check.ts`
- Create: `apps/server/src/monitor/loop.ts`
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/server.ts`
- Test: `apps/server/test/backup-heartbeat.test.ts`
- Test: `apps/server/test/monitor-alerts.test.ts`
- Test: `apps/server/test/readyz.test.ts`
- Modify: `apps/server/test/config.test.ts`

**Interfaces:**
- Consumes: Task 1 DTO 与 schema；Task 2 表；`AppDeps.storage.head`
- Produces:

```ts
// config.ts —— AppConfig 新增
export interface AppConfig {
  // ...现有字段
  backup: { token: string | null };
  alerts: {
    webhookUrl: string | null;
    diskFreeThresholdBytes: number; // DISK_ALERT_FREE_BYTES，默认 10 GiB（10737418240）
    staleHours: number;             // BACKUP_STALE_HOURS，默认 24，范围 1..168
    monitorIntervalMs: number;      // MONITOR_INTERVAL_MS，默认 300000，范围 60000..3600000
  };
}

// apps/server/src/backup/service.ts
export async function recordBackupReport(deps: AppDeps, input: BackupHeartbeatInput): Promise<BackupReportDto>;
export async function getBackupStatus(deps: AppDeps, now?: Date): Promise<BackupStatusDto>;

// apps/server/src/monitor/notify.ts
export interface AlertCondition {
  key: 'backup-stale' | 'backup-pc-silent' | 'disk-low' | 'backup-failure';
  severity: 'warning' | 'critical';
  message: string;
}
export async function postAlertWebhook(url: string, condition: AlertCondition, at: Date): Promise<void>;
/**
 * 状态机：条件为真且（未处于 active 或距上次成功投递 ≥ 24 小时）→ 投递并更新 monitor_states；
 * 投递失败写 alert_events(status='failed') 且不置 active，下一轮重试；未配置 Webhook 只更新状态。
 */
export async function notifyConditionOnce(
  deps: AppDeps, condition: AlertCondition, now: Date,
): Promise<'sent' | 'skipped' | 'failed' | 'no-webhook'>;

// apps/server/src/monitor/check.ts
export function evaluateAlerts(status: BackupStatusDto, config: AppConfig, now: Date): AlertCondition[];
export async function runMonitorTick(deps: AppDeps, now?: Date): Promise<AlertCondition[]>;

// apps/server/src/monitor/loop.ts
export function startMonitor(deps: AppDeps): () => void;
```

HTTP：
- `POST /api/admin/backup/heartbeat`：`X-Backup-Token` 或管理员 JWT；201 `{ id, receivedAt }`
- `GET /api/admin/backup`：管理员；`BackupStatusDto`
- `GET /readyz`：公开；200 `{ status: 'ok', checks: { database: 'ok', storage: 'ok' } }`，任一失败 503 `{ status: 'degraded', checks: {...} }`

行为：
- 配置：`BACKUP_TOKEN` 可选、至少 32 字符；`ALERT_WEBHOOK_URL` 可选，仅接受 `http:`/`https:`；`DISK_ALERT_FREE_BYTES` 正整数；`MONITOR_INTERVAL_MS`。非法值启动即失败（与其他配置一致）。
- 心跳认证：先比较 `X-Backup-Token`（`crypto.createHash('sha256')` 后 `timingSafeEqual`；未配置 token 时该分支直接失败），否则走 `makeRequireAuth` + `makeRequireAdmin`。认证失败统一 401/403，不区分“token 错误”和“未配置”。
- `recordBackupReport` 插入行并返回 DTO；`receivedAt` 取 `deps.clock.now()`（不依赖数据库默认值，便于测试冻结时钟）；`status === 'failure'` 时立即调用一次告警（`backup-failure`，**不阻塞**响应：用 `void notifyConditionOnce(...)`，内部捕获所有错误）。
- `getBackupStatus`：最近 20 条报告（`receivedAt DESC`）、最近 10 条告警事件；`lastSuccessAt` = 任一来源最近 success 的 `finishedAt`；`lastServerExportAt`/`lastBackupPcAt` = 对应来源最近任意上报的 `receivedAt`；`backupStale` = 无 success 或 `now - lastSuccessAt > staleHours`；`backupPcSilent` = 无 backup-pc 上报或 `now - lastBackupPcAt > staleHours`；`diskLow` = 最近一条带磁盘数据的报告 `diskFreeBytes < threshold`。
- `evaluateAlerts`：按上面的判定生成条件，`backup-failure` 仅在最近一条报告为 failure 且 `receivedAt` 在 24 小时内出现；消息使用中文（例如“备份已 25 小时未成功”）。
- `runMonitorTick`：读取状态 → 评估 → 对每个条件执行状态机：
  - 条件为真且（`monitor_states.active = false` 或 `lastAlertAt` 为 null 或 `now - lastAlertAt ≥ 24h`）→ 若配置了 Webhook 则投递并写 `alert_events`（成功 `sent`，抛错 `failed` 并记录错误名）；把 `monitor_states` 置为 `active=true`、`lastAlertAt=now`（仅在投递成功时更新，失败保留以便下轮重试）。
  - 条件为真且仍在 24 小时窗口内 → 不投递、不写事件。
  - 条件为假且 `active=true` → 置 `active=false`（保留 `lastAlertAt` 仅作观测，不参与下次判定）。
  - 未配置 Webhook → 只维护 `monitor_states`，不写 `alert_events`。
- `postAlertWebhook`：POST JSON `{ source: 'bookr', key, severity, message, at }`，`AbortSignal.timeout(5_000)`，仅 2xx 视为成功；错误信息只保留 error name/status，不含响应体。
- `startMonitor`：立即跑一次，之后每 `monitorIntervalMs` 跑一次；`inFlight` 防重入；`timer.unref()`；返回停止函数。
- `/readyz`：数据库 `select 1`；存储用 `deps.storage.head('__readyz_probe__')`（缺失对象返回 null 也算可达）加 2 秒超时；只返回 `ok`/`error`，不返回异常细节。

- [ ] **Step 1: 写失败测试（心跳）**

创建 `apps/server/test/backup-heartbeat.test.ts`：

```ts
import { beforeEach, expect, it } from 'vitest';
import {
  authHeader, createTestApp, resetDb, seedUser, type SeededUser,
} from './helpers';

const NOW = new Date('2026-10-19T04:00:00.000Z');
const VALID = {
  source: 'server-export',
  status: 'success',
  startedAt: '2026-10-19T03:00:00+08:00',
  finishedAt: '2026-10-19T03:10:00+08:00',
  bytes: 2_048,
  diskFreeBytes: 40_000,
  diskTotalBytes: 100_000,
};

let admin: SeededUser;

beforeEach(async () => {
  await resetDb();
  admin = await seedUser('admin');
});

/** createTestApp 返回的 deps 与应用共享同一对象，冻结时钟要直接改 deps.clock。 */
async function frozenApp(overrides = {}) {
  const built = await createTestApp(overrides);
  built.deps.clock = { now: () => NOW };
  return built;
}

it('accepts an admin JWT and exposes the report in the status', async () => {
  const built = await frozenApp();
  const posted = await built.app.inject({ method: 'POST', url: '/api/admin/backup/heartbeat', headers: await authHeader(admin), payload: VALID });
  expect(posted.statusCode).toBe(201);
  const status = await built.app.inject({ method: 'GET', url: '/api/admin/backup', headers: await authHeader(admin) });
  const body = status.json();
  expect(body.lastSuccessAt).not.toBeNull();
  expect(body.reports[0]).toMatchObject({ source: 'server-export', status: 'success', bytes: 2_048 });
  expect(body.backupStale).toBe(false);
  expect(body.backupPcSilent).toBe(true);
  expect(body.diskLow).toBe(false);
});

it('accepts the backup token and rejects wrong or missing credentials', async () => {
  const built = await frozenApp({ backup: { token: 't'.repeat(32) } });
  const token = 't'.repeat(32);
  const ok = await built.app.inject({ method: 'POST', url: '/api/admin/backup/heartbeat', headers: { 'x-backup-token': token }, payload: VALID });
  expect(ok.statusCode).toBe(201);
  const wrong = await built.app.inject({ method: 'POST', url: '/api/admin/backup/heartbeat', headers: { 'x-backup-token': 'x'.repeat(32) }, payload: VALID });
  expect(wrong.statusCode).toBe(401);
  const anonymous = await built.app.inject({ method: 'POST', url: '/api/admin/backup/heartbeat', payload: VALID });
  expect(anonymous.statusCode).toBe(401);
  const member = await built.app.inject({ method: 'POST', url: '/api/admin/backup/heartbeat', headers: await authHeader(await seedUser('member')), payload: VALID });
  expect(member.statusCode).toBe(403);
});

it('computes staleness, silence and low disk from the clock', async () => {
  const built = await frozenApp();
  await built.app.inject({
    method: 'POST', url: '/api/admin/backup/heartbeat', headers: await authHeader(admin),
    payload: { ...VALID, source: 'backup-pc', finishedAt: '2026-10-17T18:00:00+08:00', diskFreeBytes: 1_000 },
  });
  const status = (await built.app.inject({ method: 'GET', url: '/api/admin/backup', headers: await authHeader(admin) })).json();
  expect(status.backupStale).toBe(true);
  expect(status.backupPcSilent).toBe(true);
  expect(status.diskLow).toBe(true);
});
```

`TestConfigOverrides`（`test/helpers.ts`）当前只对 `s3`/`ai` 做嵌套合并；本任务要把 `backup`、`alerts` 加入同一处理：

```ts
export type TestConfigOverrides = Partial<Omit<AppConfig, 's3' | 'ai' | 'backup' | 'alerts'>> & {
  s3?: Partial<AppConfig['s3']>;
  ai?: Partial<AppConfig['ai']>;
  backup?: Partial<AppConfig['backup']>;
  alerts?: Partial<AppConfig['alerts']>;
};
// buildTestConfig 里同样展开 backup/alerts。
```

`createTestApp` 默认使用真实时钟；测试通过 `built.deps.clock = { now: () => NOW }` 冻结（应用与 deps 共享同一对象）。

- [ ] **Step 2: 写失败测试（监控状态机）**

创建 `apps/server/test/monitor-alerts.test.ts`：

```ts
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { alertEvents, monitorStates } from '../src/db/schema';
import { runMonitorTick } from '../src/monitor/check';
import { recordBackupReport } from '../src/backup/service';
import { createTestApp, resetDb, testDb } from './helpers';

const NOW = new Date('2026-10-19T04:00:00.000Z');
const webhook = 'http://alerts.example/hook';

beforeEach(async () => {
  await resetDb();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** 只统计 backup-stale 的投递，同轮还会发 backup-pc-silent。 */
function staleCalls(fetch: ReturnType<typeof vi.fn>): number {
  return fetch.mock.calls.filter(([, init]) =>
    String((init as RequestInit | undefined)?.body ?? '').includes('"key":"backup-stale"'),
  ).length;
}

async function frozenApp(alerts: { webhookUrl?: string | null } = {}) {
  const built = await createTestApp({ alerts });
  built.deps.clock = { now: () => NOW };
  return built;
}

it('sends one alert per continuous incident and re-arms after recovery', async () => {
  const fetch = vi.fn(async () => new Response('', { status: 204 }));
  vi.stubGlobal('fetch', fetch);
  const built = await frozenApp({ webhookUrl: webhook });

  const first = await runMonitorTick(built.deps, NOW);
  expect(first.map((item) => item.key)).toContain('backup-stale');
  expect(staleCalls(fetch)).toBe(1);

  const second = await runMonitorTick(built.deps, NOW);
  expect(second.map((item) => item.key)).toContain('backup-stale');
  expect(staleCalls(fetch)).toBe(1);

  await recordBackupReport(built.deps, {
    source: 'server-export', status: 'success',
    startedAt: '2026-10-19T03:50:00+08:00', finishedAt: '2026-10-19T04:00:00+08:00',
    diskFreeBytes: 50_000, diskTotalBytes: 100_000,
  });
  await runMonitorTick(built.deps, NOW);
  const states = await testDb.select().from(monitorStates).where(eq(monitorStates.key, 'backup-stale'));
  expect(states[0]?.active).toBe(false);

  // 恢复后 30 小时再次过期，应重新告警。
  const later = new Date(NOW.getTime() + 30 * 3_600_000);
  await runMonitorTick(built.deps, later);
  expect(staleCalls(fetch)).toBeGreaterThanOrEqual(2);
});

it('records a failed delivery and retries on the next tick', async () => {
  const fetch = vi.fn(async () => new Response('', { status: 503 }));
  vi.stubGlobal('fetch', fetch);
  const built = await frozenApp({ webhookUrl: webhook });

  await runMonitorTick(built.deps, NOW);
  const failed = await testDb.select().from(alertEvents);
  expect(failed.some((event) => event.status === 'failed')).toBe(true);
  const state = (await testDb.select().from(monitorStates).where(eq(monitorStates.key, 'backup-stale')))[0];
  expect(state?.active).toBe(false);

  const fetchOk = vi.fn(async () => new Response('', { status: 204 }));
  vi.stubGlobal('fetch', fetchOk);
  await runMonitorTick(built.deps, NOW);
  expect(fetchOk).toHaveBeenCalled();
});

it('keeps state without webhook and never writes alert rows', async () => {
  const built = await frozenApp();
  const conditions = await runMonitorTick(built.deps, NOW);
  expect(conditions.map((item) => item.key)).toContain('backup-stale');
  expect(await testDb.select().from(alertEvents)).toHaveLength(0);
});
```

- [ ] **Step 3: 写失败测试（readyz 与配置）**

创建 `apps/server/test/readyz.test.ts`：

```ts
import { beforeEach, expect, it } from 'vitest';
import { createTestApp, resetDb } from './helpers';

beforeEach(async () => {
  await resetDb();
});

it('reports ready with a reachable database and storage', async () => {
  const built = await createTestApp();
  const response = await built.app.inject({ method: 'GET', url: '/readyz' });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ status: 'ok', checks: { database: 'ok', storage: 'ok' } });
});

it('reports degraded when storage fails, without leaking details', async () => {
  const built = await createTestApp();
  // FakeStorage 是测试进程共享的单例，不能改它的方法；用原型链包一层只覆盖 head。
  built.deps.storage = Object.create(built.deps.storage, {
    head: { value: async () => { throw new Error('secret endpoint http://minio:9000'); } },
  });
  const response = await built.app.inject({ method: 'GET', url: '/readyz' });
  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ status: 'degraded', checks: { database: 'ok', storage: 'error' } });
  expect(response.body).not.toContain('minio');
});
```

在 `config.test.ts` 追加：`BACKUP_TOKEN` 太短启动失败；`ALERT_WEBHOOK_URL=ftp://x` 失败；`DISK_ALERT_FREE_BYTES=0` 失败；默认值 `staleHours=24`、`monitorIntervalMs=300000`、`diskFreeThresholdBytes=10737418240`。

- [ ] **Step 4: 运行测试确认失败**

Run: `TEST_DATABASE_URL=postgres://bookr:bookr@localhost:5432/bookr_admin_backup_test pnpm --filter @bookr/server test -- backup-heartbeat monitor-alerts readyz config`
Expected: FAIL。

- [ ] **Step 5: 实现**

按 Interfaces 实现 `backup/*`、`monitor/*`，在 `app.ts` 注册备份路由与 `/readyz`，在 `server.ts` 启动/停止监控循环。

注意：`recordBackupReport` 触发的即时告警必须复用 `monitor/notify.ts` 的 `notifyConditionOnce`（不要另写一套），避免“心跳失败告警绕过去重”的漏洞；依赖方向是 `backup/service → monitor/notify → schema`，`monitor/check → backup/service`，不得让 `backup/service` 反向引用 `monitor/check`（会形成循环）。同时更新 `test/helpers.ts`：`DEFAULT_CONFIG` 补上 `backup`/`alerts` 默认值，`TestConfigOverrides` 与 `buildTestConfig` 支持这两个嵌套字段的局部覆盖。

- [ ] **Step 6: 运行测试确认通过**

Run: `TEST_DATABASE_URL=postgres://bookr:bookr@localhost:5432/bookr_admin_backup_test pnpm --filter @bookr/server test`
Expected: PASS（含原有全部服务端测试）。

- [ ] **Step 7: 类型检查与提交**

```bash
pnpm exec turbo run typecheck
git add apps/server
git commit -m "feat(server): add backup heartbeat, alerting and readiness checks"
```

---

### Task 5: PWA 清单与图标

**Files:**
- Create: `apps/web/public/manifest.webmanifest`
- Create: `apps/web/public/icons/icon-192.png`、`icon-512.png`、`icon-maskable-512.png`、`apple-touch-icon.png`（180×180）
- Create: `scripts/generate-pwa-icons.ps1`
- Modify: `apps/web/index.html`
- Test: `apps/web/test/pwa-manifest.test.ts`

**Interfaces:**
- Consumes: 现有 `apps/web/public/sw.js`（不修改）、`apps/web/src/main.tsx` 的注册逻辑（不修改）
- Produces: `/manifest.webmanifest` 与四个 PNG；`index.html` 增加 manifest / apple-touch-icon / theme-color 已有

清单内容（逐字）：

```json
{
  "name": "纸墨书房",
  "short_name": "书房",
  "description": "私人电子书阅读与图书管理",
  "lang": "zh-CN",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "orientation": "portrait-primary",
  "background_color": "#F6F1E7",
  "theme_color": "#F6F1E7",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

图标设计：暖纸底 `#F6F1E7`，居中墨色圆印 `#2B2B2B`，印内衬线“书”字用纸色；maskable 版本圆印直径不超过画布 70%，其余留白。

- [ ] **Step 1: 写失败测试**

创建 `apps/web/test/pwa-manifest.test.ts`：

```ts
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'public/manifest.webmanifest'), 'utf8'));

function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('PWA manifest', () => {
  it('describes an installable standalone app', () => {
    expect(manifest).toMatchObject({
      name: '纸墨书房',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      theme_color: '#F6F1E7',
      background_color: '#F6F1E7',
    });
    expect(manifest.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ sizes: '192x192', purpose: 'any' }),
      expect.objectContaining({ sizes: '512x512', purpose: 'any' }),
      expect.objectContaining({ sizes: '512x512', purpose: 'maskable' }),
    ]));
  });

  it('ships real PNGs at the declared sizes', () => {
    expect(pngSize(resolve(root, 'public/icons/icon-192.png'))).toEqual({ width: 192, height: 192 });
    expect(pngSize(resolve(root, 'public/icons/icon-512.png'))).toEqual({ width: 512, height: 512 });
    expect(pngSize(resolve(root, 'public/icons/icon-maskable-512.png'))).toEqual({ width: 512, height: 512 });
    expect(pngSize(resolve(root, 'public/apple-touch-icon.png'))).toEqual({ width: 180, height: 180 });
  });

  it('links the manifest from the shell', () => {
    const html = readFileSync(resolve(root, 'index.html'), 'utf8');
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('rel="apple-touch-icon" href="/apple-touch-icon.png"');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @bookr/web test -- pwa-manifest`
Expected: FAIL，文件不存在。

- [ ] **Step 3: 生成图标与清单**

创建 `scripts/generate-pwa-icons.ps1`（System.Drawing）：绘制 192/512/180 与 maskable 512 四个 PNG 到 `apps/web/public/icons/` 与 `apps/web/public/apple-touch-icon.png`；脚本可重复执行。运行一次并提交生成的 PNG。

创建清单文件，修改 `index.html` 的 `<head>`：

```html
<link rel="manifest" href="/manifest.webmanifest" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-title" content="纸墨书房" />
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @bookr/web test -- pwa-manifest`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/web/public apps/web/index.html apps/web/test/pwa-manifest.test.ts scripts/generate-pwa-icons.ps1
git commit -m "feat(web): make the app installable with a PWA manifest"
```

---

### Task 6: 原生发布配置与版本一致性检查

**Files:**
- Create: `scripts/check-native-config.mjs`
- Create: `scripts/build-android.sh`
- Create: `scripts/build-desktop.sh`
- Modify: `apps/mobile/android/app/build.gradle`
- Modify: `apps/mobile/android/.gitignore`
- Create: `apps/mobile/android/keystore.properties.example`
- Modify: `apps/desktop/src-tauri/tauri.conf.json`
- Modify: `package.json`、`.github/workflows/ci.yml`
- Create: `docs/operations/native-builds.md`

**Interfaces:**
- Consumes: `apps/{web,desktop,mobile}/package.json`、`apps/desktop/src-tauri/tauri.conf.json`、`apps/mobile/capacitor.config.ts`、`apps/mobile/android/app/build.gradle`
- Produces: `pnpm check:native`（退出码 0/1）；`scripts/build-android.sh`、`scripts/build-desktop.sh`

检查规则（`scripts/check-native-config.mjs`，纯 Node，无依赖）：
1. 桌面与移动 `package.json` 的 `version` 相同，且与 `tauri.conf.json` 的 `version` 相同。
2. `tauri.conf.json` 的 `identifier` 与 `capacitor.config.ts` 的 `appId` 都是 `com.bookr.reader`。
3. `android/app/build.gradle` 的 `applicationId` 与 `capacitor.config.ts` 的 `appId` 相同，`versionName` 与 `apps/mobile/package.json` 的 `version` 相同。
4. `keystore.properties` 不被 git 跟踪（读取 `.gitignore` 文本包含该文件名即可，不依赖 git 命令）。
5. `apps/desktop/src-tauri/icons/` 下 `icon.ico`、`32x32.png`、`128x128.png`、`128x128@2x.png` 存在。
6. `apps/web/public/manifest.webmanifest` 存在且 `display === 'standalone'`。
逐条打印 `OK/FAIL`，任一失败退出 1。

Android 发布签名（`app/build.gradle`）：

```groovy
def keystorePropertiesFile = rootProject.file("keystore.properties")
def keystoreProperties = new Properties()
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(new FileInputStream(keystorePropertiesFile))
}

android {
    // ...
    signingConfigs {
        release {
            if (keystorePropertiesFile.exists()) {
                storeFile file(keystoreProperties['storeFile'])
                storePassword keystoreProperties['storePassword']
                keyAlias keystoreProperties['keyAlias']
                keyPassword keystoreProperties['keyPassword']
            }
        }
    }
    buildTypes {
        release {
            signingConfig keystorePropertiesFile.exists() ? signingConfigs.release : null
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
        }
    }
}
```

`versionName` 改为 `"0.2.0"`、`versionCode 2`。`.gitignore` 追加 `keystore.properties` 与 `*.jks`。`keystore.properties.example` 写明四个键。

`scripts/build-android.sh`：要求 `VITE_API_BASE_URL` 与 `ANDROID_HOME`（或 `local.properties`），执行 `pnpm --filter @bookr/web build`、`pnpm --filter @bookr/mobile sync`、`apps/mobile/android/gradlew assembleRelease`，打印 APK 路径；缺少签名材料时明确提示“未配置签名，产物不可发布”。

`scripts/build-desktop.sh`：要求 `VITE_API_BASE_URL`，执行 `pnpm --filter @bookr/web build` 与 `pnpm --filter @bookr/desktop build`，打印安装包路径。

`tauri.conf.json`：`bundle.targets` 改为 `["nsis", "msi"]`（Windows 优先；macOS 构建时显式传 `--target`）。

- [ ] **Step 1: 写检查脚本并运行（红）**

按规则创建 `scripts/check-native-config.mjs`，在 `package.json` 增加：

```json
"check:native": "node scripts/check-native-config.mjs"
```

先在未修正 `build.gradle` 时运行：

Run: `pnpm check:native`
Expected: FAIL，报告版本不一致（当前 Android `versionName "1.0"` 与 0.2.0 不符）。

- [ ] **Step 2: 修正配置与脚本（绿）**

修改 `build.gradle`、`.gitignore`、`tauri.conf.json`，创建构建脚本与 `docs/operations/native-builds.md`（Windows 桌面 NSIS/MSI 构建、代码签名占位说明、Android keystore 生成与保管、版本号升级步骤、CORS 与 `VITE_API_BASE_URL` 要求）。在 `ci.yml` 的 `pnpm typecheck` 后加 `- run: pnpm check:native`。

Run: `pnpm check:native`
Expected: PASS，六组检查全部 OK。

- [ ] **Step 3: 语法检查**

Run: `bash -n scripts/build-android.sh && bash -n scripts/build-desktop.sh`
Expected: 无输出，退出 0。

- [ ] **Step 4: 提交**

```bash
git add scripts apps/mobile/android apps/desktop/src-tauri/tauri.conf.json package.json .github/workflows/ci.yml docs/operations/native-builds.md
git commit -m "build: add native release config and version checks"
```

---

### Task 7: 备份心跳上报与恢复演练脚本

**Files:**
- Create: `scripts/lib/heartbeat.sh`
- Modify: `scripts/backup-export.sh`
- Modify: `scripts/pull-backup.sh`
- Create: `scripts/restore-drill.sh`
- Modify: `README.md`（§7 备份与恢复、§11 环境变量）

**Interfaces:**
- Consumes: `POST /api/admin/backup/heartbeat`（Task 4 契约，Task 1 schema）
- Produces: 三个脚本的可执行行为；`scripts/lib/heartbeat.sh` 提供 `heartbeat_report` 函数

`scripts/lib/heartbeat.sh`（被 source）：

```bash
# heartbeat_report <source> <status> <started_iso> <finished_iso> [bytes] [message] [disk_dir]
heartbeat_report() { ... }
```

- URL：`${BOOKR_HEARTBEAT_URL:-${BOOKR_API_URL:-http://127.0.0.1:8180}/api/admin/backup/heartbeat}`。
- 认证：`BOOKR_BACKUP_TOKEN` 存在时发 `X-Backup-Token`，否则不发（由服务器管理员 JWT 不支持脚本场景；文档要求配置 token）。
- 磁盘：`disk_dir` 存在时用 `df -Pk "$disk_dir"` 取总量与可用量（字节）。
- `BACKUP_HEARTBEAT_DRY_RUN=1` 时打印 JSON 不发送。
- 网络失败只 `log` 警告、返回 0（备份本身成功不应因上报失败被判失败）；HTTP 非 2xx 也警告。

`backup-export.sh`：记录开始时间；dump 成功后立刻用 `psql` 统计核心表行数写入 `$DB_DIR/counts-$TIMESTAMP.txt`（每行 `表名=行数`，表：`users`、`books`（仅 `deleted_at is null`）、`reading_progress`、`annotations`（仅 `deleted_at is null`）、`bookmarks`（仅 `deleted_at is null`）、`reading_sessions`、`daily_stats`、`categories`）；成功结束前调用 `heartbeat_report server-export success ...`（bytes = manifest 中对象总大小，disk_dir=$BACKUP_ROOT）；`trap ERR` 路径调用 `heartbeat_report server-export failure ... "<行号>"` 后退出非零。心跳上报不得改变备份本身的退出码。保留策略同时清理旧的 `counts-*.txt`。

`pull-backup.sh`：在 rsync+restic 成功后上报 `backup-pc success`（bytes = DEST 大小，disk_dir=$DEST）；失败路径上报 `failure`。

`restore-drill.sh`（关键安全约束：绝不写生产库）：

1. 参数：`--dump <file>` 可选；默认取 `$BACKUP_ROOT/db` 最新 `*.sql.gz`；对应的 `counts-<时间戳>.txt` 必须存在，否则 FAIL（备份不完整）。
2. 在 `postgres` 容器内创建临时库 `bookr_drill_<UTC时间戳>`。
3. 导入 dump 到临时库（导入失败即 FAIL）。
4. 在临时库中统计同一组核心表行数，与 `counts-*.txt` 逐项比较：**恢复后的行数少于备份时记录的行数即 FAIL**（备份期间只会有新增，绝不会少）；多出的行仅作提示，因为生产库在 dump 之后还会继续写入。
5. MinIO：比较备份目录的对象数与总字节与同时间戳的 `manifest-*.txt` 是否一致（`minio_files`、`minio_bytes`）。
6. 输出 `PASS`/`FAIL` 摘要并写入 `$BACKUP_ROOT/drills/<时间戳>.log`；默认删除临时库，`--keep` 保留。
7. 任何失败退出非零；不触碰 `bookr` 库。

README §7.5 增加“恢复演练（每季度）”：命令、通过标准（7 张核心表行数一致、对象数与字节一致）、记录位置（`/srv/bookr/backups/drills/`）、演练后清理。§11 环境变量补充 `BACKUP_TOKEN`、`BOOKR_API_URL`、`BOOKR_BACKUP_TOKEN`、`ALERT_WEBHOOK_URL`、`DISK_ALERT_FREE_BYTES`、`BACKUP_STALE_HOURS`、`MONITOR_INTERVAL_MS`。

- [ ] **Step 1: 写脚本**

实现 `scripts/lib/heartbeat.sh`、`restore-drill.sh`，改造两个现有脚本。注意 `set -Eeuo pipefail` 下的 ERR trap 防递归：失败上报前 `set +e`。

- [ ] **Step 2: 语法与干跑检查**

Run:

```bash
bash -n scripts/lib/heartbeat.sh
bash -n scripts/backup-export.sh
bash -n scripts/pull-backup.sh
bash -n scripts/restore-drill.sh
BACKUP_HEARTBEAT_DRY_RUN=1 bash -c '. scripts/lib/heartbeat.sh; heartbeat_report server-export success 2026-10-19T03:00:00Z 2026-10-19T03:10:00Z 1024 ok /tmp'
bash scripts/restore-drill.sh --help
```

Expected: 前四条无语法错误；干跑打印包含 `"source":"server-export"`、`"status":"success"`、`"bytes":1024` 的 JSON；`--help` 打印用法并退出 0。

- [ ] **Step 3: 提交**

```bash
git add scripts README.md
git commit -m "feat(ops): report backup heartbeats and add restore drills"
```

---

### Task 8: 管理后台 Web（设置、审计、备份、成员 AI）

**Files:**
- Modify: `apps/web/src/api/admin.ts`
- Create: `apps/web/src/features/admin/AdminTabs.tsx`
- Create: `apps/web/src/features/admin/AdminSettingsPage.tsx`
- Create: `apps/web/src/features/admin/AuditPage.tsx`
- Create: `apps/web/src/features/admin/BackupsPage.tsx`
- Modify: `apps/web/src/features/admin/MembersPage.tsx`
- Modify: `apps/web/src/app/router.tsx`
- Modify: `apps/web/test/setup.ts`
- Create: `apps/web/src/features/admin/__tests__/{admin-settings,admin-audit,admin-backups}.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 DTO 与 schema；Task 3/4 的 HTTP 契约；现有 `apiFetch`、`Toast`、`formatBytes/formatDateTime`、`messageForApiError`
- Produces:

```ts
// apps/web/src/api/admin.ts
export const ADMIN_SETTINGS_QUERY_KEY = ['admin', 'settings'] as const;
export const ADMIN_AUDIT_QUERY_KEY = ['admin', 'audit'] as const;
export const ADMIN_BACKUP_QUERY_KEY = ['admin', 'backup'] as const;
export const ADMIN_AI_QUERY_KEY = ['admin', 'ai'] as const;

export interface AdminAiConfig {
  configured: boolean;
  fakeProvider: boolean;
  baseUrl: string | null;
  chatModel: string | null;
  reasonerModel: string | null;
  hasApiKey: boolean;
  updatedAt: string | null;
}
export interface UpdateAdminAiConfig {
  baseUrl?: string;
  chatModel?: string;
  reasonerModel?: string;
  apiKey?: string;
}

export function useSystemSettings();
export function useUpdateSystemSettings();
export function useAuditLog(page: number, pageSize?: number);
export function useBackupStatus();
export function useAdminAiConfig();
export function useUpdateAdminAiConfig();
```

`UpdateMemberInput` 增加 `aiEnabled?: boolean`、`aiDailyTokenLimit?: number`、`aiMonthlyTokenLimit?: number`；`AdminMember` 增加同名字段。

页面行为：
- `AdminTabs`：`成员 / 设置 / 审计 / 备份` 四个链接，当前页 `aria-current="page"`；360px 两行换行，不横向滚动。
- `AdminSettingsPage`：
  - 「注册与默认时区」：注册开关（checkbox + 文案“关闭后，即使持有邀请码也无法注册新成员”），默认时区下拉复用 `features/settings/timezones.ts` 的选项；保存按钮；保存成功 Toast“设置已保存”。
  - 「AI 服务商」：显示配置状态（已配置/未配置/本地假提供方），`baseUrl`、`chatModel`、`reasonerModel` 文本输入；`apiKey` 为 password 输入，占位文案在已保存时“已保存，留空不修改”，未保存时“输入 API Key”；保存时只在非空时提交 `apiKey`。
  - 错误用 `role="alert"`；加载态 `role="status"`。
- `AuditPage`：表格列「时间 / 成员 / 动作 / 对象」；动作中文标签映射（`auth.login` 登录、`auth.register` 注册、`book.delete` 删除图书、`admin.member.update` 修改成员、`admin.invite.create` 创建邀请码、`admin.invite.revoke` 撤销邀请码、`admin.settings.update` 修改系统设置、`ai.config.update` 更新 AI 配置，未知动作显示原字符串）；分页按钮“上一页/下一页”，显示 `第 X / Y 页`；`metadata` 以 `JSON.stringify` 截断 120 字符展示，`title` 属性给全文。
- `BackupsPage`：顶部三张状态卡「最近成功备份 / 备份机最近上报 / 磁盘可用」；`backupStale` 显示 `role="alert"` 横幅“备份已超过 24 小时未成功”；`backupPcSilent` 横幅“备份机超过 24 小时未上报”；`diskLow` 横幅“磁盘可用空间低于阈值”；报告表格（时间、来源、状态、大小、说明）；告警历史列表（最近 10 条，状态 sent/failed）。无数据时显示“尚无备份记录，请先运行服务器备份脚本”。
- `MembersPage`：顶部放 `AdminTabs`（保留现有成员、邀请、存储区块）；存储区块增加「最大的 10 本书」列表；成员编辑对话框增加 AI 开关与日/月 token 上限（空值表示不修改），提交字段名与 `UpdateMemberInput` 一致。
- 路由：`/admin/settings`、`/admin/audit`、`/admin/backups` 均包在 `RequireAdmin` 内。

MSW fixtures（`test/setup.ts`）：
- `GET /api/admin/settings` 默认 `{ registrationEnabled: true, defaultTimezone: 'Asia/Shanghai', updatedAt: '2026-10-01T00:00:00.000Z' }`；`PATCH` 回显合并结果。
- `GET /api/admin/audit` 返回两页共 25 条夹具，含登录、删除图书、修改设置。
- `GET /api/admin/backup` 默认全部正常；测试内可覆盖为 `backupStale: true` 等。
- `GET/PUT /api/admin/ai` 默认未配置。
- `GET /api/admin/storage` 增加 `topBooks` 三项。

- [ ] **Step 1: 写失败测试（设置）**

创建 `src/features/admin/__tests__/admin-settings.test.tsx`：渲染路由 `/admin/settings`（用现有测试的 `renderApp`/内存路由辅助），断言：
1. 显示注册开关与 `Asia/Shanghai`。
2. 取消勾选、把时区改为 `America/New_York`、点击“保存设置”后，MSW 记录到的 PATCH body 为 `{ registrationEnabled: false, defaultTimezone: 'America/New_York' }`，出现“设置已保存”。
3. AI 区输入 baseUrl 与 apiKey 后保存，PUT body 含 `apiKey`；再次保存且 apiKey 留空时，PUT body 不含 `apiKey`。

- [ ] **Step 2: 写失败测试（审计与备份）**

`admin-audit.test.tsx`：显示 20 条、点击“下一页”请求 `page=2`、显示“第 2 / 2 页”、未知动作原样显示、成员列为空时显示“系统”。

`admin-backups.test.tsx`：
1. 正常状态：显示“最近成功备份”时间与报告行。
2. `backupStale: true` 时出现 `role="alert"` 的“备份已超过 24 小时未成功”。
3. 无报告时显示“尚无备份记录，请先运行服务器备份脚本”。
4. 点击“刷新”触发重新请求。

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @bookr/web test -- admin-settings admin-audit admin-backups`
Expected: FAIL，页面与路由不存在。

- [ ] **Step 4: 实现**

按 Interfaces 实现 API 客户端与三个页面、`AdminTabs`，接入路由与 MSW 夹具，扩展成员页。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @bookr/web test -- admin-settings admin-audit admin-backups`
Expected: PASS。

- [ ] **Step 6: 全量 Web 测试、类型检查与提交**

```bash
pnpm --filter @bookr/web test
pnpm exec turbo run typecheck
git add apps/web
git commit -m "feat(web): add admin settings, audit and backup screens"
```

---

### Task 9: 验收 E2E、验收清单与文档收尾

**Files:**
- Create: `apps/web/e2e/admin.spec.ts`
- Create: `apps/web/e2e/pwa.spec.ts`
- Create: `docs/operations/acceptance-checklist.md`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-10-18-00-roadmap.md`
- Modify: `docs/superpowers/plans/2026-10-19-08-admin-backup-release.md`（交付记录）

**Interfaces:**
- Consumes: Task 3/4/5/8 的页面与 API；`e2e/helpers.ts` 的 `adminAuth`、`E2E_BASE_URL`
- Produces: 可重复运行的验收证据

`apps/web/e2e/admin.spec.ts`（2 条）：

1. **设置与审计**：管理员登录 → `/admin/settings` → 关闭注册 → 保存 → 看到“设置已保存” → `/admin/audit` → 首行动作为“修改系统设置” → 回到设置重新打开注册（避免污染后续测试）。
2. **备份状态**：通过 `request.post('/api/admin/backup/heartbeat', { headers: adminAuth, data: {...} })` 上报一条 `server-export/success`（时间取当前）→ `/admin/backups` → 显示报告行与“最近成功备份”非空；再上报一条 `backup-pc/failure` → 刷新 → 出现失败标记。测试结束不清理（历史表只读展示，允许累积）。

`apps/web/e2e/pwa.spec.ts`（1 条）：
- `page.goto('/')`；断言 `link[rel="manifest"]` 存在；`request.get('/manifest.webmanifest')` 200 且 JSON `display === 'standalone'`；三个图标 URL 均 200 且 `content-type` 为 `image/png`。

`docs/operations/acceptance-checklist.md`：表格列出设计文档 §13 的 11 条验收标准，每行给出「自动化证据」（spec 文件与测试名）或「手动步骤」（桌面安装包、Android APK 侧载、断网三端、恢复演练），并留出「记录时间 / 结果」列。至少明确：13.1/2/3/4/5/6/7/10/11 已有自动化覆盖；13.8（恢复）由 `restore-drill.sh` + 季度演练记录；13.9（三端界面）由截图与人工走查。

README：
- 新增「管理后台」一节：成员/AI 配额、邀请码、系统设置（注册开关、默认时区、AI 服务商）、审计日志、备份状态；附截图替代说明与权限说明。
- 更新 `12. 端到端验收测试` 的用例数与运行方式。
- 更新「已知范围」：PWA 可安装、桌面/Android 发布流程、恢复演练。
- 合并 Task 6/7 写入的 `docs/operations/*` 链接。

路线图：把 08 行与计划列表标为「已交付」，添加计划链接。

- [x] **Step 1: 写 E2E 与文档**

按上述内容实现。

- [x] **Step 2: 构建并运行 E2E**

```bash
docker compose up -d --build
pnpm --filter @bookr/web exec playwright test
```

Expected: 原有 E2E 全部通过，并新增 3 条（`admin.spec.ts` 2 条、`pwa.spec.ts` 1 条）。

- [x] **Step 3: 全量验证**

```bash
pnpm exec turbo run typecheck test
pnpm check:native
docker compose ps
curl -fsS http://localhost:8180/healthz
curl -fsS http://localhost:8180/readyz
```

Expected: typecheck/test 全绿；`check:native` 六项 OK；Compose 四个服务 healthy；两个探针返回 200。

- [x] **Step 4: 提交**

```bash
git add apps/web/e2e docs README.md
git commit -m "test(e2e): cover admin console and PWA; document acceptance"
```

- [x] **Step 5: 写交付记录**

在本计划末尾追加交付记录：最终测试数量（Server/Web/Shared/Reader-core/E2E）、提交列表、遗留项（如本机无 JDK，Android 发布包未实际产出；桌面安装包是否产出）。

---

## 交付记录

**交付日期：** 2026-10-19
**分支：** `feature/p8-admin-backup-release`

### 验证结果

| 范围 | 命令 | 结果 |
| --- | --- | --- |
| Server | `pnpm exec turbo run typecheck test` | 55 个测试文件 / 387 条通过 |
| Web | 同上 | 51 个测试文件 / 417 条通过 |
| Shared | 同上 | 11 个测试文件 / 84 条通过 |
| Reader-core | 同上 | 18 个测试文件 / 149 条通过 |
| UI | 同上 | 1 个测试文件 / 2 条通过 |
| 合计单元/集成 | — | **1039 条通过**；turbo typecheck `7 successful, 7 total` |
| E2E | `pnpm --filter @bookr/web exec playwright test` | **9 个 spec / 21 条用例全部通过**（48.4s） |
| 原生配置 | `pnpm check:native` | 6/6 项 OK |
| Compose | `docker compose ps` | postgres/minio/server/web 四个服务均为 healthy |
| 探针 | `curl -fsS http://localhost:8180/healthz`、`/readyz` | 均 200；`/readyz` 返回 `{"status":"ok","checks":{"database":"ok","storage":"ok"}}` |

### 本次修复的部署缺口

- `Caddyfile` 原先只把 `/api/*` 与 `/healthz` 转发到 server，`/readyz` 无法经公开入口
  访问；现已加入 backend matcher，探针验证通过。

### 新增验收资产

- `apps/web/e2e/admin.spec.ts`：注册开关持久化 + 审计日志；服务器导出/备份机心跳与状态页。
- `apps/web/e2e/pwa.spec.ts`：manifest 链接、`display: standalone`、三个 PNG 图标。
- `docs/operations/acceptance-checklist.md`：设计文档 §13 的 11 条验收标准、自动化证据与
  手动步骤（真实计时、三端走查、恢复演练）。
- README 新增「18. 管理后台」，并更新 E2E 用例表、原生发布流程、已知范围与运维文档链接。

### 提交列表

P8 分支最终包含以下提交（含 Task 1–9）：

```text
a09c264 docs: add the admin, backup and release plan
c38bd28 feat(shared): add admin, audit and backup contracts
6b60091 feat(server): add admin settings, backup and alert tables
e4449ef feat(web): make the app installable with a PWA manifest
3a64d68 build: add native release config and version checks
7bcd872 fix(build): tighten native release checks and signing paths
191ed88 feat(ops): report backup heartbeats and add restore drills
030dcdf feat(server): add system settings, audit log and storage ranking
ad2c1cb fix(ops): count tables before dump and scope drill checks
4289e32 fix(ops): canonicalize drill dump path and align dry-run env name
b19ce00 feat(web): add admin settings, audit and backup screens
1fe622b feat(server): add backup heartbeat, alerting and readiness checks
3356788 fix(web): align AI drafts with saved settings and cover member AI edits
3618405 fix(server): clarify registration gate and cover settings edge cases
5f47d9d fix(server): make alert deduplication atomic and preserve fresh alerts
ce6e9c3 test(e2e): cover admin console and PWA; document acceptance
5754660 fix(e2e,docs): address Task 9 review findings
cf5e7c0 fix(ops,server,web): close final admin/backup review findings
```

### 最终审查修复（final fix）

最终整分支审查提出 8 项（6 个缺陷 + 2 个低成本建议），全部由 `cf5e7c0` 修复：

- Compose 现在把 `BACKUP_TOKEN`、`ALERT_WEBHOOK_URL`、`DISK_ALERT_FREE_BYTES`、
  `BACKUP_STALE_HOURS`、`MONITOR_INTERVAL_MS` 传给 server 容器；`.env.example` 与
  README §7.1/§7.2 的 cron/环境文件示例同步补齐，心跳脚本因此真正可用。
- 注册页 403 FORBIDDEN 显示“注册暂未开放，请联系管理员”，不再被通用无权限文案吞掉。
- 备份页横幅不再写死 24 小时；`scripts/lib/heartbeat.sh` 先转义反斜杠并清理控制字符；
  审计页补齐 7 个动作标签。
- `S3Storage.head` 只把缺失对象当作 `null`，`NoSuchBucket` 会让 `/readyz` 返回 503；
  monitor tick 失败记录错误名，启动时记录心跳 token 与 webhook 是否配置（仅布尔值）。

修复后最终验证：

| 命令 | 结果 |
| --- | --- |
| `TEST_DATABASE_URL=postgres://bookr:bookr@localhost:5432/bookr_admin_backup_test pnpm --filter @bookr/server test` | 55 文件 / **387 条通过** |
| `pnpm --filter @bookr/web test` | 51 文件 / **417 条通过** |
| `pnpm exec turbo run typecheck` | **7 successful, 7 total** |
| `docker compose up -d --build` + 进程内环境检查 | 四服务 healthy；`{"token":false,"webhook":false,"stale":"24","interval":"300000"}`（本机 `.env` 未启用两个通道，默认值正确传入） |
| `curl -fsS http://localhost:8180/readyz` | 200 `{"status":"ok","checks":{"database":"ok","storage":"ok"}}` |
| `pnpm --filter @bookr/web exec playwright test` | **9 spec / 21 条全部通过**（48.4s） |

### 遗留项

- **Android 发布包未在本机构建**：本机没有 JDK（`java` 不在 PATH），`pnpm build:android`
  无法执行，`apps/mobile/android/app/build/outputs/apk/release/` 下没有 APK。发布配置、
  签名忽略规则与脚本已就绪，`pnpm check:native` 通过；需在安装 JDK 21 与 Android SDK
  的机器上按 `docs/operations/native-builds.md` 构建。
- **桌面安装包未在本机构建**：本机虽已有 Rust，但没有产出
  `apps/desktop/src-tauri/target/release/bundle/`。需在具备 MSVC Build Tools 与
  WebView2 的 Windows 机器上执行 `VITE_API_BASE_URL=... pnpm build:desktop`。
- **恢复演练未在开发机执行**：`scripts/restore-drill.sh` 依赖 Linux/GNU 工具与真实的
  `backups/` 数据；按运维要求每季度在服务器上执行，并把 `PASS` 日志填入验收清单。
- **三端界面走查与性能计时**：13.1 的 10 秒打开、13.4 的 3 秒首字、13.9 的三端截图
  需要人工执行，结果列在 `docs/operations/acceptance-checklist.md` 中待填。
- **E2E 偶发**：一次较早的完整运行中 `ai.spec.ts › honours the settings toggle` 在第一次
  尝试失败、重试后通过；随后单独运行该 spec 与最终完整运行均 4/4、21/21 通过。该用例
  不改动本任务文件，后续若再次出现应结合 `test-results/` 的 trace 排查。
- E2E 仍是破坏性测试，只能对一次性 localhost Compose 栈运行；`E2E_ALLOW_REMOTE=1`
  绝不能用于生产。
