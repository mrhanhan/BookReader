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
# 不因构建失败立即中止：NSIS 与 MSI 是两个独立目标，一个失败时另一个可能已经落盘，
# 先打印实际产物清单再决定退出码，避免用户误以为什么都没产出。
BUILD_STATUS=0
pnpm --filter @bookr/desktop build || BUILD_STATUS=$?

FOUND=0
MISSING=0
echo
echo "安装包："
for target in "nsis:*.exe" "msi:*.msi"; do
  dir="${target%%:*}"
  pattern="${target#*:}"
  target_found=0
  for installer in "$BUNDLE_DIR/$dir/"$pattern; do
    if [ -f "$installer" ]; then
      printf '  %s（%s 字节）\n' "$installer" "$(wc -c <"$installer" | tr -d ' ')"
      target_found=1
      FOUND=1
    fi
  done
  if [ "$target_found" -eq 0 ]; then
    printf '  缺失：%s/%s 未产出\n' "$dir" "$pattern"
    MISSING=1
  fi
done

if [ "$BUILD_STATUS" -ne 0 ]; then
  echo "错误：tauri build 失败（退出码 $BUILD_STATUS），以上产物可能不完整。" >&2
  exit "$BUILD_STATUS"
fi

if [ "$MISSING" -ne 0 ] || [ "$FOUND" -eq 0 ]; then
  echo "错误：预期安装包缺失（见上），请检查 $BUNDLE_DIR。" >&2
  exit 1
fi
