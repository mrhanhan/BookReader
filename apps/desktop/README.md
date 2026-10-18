# 纸墨书房桌面端（Tauri 2）

`apps/desktop` 是 BookrReader 的 Tauri 2 桌面外壳。它**不包含阅读逻辑**：窗口直接加载
`apps/web/dist`（开发时加载 Vite dev server），因此 PDF/EPUB 阅读器、批注与书签的修复
只需改 Web 端，三端同时生效。

- 应用标识：`com.bookr.reader`
- 产品名：纸墨书房
- 窗口：1200×800，最小 800×600

## 前置条件

- Node.js 22、pnpm 12（仓库根目录执行 `pnpm install`）。
- Rust stable（`rustup`，含 `cargo`）。
- Windows：安装 **Visual Studio Build Tools** 的「使用 C++ 的桌面开发」工作负载
  （提供 MSVC 链接器 `link.exe`）。`cargo check` 与打包都需要它。
- Windows 10/11 自带 WebView2；Linux 需要 `libwebkit2gtk-4.1-dev` 等 Tauri 系统依赖。
- `pnpm --filter @bookr/desktop check` 会在 `src-tauri/target/` 下编译依赖，首次运行需
  下载较多 crate。

## 开发

```bash
# 在仓库根目录执行：启动 Vite (:5173) 与 Tauri 窗口
pnpm --filter @bookr/desktop dev
```

`tauri.conf.json` 的 `beforeDevCommand` 会启动 `pnpm --filter @bookr/web dev`，`devUrl`
固定为 `http://localhost:5173`。Vite 已把 `/api` 代理到 `http://localhost:3000`，所以
开发模式下 `VITE_API_BASE_URL` 留空（同源）即可。

## 打包

打包后的应用没有同源后端，必须在构建 Web 产物时把 API 地址烘焙进 bundle，并要求服务端
`CORS_ORIGIN` 允许 Tauri 源（`https://tauri.localhost`、`http://tauri.localhost`）：

```bash
# Windows PowerShell
$env:VITE_API_BASE_URL='https://bookr.example.com'
pnpm --filter @bookr/desktop build

# Linux / macOS
VITE_API_BASE_URL=https://bookr.example.com pnpm --filter @bookr/desktop build
```

`tauri build` 会通过 `beforeBuildCommand` 重新执行 `pnpm --filter @bookr/web build`，
并继承同一个环境变量，因此上面的写法会把绝对 API 源写入最终 bundle。若省略该变量，
应用会请求 `tauri.localhost` 下的 `/api` 并失败。

部署侧还需：

```dotenv
# server 的允许源列表（逗号分隔），保留两个 Tauri 源
CORS_ORIGIN=https://bookr.example.com,https://tauri.localhost,http://tauri.localhost
# 预签名 PDF/EPUB URL 使用的、桌面端可访问的 MinIO/S3 地址
S3_PUBLIC_ENDPOINT=https://files.bookr.example.com
```

## 校验

```bash
pnpm --filter @bookr/desktop check   # cargo check --manifest-path src-tauri/Cargo.toml
```

图标由 `app-icon.svg` 生成，已提交到 `src-tauri/icons/`；修改标志后可重新生成：

```bash
pnpm --filter @bookr/desktop exec tauri icon app-icon.svg
```

## 范围说明

本任务只提供可编译、可开发的桌面外壳。安装包格式、代码签名、自动更新与分发属于
**Plan 8**，不在本计划内。
