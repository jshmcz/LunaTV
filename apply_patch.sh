#!/bin/bash
# 在 LunaTV 源码根目录执行，把去广告增强固化进源码。
# 用法: bash apply_patch.sh <源码根目录>
# 幂等：重复执行不会破坏（靠 .orig-bak 标记判断）。
set -euo pipefail

SRC="${1:-.}"
LIB="$SRC/src/lib"
PATCHDIR="$(cd "$(dirname "$0")/patch" && pwd)"

if [ ! -f "$LIB/pcrAdFilter.ts" ]; then
  echo "ERROR: 找不到 $LIB/pcrAdFilter.ts，源码目录不对？" >&2
  exit 1
fi
if [ ! -d "$PATCHDIR" ]; then
  echo "ERROR: 找不到补丁目录 $PATCHDIR" >&2
  exit 1
fi

echo "[patch] 源码目录: $SRC"

# 1) 备份原版为 pcrAdFilterOrig.ts（幂等：只在首次生成）
if [ ! -f "$LIB/pcrAdFilterOrig.ts" ]; then
  cp "$LIB/pcrAdFilter.ts" "$LIB/pcrAdFilterOrig.ts"
  echo "[patch] 已生成 pcrAdFilterOrig.ts"
else
  echo "[patch] pcrAdFilterOrig.ts 已存在，跳过"
fi

# 2) 放入门面，覆盖 pcrAdFilter.ts
cp "$PATCHDIR/pcrAdFilter.facade.ts" "$LIB/pcrAdFilter.ts"
echo "[patch] 已写入 pcrAdFilter.ts 门面"

# 3) 放入三个增强模块
for f in heuristicAdFilter.ts enhancedAdFilter.ts optimizedProbe.ts; do
  cp "$PATCHDIR/$f" "$LIB/$f"
  echo "[patch] 已放入 $f"
done

# 4) 校验：确认关键符号都在
grep -q "export { filterAdsEnhanced as filterAdsByPcr }" "$LIB/pcrAdFilter.ts"
grep -q "from './pcrAdFilterOrig'" "$LIB/enhancedAdFilter.ts"
grep -q "from './pcrAdFilterOrig'" "$LIB/optimizedProbe.ts"
grep -q "export function filterAdsEnhanced" "$LIB/enhancedAdFilter.ts"
grep -q "export function cachedProbe" "$LIB/optimizedProbe.ts"
grep -q "export function stripAdGroupsWithReport" "$LIB/heuristicAdFilter.ts"

echo "[patch] 校验通过：门面 + 3 个增强模块就位"
echo "[patch] PlayPageClient.tsx 未改动（import 由门面兼容）"
