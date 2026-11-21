#!/usr/bin/env bash
# 静默全局红色错误提示（播放/后台失败等 38 处）
set -euo pipefail

SRC="${1:-.}"
PATCHDIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -d "$SRC/src" ]; then
  echo "[ui-quiet] FAIL: 源码目录无效: $SRC" >&2
  exit 1
fi

echo "[ui-quiet] 应用静默补丁到 $SRC"
python3 "$PATCHDIR/apply_ui_quiet.py" "$SRC"

# 校验关键符号
grep -q "HIDE_GLOBAL_ERRORS" "$SRC/src/app/layout.tsx"
grep -q "HIDE_GLOBAL_ERRORS !== false" "$SRC/src/components/GlobalErrorIndicator.tsx"
grep -q "\[globalError\]" "$SRC/src/components/GlobalErrorIndicator.tsx"
echo "[ui-quiet] 校验通过：默认静默 + 开关可恢复"
