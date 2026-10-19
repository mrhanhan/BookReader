#!/usr/bin/env bash
# 构建 Windows 桌面安装包（NSIS + MSI）。要求已安装 Rust 与 Tauri 2 的系统依赖。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUNDLE_DIR="$ROOT/apps/desktop/src-tauri/target/release/bundle"

if [ -z "${VITE_API_BASE_URL:-}" ]; then
  echo "错误：必须设置 VITE_API_BASE_URL（该地址会在构建时编译进 Web 产物）。" >&2
  echo "示例：VITE_API_BASE_URL=https://bookr.example.com pnpm build:desktop" >&2
  exit 1
fi

cd "$ROOT"

echo "==> 构建 Web 前端"
pnpm --filter @bookr/web build

echo "==> 构建桌面安装包（NSIS/MSI）"
pnpm --filter @bookr/desktop build

FOUND=0
echo
echo "安装包："
for installer in "$BUNDLE_DIR/nsis/"*.exe "$BUNDLE_DIR/msi/"*.msi; do
  if [ -f "$installer" ]; then
    printf '  %s\n' "$installer"
    FOUND=1
  fi
done

if [ "$FOUND" -eq 0 ]; then
  echo "错误：未找到 NSIS/MSI 安装包，请检查 $BUNDLE_DIR。" >&2
  exit 1
fi
