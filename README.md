# BookrReader 部署与运维手册

本文覆盖单台 Linux 服务器上的 Docker Compose 部署：首次启动、管理员引导、邀请码、升级、备份与恢复、磁盘阈值、HTTPS 域名以及安全红线。

## 1. 架构与端口

```
浏览器 ──HTTP──> web (Caddy :8180) ──/api/*、/healthz──> server (Fastify :3000)
                                   └── 静态 SPA（SPA fallback）
server ──> postgres (:5432，仅容器网络)
server ──> minio (:9000，仅容器网络；宿主 9200/9201 仅用于运维)
```

| 服务 | 宿主端口 | 说明 |
| --- | --- | --- |
| `web` | `8180` | 唯一对外入口，Caddy 提供 SPA 与反向代理 |
| `minio` | `9200`（S3 API）、`9201`（控制台） | 仅限内网/运维使用，建议防火墙限制 |
| `server` | 不发布 | 只能经 Caddy 访问 |
| `postgres` | 不发布 | 只能经容器网络访问 |

**安全红线：永远不要给 `server` 或 `postgres` 添加 `ports:` 映射。** 直连 3000 端口会绕过 Caddy 的转发头、CORS 与 `TRUST_PROXY` 配置，登录限流也会按代理地址计数。

命名卷：`pgdata`（数据库）、`miniodata`（书籍与文件）、`caddy_data`（证书与 Caddy 状态）。

## 2. 前置条件

- Docker Engine 24+ 与 Docker Compose v2；Linux 服务器（备份脚本假定 GNU 工具）。
- 建议磁盘：书籍库容量的 2 倍以上（原始文件 + 备份镜像 + 数据库）；首次构建还会占用数 GB 镜像空间。
- 若需要域名与 HTTPS，准备一个已解析到服务器的域名，并放行 80/443。
- 备份 PC（5080）安装 `rsync`、`restic`，并能通过 SSH 免密登录服务器。

## 3. 首次部署

```bash
# 1. 部署目录（示例）
sudo mkdir -p /srv/bookr && cd /srv/bookr
# 将仓库内容放到 /srv/bookr（git clone 或 rsync 均可）

# 2. 配置环境变量
cp .env.example .env
chmod 600 .env
# 编辑 .env：替换所有 change-me 值。生成强随机密钥：
#   openssl rand -base64 48        # JWT_SECRET
#   openssl rand -base64 24        # POSTGRES_PASSWORD / S3_SECRET_KEY

# 3. 校验并启动（首次构建需安装 Calibre，可能耗时数分钟）
docker compose config
docker compose up -d --build

# 4. 等待并验证
docker compose ps                 # postgres/minio/server/web 均为 healthy
curl -fsS http://localhost:8180/healthz
# 期望：{"status":"ok"}
```

服务器启动时会自动：执行 `drizzle/` 迁移（失败重试 60 秒后退出）、创建 `bookr` 桶（已存在则忽略）、启动后台任务 worker、每日清理过期上传会话与 30 天前的回收站书籍、为残留的 `metadata_status='pending'` 书籍补投元数据任务。

首次构建慢是正常现象：`apps/server/Dockerfile` 会安装 Debian 的 `calibre` 包（提供 `ebook-convert`）。

## 4. 管理员与邀请码

首个管理员只能通过 CLI 创建，且库中已有用户时会拒绝（退出码非 0）：

```bash
cd /srv/bookr
docker compose exec \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD='请替换为强密码' \
  -e ADMIN_DISPLAY_NAME='管理员' \
  server node dist/cli/create-admin.js
```

成功时输出管理员用户 id（UUID）。

之后在网页 `http://<服务器>:8180` 用该账号登录，进入 **管理** 页面创建邀请码并复制给成员；成员通过注册页使用邀请码注册。邀请码也可由管理员通过 `POST /api/admin/invites` 创建。

## 5. 日常运维

```bash
docker compose ps                     # 健康状态
docker compose logs -f server         # 应用日志（worker/cleanup 也写在这里）
docker compose restart server         # 重启应用（迁移会再次幂等执行）
docker compose down                   # 停止（命名卷保留数据）
```

`/healthz` 经 Caddy 暴露在 `http://localhost:8180/healthz`，可直接用于外部探活。

## 6. 升级

```bash
cd /srv/bookr
sudo ./scripts/backup-export.sh       # 先备份
docker compose build --pull           # 重新构建 server/web 镜像
docker compose up -d                  # 滚动替换；server 启动时自动迁移
docker compose ps
curl -fsS http://localhost:8180/healthz
```

回滚：切回上一版代码后重新 `docker compose up -d --build`；若新版本迁移不兼容，按第 7 节用升级前的备份恢复数据库与 MinIO。

## 7. 备份与恢复

### 7.1 服务器端导出（每日）

`scripts/backup-export.sh` 在服务器上运行：

- `pg_dump -U bookr -d bookr`（plain SQL）压缩为 `/srv/bookr/backups/db/bookr-<UTC时间戳>.sql.gz`，保留 30 天。
- 通过一次性容器（复用 MinIO 镜像自带的 `mc`）把 `bookr` 桶镜像到 `/srv/bookr/backups/minio/`。
- 写入 `manifest-<时间戳>.txt`（含 dump 大小与 SHA-256）并更新 `manifest.txt`。
- 任一步失败即以非 0 退出。

安装 cron（服务器）：

```cron
15 3 * * * /srv/bookr/scripts/backup-export.sh >> /var/log/bookr-backup.log 2>&1
```

可用环境变量：`BACKUP_ROOT`（默认 `/srv/bookr/backups`）、`COMPOSE_DIR`（默认 `/srv/bookr`）、`BACKUP_KEEP_DAYS`（默认 30）、`COMPOSE_NETWORK`（默认 `bookr_default`）。

### 7.2 备份 PC 拉取（每日，restic）

`scripts/pull-backup.sh` 在 5080 备份 PC（WSL 或 Windows 任务计划）上运行：

```bash
export BOOKR_BACKUP_SOURCE='bookr@server.example:/srv/bookr/backups'
export BOOKR_BACKUP_DEST="$HOME/bookr-backups"
export RESTIC_REPOSITORY='sftp:backup@nas.example:/srv/restic/bookr'
export RESTIC_PASSWORD_FILE="$HOME/.config/bookr/restic-password"
~/bin/pull-backup.sh
```

行为：`rsync -az --delete-after` 镜像到 `~/bookr-backups/`，然后 `restic backup --tag bookr`，最后 `restic forget --tag bookr --keep-daily 30 --prune`。任一步失败退出码非 0，便于监控告警。

Windows 任务计划可用：`wsl.exe -e bash -lc '~/bin/pull-backup.sh'`。建议服务器 03:15 导出、备份 PC 04:00 拉取。

### 7.3 从服务器本地备份恢复

```bash
cd /srv/bookr
docker compose stop web server

# 1) 数据库：重建空库后导入最新的 dump
docker compose exec -T postgres psql -U bookr -d postgres \
  -c 'DROP DATABASE IF EXISTS bookr WITH (FORCE);' \
  -c 'CREATE DATABASE bookr OWNER bookr;'
gunzip -c backups/db/bookr-<时间戳>.sql.gz \
  | docker compose exec -T postgres psql -U bookr -d bookr

# 2) MinIO：把备份镜像写回 bookr 桶（凭据取自 .env）
set -a; . ./.env; set +a
docker run --rm --network bookr_default \
  -e "MC_HOST_local=http://${S3_ACCESS_KEY}:${S3_SECRET_KEY}@minio:9000" \
  -v /srv/bookr/backups/minio:/backup \
  --entrypoint mc quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z \
  mirror --overwrite /backup local/bookr

docker compose up -d
curl -fsS http://localhost:8180/healthz
```

恢复后务必抽查：登录、书架列表、打开一本 PDF、下载/阅读一本 EPUB。每季度至少演练一次完整恢复。

### 7.4 异地恢复（服务器丢失或磁盘损坏）

服务器整机不可用时，本地 `/srv/bookr/backups` 一并丢失，必须从备份 PC 的 restic 仓库恢复。

**1. 在备份 PC 上取出最新快照**

```bash
export RESTIC_REPOSITORY='sftp:backup@nas.example:/srv/restic/bookr'
export RESTIC_PASSWORD_FILE="$HOME/.config/bookr/restic-password"

restic snapshots --tag bookr          # 确认最新快照时间
mkdir -p ~/bookr-restore
restic restore latest --tag bookr --target ~/bookr-restore
```

restic 会保留原始绝对路径。若 `BOOKR_BACKUP_DEST=$HOME/bookr-backups`，恢复后的布局为：

```text
~/bookr-restore/home/<用户名>/bookr-backups/
├── db/bookr-<时间戳>.sql.gz     # 最新的 Postgres dump
├── minio/                       # 最新的桶镜像（对象目录结构）
├── manifest-<时间戳>.txt        # 大小、SHA-256、对象数
└── manifest.txt -> manifest-<时间戳>.txt
```

`BOOKR_BACKUP_DEST` 不是默认值时，用 `find ~/bookr-restore -name manifest.txt` 定位目录。先按 manifest 校验 dump：

```bash
RESTORED="$(dirname "$(find ~/bookr-restore -name manifest.txt | head -n 1)")"
grep db_sha256 "$RESTORED/manifest.txt"
sha256sum "$RESTORED/db/bookr-<时间戳>.sql.gz"   # 两个哈希必须一致
```

**2. 在新服务器上准备空栈**

按第 3 节部署代码与 `.env`（数据库/MinIO 凭据保持与备份时一致），只启动存储：

```bash
cd /srv/bookr
docker compose up -d --wait postgres minio
```

**3. 把恢复数据送到新服务器**

```bash
# 在备份 PC 上执行；目录名按上一步的实际布局替换
rsync -az "$RESTORED/" bookr@new-server:/srv/bookr/restore/
```

**4. 恢复数据库与对象存储**

```bash
cd /srv/bookr
# 数据库：重建空库后导入异地 dump
docker compose exec -T postgres psql -U bookr -d postgres \
  -c 'DROP DATABASE IF EXISTS bookr WITH (FORCE);' \
  -c 'CREATE DATABASE bookr OWNER bookr;'
gunzip -c restore/db/bookr-<时间戳>.sql.gz \
  | docker compose exec -T postgres psql -U bookr -d bookr

# MinIO：把异地镜像写回 bookr 桶
set -a; . ./.env; set +a
docker run --rm --network bookr_default \
  -e "MC_HOST_local=http://${S3_ACCESS_KEY}:${S3_SECRET_KEY}@minio:9000" \
  -v /srv/bookr/restore/minio:/backup \
  --entrypoint mc quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z \
  mirror --overwrite /backup local/bookr

# 启动应用（迁移自动执行、桶已存在时自动跳过创建）
docker compose up -d --wait
curl -fsS http://localhost:8180/healthz
```

**5. 验证与收尾**

- `docker compose ps` 四个服务均为 healthy；`/healthz` 返回 `{"status":"ok"}`。
- 用管理员账号登录，核对书架数量与 `manifest.txt` 中的 `minio_files`/`minio_bytes` 是否接近。
- 随机打开一本 PDF、一本 EPUB 与一本 MOBI/AZW3（确认转换后的 EPUB 仍在）。
- 抽查数据库中最近一次上传/阅读记录存在。
- 恢复完成后重新配置服务器 cron（第 7.1 节），并让备份 PC 重新执行一次 `pull-backup.sh`，避免下一轮 `rsync --delete-after` 用到旧目录。
- 确认无误后再删除 `/srv/bookr/restore`。


## 8. 磁盘阈值

- 监控卷所在文件系统与 `/srv`：**75% 告警，90% 严重告警**。
  ```bash
  df -h /srv /var/lib/docker
  docker system df
  ```
- MinIO 数据增长 ≈ 累计上传量；备份目录再占一份镜像，restic 仓库因去重通常远小于原始大小。
- 空间不足时优先：清理旧镜像（`docker image prune`）、核对备份保留天数、扩容数据盘。不要在未备份时删除 `miniodata` 或 `pgdata` 卷。
- `docker compose down -v` 会删除全部命名卷，**绝不可**在恢复流程中使用。

## 9. HTTPS 与域名

默认 `web` 只监听宿主 `8180` 的 HTTP。启用域名与自动证书：

1. 域名 A/AAAA 记录指向服务器；路由器/防火墙放行 80、443。
2. 把 `Caddyfile` 的站点地址从 `:80` 改为域名，例如：
   ```
   bookr.example.com {
       encode zstd gzip
       # 其余内容保持不变
   }
   ```
3. 在 `docker-compose.yml` 中把 `web` 的端口改为 `'80:80'` 与 `'443:443'`；`caddy_data` 卷已挂载，证书会持久化。
4. 更新 `.env` 的 `CORS_ORIGIN=https://bookr.example.com,https://tauri.localhost,http://tauri.localhost,https://localhost,capacitor://localhost`（保留原生端源，否则桌面端/Android 端会被 CORS 拒绝），然后：
   ```bash
   docker compose up -d --build web
   docker compose up -d server
   ```
5. Caddy 会自动申请并续期 Let's Encrypt 证书；验证 `curl -fsS https://bookr.example.com/healthz`。

MinIO 控制台（9201）与 S3 API（9200）不经过 Caddy；如无跨机需求，建议仅绑定内网或直接删除这两条 `ports:` 映射。

## 10. 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | 是 | `bookr` 数据库角色密码 |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | 是 | MinIO root 凭据；secret 至少 8 字符，避免 `@ : /` |
| `JWT_SECRET` | 是 | 访问令牌签名密钥，至少 32 字符 |
| `LIBRARY_QUOTA_BYTES` | 否 | 共享库总配额，默认 80 GiB |
| `MEMBER_UPLOAD_QUOTA_BYTES` | 否 | 成员上传配额，默认 20 GiB |
| `LOGIN_RATE_LIMIT` | 否 | 每个 IP 的登录尝试上限，默认 10 |
| `CORS_ORIGIN` | 否 | 逗号分隔的允许源列表；默认 `http://localhost:8180,https://tauri.localhost,http://tauri.localhost,https://localhost,capacitor://localhost` |
| `VITE_API_BASE_URL` | 否 | 构建期 API 源。Web 同源部署留空；Tauri/Android 打包时设为 `https://your-domain`，并同时加入 `CORS_ORIGIN` |
| `MINIO_API_CORS_ALLOW_ORIGIN` | 否 | MinIO S3 API 的 CORS 允许源，默认 `*`（浏览器需直接读取预签名书籍文件） |
| `S3_PUBLIC_ENDPOINT` | 否 | 预签名上传/封面 URL 中供浏览器访问的 MinIO 地址；compose 默认 `http://localhost:9200`，跨机访问时改为公网地址 |
| `LOG_LEVEL` | 否 | `debug`/`info`/`warn`/`error`，默认 `info` |

`DATABASE_URL`、`S3_ENDPOINT`、`S3_REGION`、`S3_BUCKET`、`TRUST_PROXY` 由 compose 固定为容器网络内的值，无需在 `.env` 覆盖；`S3_PUBLIC_ENDPOINT` 必须是用户浏览器能解析的地址。

## 11. 故障排查

| 现象 | 排查 |
| --- | --- |
| `server` 反复重启 | `docker compose logs server`；启动会重试数据库/桶创建，60 秒后退出并打印失败步骤 |
| `web` 不健康 | `docker compose logs web`；确认 `server` 已 healthy（web 依赖其健康） |
| `/healthz` 502 | server 未就绪或崩溃；检查 `docker compose ps` |
| 上传后书一直“处理中” | 检查 worker 日志与 `jobs` 表；重启 server 会补投残留的 pending 元数据任务 |
| 登录提示限流 | `TRUST_PROXY` 必须为 `1`；确认只经 Caddy 访问 |
| 备份脚本失败 | 手动运行 `bash -x scripts/backup-export.sh`；确认 MinIO 容器运行且 `bookr_default` 网络存在 |
| 首次构建超时/磁盘不足 | Calibre 安装较大；清理 Docker 空间后重试，或将构建放到有更多磁盘的机器 |

## 12. 端到端验收测试（E2E）

E2E 使用 Playwright 驱动真实浏览器验证邀请注册、上传、编辑、筛选、删除与恢复，以及
阅读器的原版/重排切换、定位与划线。

```bash
# 首次运行安装 Chromium
pnpm --filter @bookr/web exec playwright install chromium

# 针对本机 Compose 栈运行（可用 E2E_BASE_URL 覆盖本地端口）
pnpm --filter @bookr/web e2e
```

- 前提：`docker compose up -d` 全部服务 healthy，且已存在管理员；默认使用 `admin`，可通过 `E2E_ADMIN_USERNAME` / `E2E_ADMIN_PASSWORD` 指定。
- 测试会**创建真实用户与邀请码、上传图书并软删除图书**（结束时留在回收站），还会清理此前 E2E 遗留的在架图书。请只对它使用一次性测试栈。
- 默认只允许 `localhost` / `127.0.0.1`；指向其他主机时测试会拒绝启动。仅在目标确实是可丢弃的测试环境时才设置 `E2E_ALLOW_REMOTE=1`。**永远不要对生产环境运行 E2E，也不要为生产设置该变量。**
- 阅读器与重排用例（`e2e/reader.spec.ts`、`e2e/reflow.spec.ts`）使用
  `apps/web/scripts/make-reader-fixtures.mjs` 在全局 setup 中重新生成的
  `reader.pdf`、`reader.epub` 与 `reader.bookr.json`。fixture 不入库；重排用例会
  上传重排包并切换模式，属于破坏性测试。


## 13. 阅读器功能

阅读器位于共享 Web 构建 `apps/web`，桌面端与 Android 端加载同一份产物，因此三端功能一致：

- **PDF**：原文模式渲染（pdf.js），带文本层，可直接选中文字；高亮与批注、笔记、书签、
  页面裁剪（crop）、目录（TOC）跳转；页码定位与阅读进度自动保存。
- **PDF 重排**：上传本地预处理工具生成的重排包后，可在「原版 / 重排」间一键切换；
  重排模式支持字体、字号、行距、页边距与主题调整；图片、表格、公式以原页裁绘保留；
  两种模式共享同一阅读位置，来回切换误差不超过 1 页。
- **EPUB**：分章/滚动阅读，主题切换（纸张、护眼、夜间）、字号与行距调整、目录跳转；
  文本高亮、批注与书签；阅读进度自动保存。
- 进度、批注与书签通过 `/api/books/:id/progress`、`/api/books/:id/annotations`、
  `/api/books/:id/bookmarks` 保存；离线/本地优先同步队列由 Plan 4 接入，DTO 与 locator
  契约不变。
- 书架支持格式/状态/分类筛选、搜索、排序、上传、编辑、封面上传、回收站恢复；
  EPUB/PDF 文件通过 MinIO 预签名 URL 直接读取。

### 13.1 重排包与相关 API

重排包（`.bookr.json`）由本地预处理工具生成，在 **书架 → 编辑（仅上传者/管理员）→
重排包** 上传。服务端会校验包的 schema 版本与完整结构、大小（≤32 MiB），以及包内
`source.sha256` 是否等于图书原始文件的哈希；同一本书同时只允许一个未完成的上传会话，
每本书最多保留一个包。重排包不计入书籍上传配额。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/books/:id/reflow/uploads` | 创建直传会话；请求体为 `{ size, sha256 }`（`sha256` 取自包内 `source.sha256`），返回预签名上传目标 |
| `POST` | `/api/books/:id/reflow/uploads/:uploadId/complete` | 校验上传的包并挂到图书，返回图书 DTO 与包摘要 |
| `GET` | `/api/books/:id/reflow` | 返回重排包的预签名下载地址、schema 版本与页数 |
| `DELETE` | `/api/books/:id/reflow` | 移除当前重排包 |

PDF 的阅读进度、批注与书签接口同时接受 `pdf` 与 `reflow` 两种 locator，因此切换模式
不会丢失位置或标注。

## 14. 本地 PDF 预处理工具

源码在 `tools/pdf-preprocess`，完整说明（参数、包结构、质量报告字段与限制）见
[`tools/pdf-preprocess/README.md`](tools/pdf-preprocess/README.md)。工具只在书籍所有者
的电脑上运行，**不部署到服务器**；服务器不做 OCR 或版面分析。工具本身除显式启用 AI
纠错外不发起网络请求，但 PaddleOCR 首次使用 OCR 时可能下载模型权重（2.x 到
`~/.paddleocr`，3.x 到 `~/.paddlex`）；离线环境请提前准备好模型。

需要 Python 3.10+：

```bash
cd tools/pdf-preprocess
python -m venv .venv
. .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -e '.[dev]'
pip install -e '.[ocr]'         # 可选：扫描版 PDF 的 OCR（paddle 需另行安装）
```

```bash
bookr-preprocess book.pdf --out book.bookr.json
bookr-preprocess scan.pdf --out scan.bookr.json --ocr auto --text-pdf scan-searchable.pdf
bookr-preprocess scan.pdf --out scan.bookr.json --ocr always --ai-correct --report scan.report.json
```

- `--out` 必填；源 PDF、输出包、报告和文字层 PDF 不能使用同一路径。`--force` 只控制
  `--out` 重排包是否覆盖；`--report` 与 `--text-pdf` 指向的已有文件会被直接覆盖。
- 退出码：`0` 成功，`2` 参数/输入/输出错误，`3` 缺少运行依赖。
- `--report` 写出质量报告，重点检查 `quality.fallbackPages`（整页回退）与
  `quality.warnings`；上传前建议在源 PDF 中逐页核对回退页。`--verbose` 打印全部警告。
- AI 纠错必须显式加 `--ai-correct` 并设置 `DEEPSEEK_API_KEY`；每块最多发送 4000 个
  UTF-16 单元的文本到 DeepSeek，不发送图像或整本书。
- 重排包包含书籍全文，请与书籍文件一起保管，不要提交到公开仓库。

生成后，在 **书架 → 编辑（仅上传者/管理员）→ 重排包** 选择 `.bookr.json` 上传。
服务端会校验包内 `source.sha256`、schema 版本与大小（≤32 MiB）；每本书最多一个包，
重排包不计入书籍配额。

## 15. 桌面端（Tauri 2）

源码在 `apps/desktop`，详见 `apps/desktop/README.md`。

前置条件：Node 22、pnpm 12、Rust stable；Windows 需安装 Visual Studio Build Tools 的
「使用 C++ 的桌面开发」工作负载（MSVC 链接器），WebView2 在 Windows 10/11 自带。

```bash
pnpm install
pnpm --filter @bookr/desktop dev      # 本地开发（Vite + Tauri 窗口）
pnpm --filter @bookr/desktop check    # cargo check

# 打包：必须把绝对 API 源烘焙进 Web 产物
VITE_API_BASE_URL=https://bookr.example.com pnpm --filter @bookr/desktop build
```

服务端 `CORS_ORIGIN` 必须包含 `https://tauri.localhost` 与 `http://tauri.localhost`（macOS/Linux 构建还需追加 `tauri://localhost`）；
预签名书籍 URL 的 `S3_PUBLIC_ENDPOINT` 必须是桌面端可达的地址。

## 16. Android 端（Capacitor 7）

源码在 `apps/mobile`，原生工程 `apps/mobile/android` 已生成并提交，详见
`apps/mobile/README.md`。

前置条件：**JDK 21**、Android Studio 与 Android SDK（Platform 35 / Build Tools /
Platform Tools），设置 `ANDROID_HOME`；`cap sync` 不依赖 JDK，但构建 APK 与
`cap open android` 需要完整环境。

```bash
VITE_API_BASE_URL=https://bookr.example.com pnpm --filter @bookr/web build
pnpm --filter @bookr/mobile sync      # 复制 Web 产物到 android/
pnpm --filter @bookr/mobile open      # 用 Android Studio 打开并运行
```

WebView 源为 `https://localhost`；`CORS_ORIGIN` 需包含 `https://localhost` 与
`capacitor://localhost`。生产环境不开启明文 HTTP（`usesCleartextTraffic`），API 与
预签名文件地址都必须是设备可达的 HTTPS 地址。

## 17. 已知范围

- 桌面安装包（MSI/DMG/AppImage）、代码签名、自动更新、Android 签名与 APK/AAB 分发
  均由 **Plan 8** 负责；本仓库当前只提供可编译、可开发的原生外壳。
- 原生端依赖服务端可访问：部署在局域网或本机时，手机/另一台电脑需要能解析并访问
  `VITE_API_BASE_URL` 与 `S3_PUBLIC_ENDPOINT`。
- 阅读进度目前走直连 API 保存（Plan 4 替换为本地优先同步）。
- 重排模式依赖本地生成的重排包：服务器不做 OCR 或版面分析，没有上传包时只能使用
  原版 PDF。
- 重排包是纯文本 JSON（≤32 MiB），不内嵌图片；图片、表格、公式均以源页裁绘显示。
  重排仅重新排版文字，表格与公式不会变成可重排的内容。
- 每本书最多保留一个重排包；重排包不计入书籍上传配额，重新上传会替换旧包。
