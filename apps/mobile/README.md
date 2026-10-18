# 纸墨书房 Android 端（Capacitor 7）

`apps/mobile` 是 BookrReader 的 Capacitor Android 外壳。与桌面端一样，它**不含阅读逻辑**：
`webDir` 指向 `../web/dist`，原生工程只是把同一份 Web 构建装入 WebView。

- 应用标识：`com.bookr.reader`
- 应用名：纸墨书房
- `server.androidScheme: 'https'`：WebView 内的源是 `https://localhost`
- Android 背景色：`#F6F1E7`

## 前置条件

- Node.js 22、pnpm 12。
- **JDK 21**（Android Gradle Plugin 要求；`java -version` 必须可用）。
- **Android Studio** 与 Android SDK（含 Platform 35、Build Tools、Platform Tools），并设置
  `ANDROID_HOME` / `ANDROID_SDK_ROOT`。
- 本机若缺少 JDK/SDK，`pnpm --filter @bookr/mobile sync` 仍可完成（只复制 Web 产物并更新
  Gradle 配置），但 `open` 与真正的 APK 构建会失败。

## 生成与同步

`android/` 已经生成并提交，**不要重复执行 `cap add android`**（只有删除整个
`android/` 目录后才需要）。日常流程：

```bash
# 1) 构建 Web 产物；打包给真机/模拟器时必须烘焙绝对 API 源
VITE_API_BASE_URL=https://bookr.example.com pnpm --filter @bookr/web build

# 2) 复制 Web 产物与插件配置到原生工程
pnpm --filter @bookr/mobile sync

# 3) 用 Android Studio 打开原生工程，连接设备后 Run
pnpm --filter @bookr/mobile open
```

`android/app/src/main/assets/public` 与 `capacitor.config.json` 是 `sync` 的生成物，
已被 `.gitignore` 忽略，不要手工修改；改配置请改 `capacitor.config.ts` 后重新 `sync`。

## 网络、API 源与 CORS

- WebView 源为 `https://localhost`，API 必须使用绝对 HTTPS 地址（`VITE_API_BASE_URL`）。
  省略该变量时应用会请求 WebView 自身的 `/api` 并失败。
- 服务端 `CORS_ORIGIN` 必须包含 `https://localhost` 与 `capacitor://localhost`
  （`docker-compose.yml` 的默认列表已包含）。
- 预签名 PDF/EPUB URL 由设备直接访问，`S3_PUBLIC_ENDPOINT` 必须是设备可达的公网/内网
  地址，且 MinIO/S3 需要允许来自应用源的 CORS 请求。
- 生产配置**不开启** `usesCleartextTraffic`：应用源是 `https://localhost`，请求明文
  HTTP API 会被 WebView 当作混合内容拦截。本地调试如需临时明文，只能使用未提交的临时
  改动（例如 Capacitor `server.cleartext` + 改 `androidScheme`），并在提交前还原；
  生产环境一律使用 HTTPS。

## 范围说明

本任务只提供可同步、可打开的 Android 工程。签名（keystore）、release APK/AAB、
商店分发与版本发布属于 **Plan 8**，不在本计划内。
