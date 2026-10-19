# BookrReader 部署与运维手册

本文覆盖单台 Linux 服务器上的 Docker Compose 部署：首次启动、管理员引导、邀请码、升级、备份与恢复、磁盘阈值、HTTPS 域名以及安全红线。

## 1. 架构与端口

```
浏览器 ──HTTP──> web (Caddy :8180) ──/api/*、/healthz、/readyz──> server (Fastify :3000)
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
`/readyz` 同样经 Caddy 暴露，检查数据库与对象存储的可达性：两者都正常返回 200
`{"status":"ok"}`，否则返回 503 `{"status":"degraded"}`，适合作为容器/负载均衡的
就绪探针。

**补抓图书封面**（用于修复旧版本上传、首图为空白的书）：

```bash
docker compose exec -e COVER_BACKFILL_REFRESH=1 server node dist/cli/backfill-covers.js
# {"scanned":2,"updated":1,"failed":0}
```

不加 `COVER_BACKFILL_REFRESH` 时只处理还没有封面的书；`COVER_BACKFILL_LIMIT=N` 可限制本轮数量。

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

> 第 7 节的脚本依赖 GNU coreutils（`stat -c`、`du -sb`、`ls -t` 等），请在 Linux 或 WSL 的 Bash 中运行；macOS 自带工具不兼容。

### 7.1 服务器端导出（每日）

`scripts/backup-export.sh` 在服务器上运行：

- dump 前写入 `counts-<时间戳>.txt`（8 张核心表行数），作为恢复演练的下界。
- `pg_dump -U bookr -d bookr`（plain SQL）压缩为 `/srv/bookr/backups/db/bookr-<UTC时间戳>.sql.gz`，保留 30 天。
- 通过一次性容器（复用 MinIO 镜像自带的 `mc`）把 `bookr` 桶镜像到 `/srv/bookr/backups/minio/`。
- 写入 `manifest-<时间戳>.txt`（含 dump 大小与 SHA-256）并更新 `manifest.txt`。
- 配置了 `BOOKR_API_URL` 与 `BOOKR_BACKUP_TOKEN` 时，运行结束会向 `POST /api/admin/backup/heartbeat` 上报成功/失败心跳；上报失败只写日志警告，不影响备份自身的退出码。未配置 token 时脚本只打印提示并跳过上报（服务端仍会因备份静默而告警）。
- 任一步失败即以非 0 退出。

安装 cron（服务器）。心跳需要的变量放在环境文件里，避免把 token 写进 cron：

```bash
# /etc/bookr-backup.env（chmod 600），BOOKR_BACKUP_TOKEN 与 .env 的 BACKUP_TOKEN 相同
BOOKR_API_URL=http://127.0.0.1:8180
BOOKR_BACKUP_TOKEN=<与 BACKUP_TOKEN 相同的值>
```

```cron
15 3 * * * set -a; . /etc/bookr-backup.env; set +a; /srv/bookr/scripts/backup-export.sh >> /var/log/bookr-backup.log 2>&1
```

可用环境变量：`BACKUP_ROOT`（默认 `/srv/bookr/backups`）、`COMPOSE_DIR`（默认 `/srv/bookr`）、`BACKUP_KEEP_DAYS`（默认 30）、`COMPOSE_NETWORK`（默认 `bookr_default`）。

### 7.2 备份 PC 拉取（每日，restic）

`scripts/pull-backup.sh` 在 5080 备份 PC（WSL 或 Windows 任务计划）上运行：

```bash
export BOOKR_BACKUP_SOURCE='bookr@server.example:/srv/bookr/backups'
export BOOKR_BACKUP_DEST="$HOME/bookr-backups"
export RESTIC_REPOSITORY='sftp:backup@nas.example:/srv/restic/bookr'
export RESTIC_PASSWORD_FILE="$HOME/.config/bookr/restic-password"
# 心跳：token 须与服务器 .env 的 BACKUP_TOKEN 相同；不配置则脚本跳过上报
export BOOKR_API_URL='http://server.example:8180'
export BOOKR_BACKUP_TOKEN='<与服务器 BACKUP_TOKEN 相同>'
~/bin/pull-backup.sh
```

行为：`rsync -az --delete-after` 镜像到 `~/bookr-backups/`，然后 `restic backup --tag bookr`，最后 `restic forget --tag bookr --keep-daily 30 --prune`。任一步失败退出码非 0，便于监控告警。配置了 `BOOKR_BACKUP_TOKEN` 时运行结束向服务端上报 `backup-pc` 成功/失败心跳（`BOOKR_API_URL` 与 `BOOKR_BACKUP_TOKEN`，上报失败不影响退出码）；未配置时跳过上报并打印提示。

Windows 任务计划可用：`wsl.exe -e bash -lc '~/bin/pull-backup.sh'`（把上面的 `export` 放进 `~/.bashrc`，或在计划任务的命令行里一并传入）。建议服务器 03:15 导出、备份 PC 04:00 拉取。

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

### 7.5 恢复演练（每季度）

`scripts/restore-drill.sh` 在服务器上把备份恢复到临时库并校验，**不会写入或删除生产 `bookr` 库**：

```bash
cd /srv/bookr
./scripts/restore-drill.sh                 # 使用 db/ 下最新的 dump
./scripts/restore-drill.sh --dump /srv/bookr/backups/db/bookr-20261019T031500Z.sql.gz
./scripts/restore-drill.sh --keep          # 保留临时库供人工检查
```

行为：

1. 选择 dump（默认最新 `bookr-*.sql.gz`），并要求同一时间戳的 `counts-*.txt` 存在；缺失即判定备份不完整。
2. 在 `postgres` 服务内创建临时库 `bookr_drill_<UTC时间戳>`，把 dump 导入其中。
3. 在临时库统计核心表行数，与 `counts-*.txt` 逐项比较：恢复后的行数少于备份时记录的行数即 FAIL；多出仅作提示（计数在 dump 前采集，两次统计之间的新增写入属正常）。
4. 对比 `minio/` 镜像的文件数与总字节是否与 `manifest-<时间戳>.txt` 的 `minio_files` / `minio_bytes` 完全一致。该严格比较仅在演练最新 dump 时执行；用 `--dump` 显式演练历史备份时跳过并提示（`minio/` 目录总是累积到最新导出）。
5. 从临时库读出所有未删除图书引用的对象键（`file_key`、`cover_key`、`text_layer_key`、`reflow_key`、`epub_key`），逐个确认对象在备份镜像 `minio/` 中确实存在：行数与镜像总量吻合、但单个对象缺失的备份同样判为 FAIL（缺失键逐条列出，超过 10 条时折叠为一条汇总）。与上一项一致，该严格校验仅在演练最新 dump 时执行。
6. 输出 `PASS`/`FAIL` 摘要并写入 `/srv/bookr/backups/drills/<UTC时间戳>.log`；默认删除临时库，`--keep` 保留。

通过标准：8 张核心表（`users`、`books`、`reading_progress`、`annotations`、`bookmarks`、`reading_sessions`、`daily_stats`、`categories`）恢复后的行数不少于记录值（正常应相等）；演练最新 dump 时，MinIO 对象数与总字节还须和 manifest 完全一致，且数据库引用的对象在备份镜像中确实存在。任何一项不满足即判定 FAIL 并以非 0 退出。

已知边界（判断 FAIL 时先对照）：

- 导出先采集 dump、再镜像对象（见 `scripts/backup-export.sh`）。若某个在 dump 时刻仍被存活图书引用的对象，在两者之间的分钟级窗口内被删除（换封面、删除或替换重排包都会删掉旧对象），而它又尚未被更早的导出镜像过，演练会报该键缺失，而备份其实完好。镜像累积不删（`mc mirror` 不带 `--remove`），命中概率很低。
- 对象校验只覆盖 `books` 引用的对象；上传会话与重排会话的临时对象不在范围内（已完成的会话对象就是该书的 `file_key`，已被覆盖）。
- 只校验对象存在，不校验内容完整性：被截断或 0 字节的对象不会被发现（manifest 目前只记录 dump 的 `db_sha256`）。

演练后清理：

- 默认自动删除临时库；脚本异常中断时可手动执行：
  ```bash
  cd /srv/bookr
  docker compose exec postgres psql -U bookr -d postgres \
    -c 'DROP DATABASE IF EXISTS bookr_drill_<时间戳> WITH (FORCE);'
  ```
- 用 `--keep` 保留的临时库在检查完后用上面的命令删除。
- 保留 `drills/*.log` 作为季度演练记录；日志只含表名与行数，不含书籍正文或笔记内容。

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
| `AI_CONFIG_SECRET` | 否 | 加密 AI Key 的盐；缺省由 `JWT_SECRET` 派生，至少 32 字符 |
| `AI_API_KEY` | 否 | 首次启动时加密写入数据库；已有配置不会被覆盖 |
| `AI_BASE_URL` | 否 | OpenAI 兼容端点，默认 `https://api.deepseek.com/v1` |
| `AI_CHAT_MODEL` / `AI_REASONER_MODEL` | 否 | 默认 `deepseek-chat` / `deepseek-reasoner` |
| `AI_CONTEXT_TOKEN_BUDGET` | 否 | 每次请求的上下文 token 预算，默认 8000 |
| `AI_REQUEST_TIMEOUT_MS` | 否 | 上游请求超时，默认 60000 |
| `AI_FAKE_PROVIDER` | 否 | `1` 启用本地假提供方；仅限 E2E/演示，生产禁用 |
| `BACKUP_TOKEN` | 否 | 备份脚本心跳的共享密钥，至少 32 字符；脚本端通过同值的 `BOOKR_BACKUP_TOKEN` 发送。未配置时该通道关闭，管理员 JWT 仍可调用心跳接口 |
| `BOOKR_API_URL` | 否 | 备份脚本上报心跳的服务端地址，默认 `http://127.0.0.1:8180`；在备份 PC 上需改为可访问的服务器地址 |
| `BOOKR_BACKUP_TOKEN` | 否 | 备份脚本发送的 `X-Backup-Token`，须与服务端 `BACKUP_TOKEN` 一致；未配置时脚本跳过心跳上报（仅打印提示） |
| `BOOKR_HEARTBEAT_URL` | 否 | 备份脚本侧覆盖完整心跳端点；缺省由 `BOOKR_API_URL` 拼接 `/api/admin/backup/heartbeat` |
| `ALERT_WEBHOOK_URL` | 否 | 备份失败/备份机静默/磁盘不足时投递告警的 Webhook（仅 `http:`/`https:`）；留空不发送 |
| `DISK_ALERT_FREE_BYTES` | 否 | 备份卷剩余空间告警阈值（字节），默认 `10737418240`（10 GiB） |
| `BACKUP_STALE_HOURS` | 否 | 超过多少小时没有成功备份即告警，默认 24，范围 1–168 |
| `MONITOR_INTERVAL_MS` | 否 | 服务端监控循环间隔（毫秒），默认 300000，范围 60000–3600000 |
| `BACKUP_HEARTBEAT_DRY_RUN` | 否 | 备份脚本侧调试用；设为 `1` 时只打印心跳 JSON 不发送 |

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
| AI 面板提示「尚未配置」 | 检查 `GET /api/admin/ai`；设置 `AI_API_KEY` 或通过管理员 API 录入 Key |
| AI 提示额度用尽 | 检查 `GET /api/ai/usage` 的日/月窗口；管理员可调整该成员额度或等待用户时区跨天 |
| AI 上游超时/不可用 | 检查 `AI_BASE_URL`、网络与 Key；server 日志只记录 token 计数与错误名，不含正文 |

## 12. 端到端验收测试（E2E）

E2E 使用 Playwright 驱动真实浏览器，共 **9 个 spec、21 条用例**，覆盖邀请注册、上传、
编辑、筛选、删除与恢复，阅读器的原版/重排切换、定位与划线，同步与离线，AI 伴读，
笔记库，阅读统计，管理后台以及 PWA 可安装性。

```bash
# 首次运行安装 Chromium
pnpm --filter @bookr/web exec playwright install chromium

# 针对本机 Compose 栈运行全部用例（可用 E2E_BASE_URL 覆盖本地端口）
pnpm --filter @bookr/web e2e
# 等价的直接调用方式
pnpm --filter @bookr/web exec playwright test

# 只跑管理后台或 PWA
pnpm --filter @bookr/web exec playwright test e2e/admin.spec.ts e2e/pwa.spec.ts
```

| spec | 用例数 | 覆盖内容 |
| --- | --- | --- |
| `ai.spec.ts` | 4 | 选中解释、页面总结、离线禁用、设置开关 |
| `bookshelf.spec.ts` | 1 | 邀请注册、上传、编辑、筛选、删除与恢复 |
| `notes.spec.ts` | 3 | 检索筛选与跳回原文、Markdown 导出、AI 分析 |
| `reader.spec.ts` | 2 | PDF/EPUB 阅读、划线批注书签、进度恢复 |
| `reflow.spec.ts` | 1 | 重排模式、双模式位置保持、重排划线 |
| `stats.spec.ts` | 2 | 有效阅读日与 30 天图表、连续天数 |
| `sync.spec.ts` | 5 | 跨设备 5 秒同步、离线合并、离线阅读与缓存 |
| `admin.spec.ts` | 2 | 注册开关/审计日志、备份心跳与状态页 |
| `pwa.spec.ts` | 1 | manifest、standalone、三个 PNG 图标 |

- 前提：`docker compose up -d` 全部服务 healthy，且已存在管理员；默认使用 `admin`，可通过 `E2E_ADMIN_USERNAME` / `E2E_ADMIN_PASSWORD` 指定。
- 测试会**创建真实用户与邀请码、上传图书并软删除图书**（结束时留在回收站），还会清理此前 E2E 遗留的在架图书。请只对它使用一次性测试栈。
- AI 用例（`e2e/ai.spec.ts`）要求 `AI_FAKE_PROVIDER=1`；在 `.env` 设置后 `docker compose up -d server`。未设置时该套件会在 `beforeAll` 明确失败。
- 默认只允许 `localhost` / `127.0.0.1`；指向其他主机时测试会拒绝启动。仅在目标确实是可丢弃的测试环境时才设置 `E2E_ALLOW_REMOTE=1`。**永远不要对生产环境运行 E2E，也不要为生产设置该变量。**
- 管理用例（`e2e/admin.spec.ts`）会临时关闭注册开关，并在 `finally` 中重新打开；备份用例只追加心跳记录、不做清理（历史表只读展示）。
- PWA 用例（`e2e/pwa.spec.ts`）直接经公开入口读取 manifest 与图标，验证 200 与 `image/png`。
- 阅读器与重排用例（`e2e/reader.spec.ts`、`e2e/reflow.spec.ts`）使用
  `apps/web/scripts/make-reader-fixtures.mjs` 在全局 setup 中重新生成的
  `reader.pdf`、`reader.epub` 与 `reader.bookr.json`。fixture 不入库；重排用例会
  上传重排包并切换模式，属于破坏性测试。
- 完整验收标准与手动项（真实计时、三端走查、恢复演练）见
  [`docs/operations/acceptance-checklist.md`](docs/operations/acceptance-checklist.md)。


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
- **手机浏览器（H5）**：顶部导航与阅读工具栏自适应窄屏；书架、回收站使用滚动分页
  （接近底部自动加载，另提供「加载更多」按钮兜底）；卡片操作收进书口图标轨，
  触控目标不小于 44px。
- **手势与缩放**：PDF 原版模式支持 `Ctrl/⌘ + 滚轮`、触控板捏合、双指捏合与双击缩放；
  单页/双页 PDF 与分页 EPUB 支持左右滑动翻页；底部工具栏提供「− / 比例 / + / 适应」
  与页码跳转。缩放手势停止 400ms 后写入阅读设置，不会在滑动过程中反复落盘。
- **封面**：PDF 会跳过空白首页（最多检查前 3 页），EPUB 支持 `cover-image`、
  `meta name="cover"`、`guide type="cover"` 与文件名启发式；MOBI/AZW3 转换后从 EPUB
  取封面。历史图书可用上文的回填命令补图。

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

## 14. 同步与离线

阅读数据采用本地优先模型：进度、批注、书签与阅读设置先写入浏览器 IndexedDB（Dexie）并进入 outbox，由同步引擎在网络可用时批量推送；服务端为每个用户维护单调递增的 `sync_changes` 变更日志，设备凭游标增量拉取，在线设备同时通过 SSE 接收变更（批注/书签通常 5 秒内到达另一台设备）。

**同步范围**：仅四类每用户实体——阅读进度、批注、书签、阅读设置。图书元数据与分类是书架级共享数据、以服务端为权威，不进入变更日志；离线时书架从 IndexedDB 中的书架快照读取。

**端点**

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/sync/push` | 推送最多 100 条本地变更；返回 `applied`、`skipped`、`rejected` 与本批回执 `cursor` |
| `GET` | `/api/sync/pull?since&limit` | 按游标增量拉取变更（默认 200 条，上限 500）；游标过旧时返回 `reset` |
| `GET` | `/api/sync/snapshot` | 返回该用户全部在线数据与快照游标；新设备首次登录或 `reset` 后使用 |
| `POST` | `/api/sync/stream-token` | 签发 60 秒有效的流令牌（SSE 无法携带 Authorization 头） |
| `GET` | `/api/sync/stream?token&since` | SSE 变更流；先补发游标之后的历史，再推送实时变更 |
| `GET` | `/api/devices` | 列出当前账号的已登录设备 |
| `PATCH` | `/api/devices/:id` | 重命名设备（`name`，传 `null` 清除） |
| `DELETE` | `/api/devices/:id` | 撤销设备：其刷新令牌失效，绑定该设备的访问令牌被拒绝 |

**游标语义**

- `pull` 返回本页最后一条变更的 `revision`；空页与 `reset` 返回请求里的 `since`。客户端只有在 `hasMore: false` 的最后一页之后才推进到更靠后的位置，避免跳过本页之后的变更。
- `snapshot.cursor = max(该用户日志最大 revision, 全局清理水位)`；设备用快照重建后从这里继续拉取。新设备首次登录没有本地游标，会先拉一次快照。
- `push.cursor` 只是本批回执（没有应用任何变更时为 0），不是 pull 游标。

**冲突规则**

- 进度、书签、阅读设置：按「客户端更新时间 + 服务端接收顺序」做 LWW。客户端时钟超前服务端 5 分钟以上时改用服务端接收时间，避免一台设备的错误时钟永久压制后续修改。
- 批注：逐条合并，不整表覆盖；编辑笔记时旧文字写入 `annotation_history`（含设备与时间），不会丢失。
- 删除：批注/书签软删除并保留墓碑，变更日志与墓碑在 90 天后由每日清理任务移除；超过 90 天未同步的设备会收到 `reset` 并重新拉快照。
- 同一用户的日志写入在事务内取 `pg_advisory_xact_lock(hashtext(userId))`，使 revision 按提交顺序对该用户可见，游标不会跨过尚未提交的变更。

**实时流**

- SSE 连接使用 60 秒流令牌；断线后按最后游标重连并补齐缺口，客户端按 1/2/5/15/30 秒退避重试；服务端每 25 秒发送 `: ping` 心跳。游标早于保留窗口时服务端发送 `reset`，客户端改用快照重建。
- 本地写入后约 2 秒触发一次推送；`online`、页面重新可见与 60 秒心跳也会触发同步。

**离线阅读**

- 每台设备保留最近阅读的 5 本未固定书籍，手动固定的书不受淘汰限制；缓存文件优先写入 OPFS，不可用时退化为 IndexedDB（再退回内存）。
- 清理缓存（单本移出或批量清理未固定书籍）只删除书籍文件与缓存记录，绝不影响 `outbox`、进度、批注、书签等未同步数据。
- 离线冷启动时使用 localStorage 中缓存的 `bookr.me` 资料恢复会话，只有服务端明确返回 401/403 才登出；网络错误或服务不可达不会清空令牌，已缓存的书仍可打开。
- 阅读进度在**打开书籍时对齐**：在线时最多等待首轮 pull 1.5 秒再读取本地位置，离线或超时直接使用本地记录；阅读过程中不跟随远端进度。批注与书签仍随 SSE 实时更新。
- 离线应用外壳（页面与 pdf.js 运行时资源）由 Service Worker 缓存，首次在线加载后生效，断网时可直接重新打开已缓存的书。

**设置页**：`/settings` 汇总同步状态、待同步变更数、上次同步时间与「立即同步」，展示离线缓存用量及每本书的固定/移出操作，并列出已登录设备（可重命名或撤销）。

## 15. AI 伴读

阅读器的 AI 伴读提供三种能力：选中段落「解释」、总结当前页/章、在同一线程内追问。
回答由服务端 AI 网关流式转发（SSE），浏览器只负责采集选中文字与当前页/章的必要片段。
线程与消息按用户隔离、按书保存，可在 AI 面板的「历史」中回看或删除。

### 15.1 配置服务商

服务端默认使用 OpenAI 兼容协议，默认端点为 `https://api.deepseek.com/v1`，默认模型
`deepseek-chat`（解释/总结/追问）与 `deepseek-reasoner`（笔记分析）。API Key
以 AES-256-GCM 加密存于数据库，永不下发浏览器。两种配置方式：

1. **首次启动引导**：在 `.env` 设置 `AI_API_KEY`（可同时设置 `AI_BASE_URL`、
   `AI_CHAT_MODEL`、`AI_REASONER_MODEL`），启动后服务端会把它们加密写入 `ai_config`。
   确认写入后可把 `AI_API_KEY` 从 `.env` 移除，数据库保留密文；已有配置不会被重启覆盖。
2. **管理员 API**：登录管理员后直接修改（`PUT` 省略 `apiKey` 表示保留旧 Key）：

```bash
curl -X PUT http://localhost:8180/api/admin/ai   -H "Authorization: Bearer $ADMIN_TOKEN"   -H "Content-Type: application/json"   -d '{"apiKey":"'"$AI_KEY"'","chatModel":"deepseek-chat"}'

curl http://localhost:8180/api/admin/ai -H "Authorization: Bearer $ADMIN_TOKEN"
curl -X DELETE http://localhost:8180/api/admin/ai -H "Authorization: Bearer $ADMIN_TOKEN"
```

`AI_CONFIG_SECRET` 可选；缺省时加密密钥由 `JWT_SECRET` 经 HKDF 派生。轮换
`JWT_SECRET`（或显式 `AI_CONFIG_SECRET`）后，已存 Key 无法解密，需要重新录入。
Base URL 仅允许 HTTPS；`localhost`、`127.0.0.1`、`[::1]`、`host.docker.internal`
允许 HTTP，便于本地模型与测试。

### 15.2 隐私与配额

- 每次请求只发送：书名、作者、位置、选中文字、当前页或本章的文字片段、用户问题。
  不发送整本书；扫描版 PDF 没有文字层时会明确说明材料不足。
- 服务端按 8k token 预算裁剪上下文（`AI_CONTEXT_TOKEN_BUDGET`），日志不记录正文、
  选中文字、问题或回答。
- 每用户默认每日 100,000、每月 1,000,000 tokens；管理员可通过
  `PATCH /api/admin/members/:id` 的 `aiDailyTokenLimit` / `aiMonthlyTokenLimit` 调整。
  窗口按用户时区计算，用户可在设置页关闭 AI。
- 失败、超时或额度用尽时，问题仍保留在线程或输入框中，可重试。

### 15.3 本地假提供方（仅测试）

E2E 与本地演示可设置 `AI_FAKE_PROVIDER=1`，服务端用确定性的假提供方替代真实网关
（流式、配额、持久化路径不变）。**生产环境严禁设置该变量**；启动日志会打印警告，
设置页会显示「当前使用本地假提供方（仅用于测试）」。

## 16. 笔记库与 AI 分析

所有书上的划线、批注汇入一个按用户隔离的全局笔记库：`/notes`。笔记库以服务端为准，
需要联网使用；离线时仍可阅读已缓存的书并在阅读器内记笔记，联网后由同步队列汇入。

**检索与筛选**

- 搜索 `q` 同时匹配划线原文与批注文字，按字面量比较（`%`、`_` 不作通配符）。
- `bookId`、`tag`、`type`（`highlight` / `note`）、`from` / `to`（`YYYY-MM-DD`，按用户时区，
  含首尾）可组合；缺失的筛选表示不限制。仅返回自己的、未删除的笔记，且书仍在书架上。
- 列表按最近编辑倒序分页；页面滚动到底自动续页，另有「加载更多」按钮兜底。
- 按书分组视图把当前已加载的笔记按书聚合；标签下拉来自 `/api/notes/tags`（按使用次数排序）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/notes` | 分页查询；返回 `{ items, total, page, pageSize }`，每条含书 id/书名/作者/格式 |
| `GET` | `/api/notes/tags` | 返回 `{ items: [{ tag, count }] }` |
| `GET` | `/api/notes/export` | 按同一组筛选导出 Markdown 附件，最多 5000 条 |
| `POST` | `/api/notes/analyses` | 对当前筛选下的笔记做 AI 分析，SSE 流式返回 |
| `GET` | `/api/notes/analyses` | 最近 20 条已完成/中断/失败的分析 |
| `GET/DELETE` | `/api/notes/analyses/:id` | 读取或删除自己的分析记录（他人一律 404） |

**导出**：每个书只出现一个 `## 《书名》 · 作者` 标题，笔记按创建时间排列，含位置、
`> 划线原文`、批注、标签与 `*YYYY-MM-DD*`；批注中可能形成 Markdown 块的行首符号会被转义。
文件名优先 `filename*=UTF-8`（如 `笔记-书名-20261019.md`），并提供 ASCII 回退。

**AI 分析**

- 三种方式：主题归纳、观点梳理、待办提取；默认使用 `AI_REASONER_MODEL`（默认
  `deepseek-reasoner`），流式返回并保存为可回看的分析记录。
- 只分析当前筛选范围内的笔记，最多取最近编辑的 300 条；上下文预算 24k tokens，
  超出时保留较新的笔记并在提示词中说明。每条只发送书名、位置、划线（≤600 字）、
  批注（≤400 字）、标签与日期，不发送整本书。
- 沿用 P5 的 AI 开关、服务商配置与日/月 token 配额；空范围在预占配额前返回
  `VALIDATION_FAILED`（`details.reason = "no_notes"`）。停止生成时已生成内容保存为
  `interrupted`，上游失败保存为 `failed`，都不会丢失已生成文本。
- 面板支持停止、回看历史、两步删除；移动端为底部抽屉，Esc 关闭，焦点在面板内循环。

**跳回原文**：笔记卡片的「跳回原文」使用 `/books/:id/read?note=<annotationId>`；
阅读器从本地批注解析定位器并闪烁高亮，找不到时提示一次并停留在上次位置；若首轮同步
超时导致本地尚无该批注，后续同步到账后仍会补跳。

**隐私**：笔记库与分析记录都按用户隔离；服务端请求日志会剔除搜索词 `q` 与标签 `tag`，
不记录笔记正文；AI 分析只发送当前筛选范围内的必要摘录（书名、位置、划线、批注、标签、
日期），不发送整本书。

**管理/运维**：笔记库不新增环境变量；`note_analyses` 随用户删除级联；进程崩溃可能
留下 `streaming` 分析行（历史列表会隐藏），其配额预占由每日清理在 1 小时后回收。
删除笔记仍是软删除并保留墓碑，回收站的展示/恢复沿用阅读器与同步的既有语义。

## 17. 阅读统计与坚持

阅读器在前台且可见时计时，每 30 秒打点一次；页面隐藏、窗口失焦或连续 2 分钟无操作都会暂停。2 分钟空闲即结束当前会话，再次操作开始新会话；单段累计 30 分钟自动分段，避免一次会话跨度过大。会话先写入本地 IndexedDB，经 P4 同步通道（`reading_session` 实体）离线排队，联网后补传；重复推送与乱序心跳不会重复计时或回退已有时长。

统计口径：

- **有效阅读日**：当天累计有效阅读 ≥ 10 分钟（600 秒）。
- **坚持天数**：截至今天；今天尚未达标时截至昨天。中间断一天即停止。
- **时区**：按用户在设置页选择的 IANA 时区（默认 `Asia/Shanghai`）划分自然日。修改时区会按新时区重建该用户的每日聚合，跨时区旅行不重复、不丢失。
- **跨午夜**：会话按墙钟重叠比例拆分到两个自然日。

数据来源是 `reading_sessions` 聚合出的 `daily_stats`；聚合在会话写入时完成，统计读取只读，不影响阅读性能。统计页展示连续天数、累计有效天数、今日/本周/本月时长、最近 30 天柱状图、读完的书（书架状态为「已读完」的未删除图书）与最常读的书（全时有效阅读时长最高）。

接口：

- `GET /api/stats`：返回调用者自己的统计（`ReadingStatsDto`），未登录 401。
- `PATCH /api/auth/me`：`{ "timezone": "Asia/Shanghai" }`，校验 IANA 时区并重建每日聚合。

隐私与运维：统计严格按 `user_id` 隔离，管理员也不能读取他人统计；日志不记录书籍正文或笔记内容。同步日志中的会话心跳会随 90 天保留策略一起清理。

## 18. 管理后台

管理员登录后，顶部导航出现 **管理** 入口；四个分页（成员 / 设置 / 审计 / 备份）分别对应
`/admin/members`、`/admin/settings`、`/admin/audit`、`/admin/backups`。所有页面在 360px
宽度下不横向滚动，表格放入可安全横向滚动的容器；危险操作（停用成员、重置密码、撤销邀请码）
都有说明文案或二次确认。

**成员与邀请（`/admin/members`）**

- 成员列表显示显示名、用户名、角色、状态与上传用量；可停用/启用成员、重置密码
  （会立即撤销其在所有设备上的登录）、调整上传配额。
- AI 配额：为每位成员单独开关 AI 伴读，并设置每日/每月 token 上限；留空表示不修改。
- 邀请码：生成一枚一次性邀请码（默认 72 小时有效），复制后交给新成员；未使用的邀请码
  可撤销。每枚邀请码只能启用一位成员。
- 存储用量：共享书库总量、每位成员用量与最大的 10 本书。

**系统设置（`/admin/settings`）**

- **注册开关**：关闭后即使持有有效邀请码也不能创建新账号；已登录成员不受影响。
  保存后写入审计日志。
- **默认时区**：只作用于新注册成员（用于统计自然日与 AI 配额窗口），修改不会回算已有成员。
- **AI 服务商**：Base URL、对话模型、推理模型与 API Key。Key 只保存在服务器
  （AES-256-GCM 加密），保存后不会再返回浏览器；留空表示保持现有 Key。
  `AI_FAKE_PROVIDER=1` 时显示“本地假提供方”，表单禁用。

**审计日志（`/admin/audit`）**

按时间倒序分页展示登录、注册、删除图书、修改成员、创建/撤销邀请码、修改系统设置与更新
AI 配置等动作，含操作者、对象与元数据预览。日志只读；元数据不包含书籍正文、笔记内容、
AI Key 或备份 token。

**备份与告警（`/admin/backups`）**

- 状态卡：最近成功备份时间、备份机最近上报时间、磁盘可用空间。
- 告警提示：备份超过设定时长未成功、备份机超过设定时长未上报、磁盘低于阈值。
- 备份记录：两个来源（服务器导出 / 备份机）的最近 20 条心跳，含时间、状态、大小与说明。
- 告警历史：Webhook 投递状态（已发送 / 发送失败）与时间，便于排查告警通道。

心跳由 `scripts/backup-export.sh` 与 `scripts/pull-backup.sh` 上报；也可手动调用：

```bash
curl -X POST http://localhost:8180/api/admin/backup/heartbeat \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"source":"server-export","status":"success",
       "startedAt":"2026-10-19T03:00:00+08:00","finishedAt":"2026-10-19T03:05:00+08:00"}'
```

**权限**：管理页面仅对 `role = admin` 显示；`/api/admin/*` 接口统一要求登录且为管理员，
成员访问返回 403、未登录返回 401（备份心跳是唯一例外，可用 `X-Backup-Token`）。
本仓库不内置后台截图，界面以实际运行结果为准；移动端布局与可访问性由
`apps/web/src/features/admin/__tests__/` 的组件测试和 E2E 覆盖。

## 19. 本地 PDF 预处理工具

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

## 20. 桌面端（Tauri 2）

源码在 `apps/desktop`，详见 `apps/desktop/README.md`。

前置条件：Node 22、pnpm 12、Rust stable；Windows 需安装 Visual Studio Build Tools 的
「使用 C++ 的桌面开发」工作负载（MSVC 链接器），WebView2 在 Windows 10/11 自带。

```bash
pnpm install
pnpm --filter @bookr/desktop dev      # 本地开发（Vite + Tauri 窗口）
pnpm --filter @bookr/desktop check    # cargo check

# 发布：构建 Web 产物后打包 NSIS 与 MSI（必须烘焙绝对 API 源）
VITE_API_BASE_URL=https://bookr.example.com pnpm build:desktop
```

产物位于 `apps/desktop/src-tauri/target/release/bundle/{nsis,msi}/`。完整的版本对齐、
签名与发布前检查见 [`docs/operations/native-builds.md`](docs/operations/native-builds.md)。

服务端 `CORS_ORIGIN` 必须包含 `https://tauri.localhost` 与 `http://tauri.localhost`（macOS/Linux 构建还需追加 `tauri://localhost`）；
预签名书籍 URL 的 `S3_PUBLIC_ENDPOINT` 必须是桌面端可达的地址。

## 21. Android 端（Capacitor 7）

源码在 `apps/mobile`，原生工程 `apps/mobile/android` 已生成并提交，详见
`apps/mobile/README.md`。

前置条件：**JDK 21**、Android Studio 与 Android SDK（Platform 35 / Build Tools /
Platform Tools），设置 `ANDROID_HOME`；`cap sync` 不依赖 JDK，但构建 APK 与
`cap open android` 需要完整环境。

```bash
VITE_API_BASE_URL=https://bookr.example.com pnpm build:android
```

脚本依次执行 Web 构建、`cap sync android` 与 `./gradlew assembleRelease`，并打印 APK 路径。
发布签名使用 `apps/mobile/android/keystore.properties`（`*.jks` 与密码文件不入库），
签名步骤与版本号规则见 [`docs/operations/native-builds.md`](docs/operations/native-builds.md)。
日常调试也可只同步后用 Android Studio 打开：

```bash
pnpm --filter @bookr/mobile sync
pnpm --filter @bookr/mobile open
```

WebView 源为 `https://localhost`；`CORS_ORIGIN` 需包含 `https://localhost` 与
`capacitor://localhost`。生产环境不开启明文 HTTP（`usesCleartextTraffic`），API 与
预签名文件地址都必须是设备可达的 HTTPS 地址。

## 22. 已知范围

- Web 端可安装为 PWA：`manifest.webmanifest`、`display: standalone` 与三个 PNG 图标已经
  提供，安装入口由浏览器决定；iOS 仍使用「添加到主屏幕」，不提供推送。
- 桌面安装包由 `pnpm build:desktop` 产出 NSIS/MSI，Android APK 由 `pnpm build:android`
  产出；前者需要 Rust/MSVC/WebView2，后者需要 JDK 21 与 Android SDK。仓库只提供
  可复现的配置与脚本，**不附带已签名产物**；签名材料与证书不得入库。详见
  [`docs/operations/native-builds.md`](docs/operations/native-builds.md)。
- 恢复演练（`scripts/restore-drill.sh`）恢复最近 dump 到临时库并核对行数与 MinIO manifest；
  它不覆盖整机丢失后的域名切换与 DNS 切换，这部分按 README §7.4 人工执行。演练记录保存在
  `backups/drills/`，验收标准见
  [`docs/operations/acceptance-checklist.md`](docs/operations/acceptance-checklist.md)。
- 原生端依赖服务端可访问：部署在局域网或本机时，手机/另一台电脑需要能解析并访问
  `VITE_API_BASE_URL` 与 `S3_PUBLIC_ENDPOINT`。
- 阅读数据（进度、批注、书签、阅读设置）走本地优先同步；图书元数据与分类以服务端为权威，不进同步日志，离线时由书架快照提供只读元数据。
- 重排模式依赖本地生成的重排包：服务器不做 OCR 或版面分析，没有上传包时只能使用
  原版 PDF。
- 重排包是纯文本 JSON（≤32 MiB），不内嵌图片；图片、表格、公式均以源页裁绘显示。
  重排仅重新排版文字，表格与公式不会变成可重排的内容。
- 每本书最多保留一个重排包；重排包不计入书籍上传配额，重新上传会替换旧包。
