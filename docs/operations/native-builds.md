# 原生发布构建

本文件说明 BookrReader（纸墨书房）桌面端（Tauri 2）与 Android 端（Capacitor 7）的发布构建流程。
桌面与移动共享同一版本号，发布前必须通过 `pnpm check:native`。

## 版本号

以下位置必须保持一致：

| 位置 | 字段 | 校验方式 |
| --- | --- | --- |
| `apps/desktop/package.json` | `version` | `pnpm check:native` |
| `apps/mobile/package.json` | `version` | `pnpm check:native` |
| `apps/desktop/src-tauri/tauri.conf.json` | `version` | `pnpm check:native` |
| `apps/mobile/android/app/build.gradle` | `versionName`、`versionCode` | `pnpm check:native`（`versionCode` 手动核对） |
| `apps/desktop/src-tauri/Cargo.toml` | `[package] version` | 手动核对 |

`versionCode` 是 Android 的单调递增整数，每次向应用商店提交都必须加大；`versionName` 使用语义化版本。

升级步骤：

1. 修改上述三个由 `check:native` 校验的 `version` 字段为同一新版本（例如 `0.3.0`），
   并手动同步 `apps/desktop/src-tauri/Cargo.toml` 的 `[package] version`。
2. 将 `build.gradle` 的 `versionName` 改为同一版本，并把 `versionCode` 加 1。
3. 运行 `pnpm check:native`，七项检查全部 OK 后再构建。
4. 更新更新日志。

## Web 前端与 API 地址

桌面与 Android 的界面都来自 `apps/web` 的构建产物，**API 地址在构建时被编译进产物**，因此：

- 打包前必须设置 `VITE_API_BASE_URL`（例如 `https://bookr.example.com`），不要使用默认的 `localhost`。
- 服务端必须允许该来源的跨域请求（CORS）。生产环境把面板域名（含 Tauri 的 `tauri://localhost`/`http://tauri.localhost` 与 Capacitor 的 `https://localhost`）加入服务端允许来源。
- Android 使用 `server.androidScheme: 'https'`，页面来源为 `https://localhost`，CORS 白名单需要包含它。

## Windows 桌面（NSIS / MSI）

前置条件：Node 22、pnpm、Rust stable、WebView2、WiX（Tauri 构建 MSI 时自动处理）。

```bash
VITE_API_BASE_URL=https://bookr.example.com pnpm build:desktop
```

脚本依次执行 `pnpm --filter @bookr/web build` 与 `pnpm --filter @bookr/desktop build`（即 `tauri build`），
产物位于：

- `apps/desktop/src-tauri/target/release/bundle/nsis/*.exe`
- `apps/desktop/src-tauri/target/release/bundle/msi/*.msi`

`tauri.conf.json` 的 `bundle.targets` 固定为 `["nsis", "msi"]`，面向 Windows 发布。

MSI 必须声明 `bundle.windows.wix.language`（当前为 `zh-CN`）。产品名是中文「纸墨书房」，
而未声明该字段时 Tauri 会按 `en-US` 生成 WiX 本地化文件 `locale.wxl`（`TauriCodepage=1252`），
MSI 数据库代码页取自它，无法表示汉字，WiX `light.exe` 随即报 `LGHT0311`，**MSI 完全打不出来**。
设置后 MSI 文件名带语言后缀，形如 `纸墨书房_0.2.0_x64_zh-CN.msi`。`pnpm check:native` 会校验该字段。

在 macOS 上构建时需显式指定目标，例如：

```bash
pnpm --filter @bookr/desktop exec tauri build --target universal-apple-darwin
```

### 代码签名（占位）

Windows 安装包默认不签名。正式分发前应配置代码签名，否则 SmartScreen 会提示未知发布者：

- 采购代码签名证书（OV/EV），或使用云签名服务。
- 在 CI 中通过环境变量提供证书与密码，并让 `tauri build` 使用签名配置；
  证书与私钥不得写入仓库。
- 签名后在干净 Windows 机器上验证安装、升级与卸载流程。

当前仓库不包含任何证书或签名密钥。

## Android 发布签名

### 生成 keystore

```bash
keytool -genkeypair -v \
  -keystore apps/mobile/android/bookr-release.jks \
  -alias bookr \
  -keyalg RSA -keysize 4096 -validity 10000
```

按提示设置 store 密码与 key 密码。**keystore 与密码一旦丢失，已发布应用将无法升级**。

### 配置签名

```bash
cp apps/mobile/android/keystore.properties.example apps/mobile/android/keystore.properties
```

`keystore.properties`（相对 `apps/mobile/android/` 解析 `storeFile`）：

```properties
storeFile=bookr-release.jks
storePassword=<store 密码>
keyAlias=bookr
keyPassword=<key 密码>
```

`keystore.properties`、`*.jks`、`*.keystore` 已被 `apps/mobile/android/.gitignore` 忽略，禁止入库。
`pnpm check:native` 会校验忽略规则确实存在。

签名材料必须备份到密码管理器或受控的离线介质，并记录别名与密码的保管人。

### 构建 APK

前置条件：JDK 21、Android SDK（`ANDROID_HOME` 或 `apps/mobile/android/local.properties` 中的 `sdk.dir`）。

```bash
VITE_API_BASE_URL=https://bookr.example.com pnpm build:android
```

脚本依次执行 Web 构建、`cap sync android` 与 `./gradlew assembleRelease`，
最后打印 APK 路径：

- 已配置签名：`apps/mobile/android/app/build/outputs/apk/release/app-release.apk`
- 未配置签名：`app-release-unsigned.apk`，脚本会明确提示「未配置签名，产物不可发布」

发布到应用商店前，应确认 APK 使用 release keystore 签名（`apksigner verify --print-certs <apk>`）。

## 发布前检查清单

- [ ] `pnpm check:native` 七项全部 OK。
- [ ] `VITE_API_BASE_URL` 指向生产 API，且服务端 CORS 已放行桌面与 Android 来源。
- [ ] 桌面安装包在干净 Windows 机器上完成安装、启动、升级、卸载验证。
- [ ] APK 使用 release keystore 签名，且在真机上完成登录、阅读、离线缓存验证。
- [ ] 版本号、`versionCode` 与更新日志一致。
