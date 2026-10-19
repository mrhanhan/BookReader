#!/usr/bin/env bash
# 构建 Android release APK。要求已安装 JDK、Android SDK，并在仓库根目录执行。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ANDROID_DIR="$ROOT/apps/mobile/android"
KEYSTORE_PROPERTIES="$ANDROID_DIR/keystore.properties"

if [ -z "${VITE_API_BASE_URL:-}" ]; then
  echo "错误：必须设置 VITE_API_BASE_URL（该地址会在构建时编译进 Web 产物）。" >&2
  echo "示例：VITE_API_BASE_URL=https://bookr.example.com pnpm build:android" >&2
  exit 1
fi

if [ -z "${ANDROID_HOME:-}" ] && [ ! -f "$ANDROID_DIR/local.properties" ]; then
  echo "错误：未找到 Android SDK。" >&2
  echo "请设置 ANDROID_HOME，或在 $ANDROID_DIR/local.properties 中写入 sdk.dir=<SDK 路径>。" >&2
  exit 1
fi

SDK_STATE="${ANDROID_HOME:-local.properties}"
if [ -n "${ANDROID_HOME:-}" ]; then
  echo "使用 ANDROID_HOME=$SDK_STATE"
else
  echo "使用 $ANDROID_DIR/local.properties 中的 sdk.dir"
fi

if [ ! -x "$ANDROID_DIR/gradlew" ] && [ ! -f "$ANDROID_DIR/gradlew" ]; then
  echo "错误：找不到 $ANDROID_DIR/gradlew。" >&2
  exit 1
fi

SIGNED=1
if [ ! -f "$KEYSTORE_PROPERTIES" ]; then
  SIGNED=0
  echo "警告：未配置签名，产物不可发布。" >&2
  echo "请复制 apps/mobile/android/keystore.properties.example 为 keystore.properties 并填入签名信息。" >&2
fi

cd "$ROOT"

echo "==> 构建 Web 前端"
pnpm --filter @bookr/web build

echo "==> 同步 Capacitor Android 工程"
pnpm --filter @bookr/mobile sync

echo "==> 构建 release APK"
(cd "$ANDROID_DIR" && ./gradlew assembleRelease)

APK_DIR="$ANDROID_DIR/app/build/outputs/apk/release"
if [ -f "$APK_DIR/app-release.apk" ]; then
  APK="$APK_DIR/app-release.apk"
elif [ -f "$APK_DIR/app-release-unsigned.apk" ]; then
  APK="$APK_DIR/app-release-unsigned.apk"
  SIGNED=0
else
  echo "错误：未找到 release APK，请检查 $APK_DIR。" >&2
  exit 1
fi

echo
echo "APK：$APK"
if [ "$SIGNED" -eq 1 ]; then
  echo "签名：已使用 keystore.properties 中的发布密钥。"
else
  echo "未配置签名，产物不可发布。"
fi
