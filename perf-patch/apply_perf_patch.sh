#!/bin/bash
# 播放性能优化补丁入口：调用 python 精确替换脚本（幂等）
# 用法: bash apply_perf_patch.sh <源码根目录>
set -euo pipefail
SRC="${1:-.}"
PATCHDIR="$(cd "$(dirname "$0")" && pwd)"
python3 "$PATCHDIR/apply_perf_patch.py" "$SRC"
