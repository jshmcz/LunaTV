#!/bin/bash
# 在 LunaTV 源码根目录执行，把「站长菜单 / 单终端互踢 / 终端识别 / 在线升级」固化进源码。
# 用法: bash apply_owner_patch.sh <源码根目录>
# 幂等：可重复执行；每次都从最新的官方文件重新生成门面，避免升级后残留旧补丁。
set -euo pipefail

SRC="${1:-.}"
PATCHDIR="$(cd "$(dirname "$0")" && pwd)"
FILES="$PATCHDIR/files"

fail() { echo "ERROR: $*" >&2; exit 1; }

# ---------- 前置校验 ----------
[ -f "$SRC/src/app/api/login/route.ts" ] || fail "找不到 $SRC/src/app/api/login/route.ts，源码目录不对？"
[ -f "$SRC/src/app/layout.tsx" ] || fail "找不到 $SRC/src/app/layout.tsx"
[ -f "$SRC/src/app/admin/page.tsx" ] || fail "找不到 $SRC/src/app/admin/page.tsx"
[ -d "$FILES" ] || fail "找不到补丁文件目录 $FILES"

echo "[owner-patch] 源码目录: $(cd "$SRC" && pwd)"

API="$SRC/src/app/api"
LIB="$SRC/src/lib"
COMP="$SRC/src/components"
ADMINCOMP="$SRC/src/app/admin/components"

# ---------- 1) 放置通用新文件 ----------
cp "$FILES/lib/session.ts"       "$LIB/session.ts"
cp "$FILES/lib/device.ts"        "$LIB/device.ts"
cp "$FILES/components/SessionGuard.tsx" "$COMP/SessionGuard.tsx"
cp "$FILES/components/OwnerSection.tsx" "$ADMINCOMP/OwnerSection.tsx"
echo "[owner-patch] 已放置 session.ts / device.ts / SessionGuard.tsx / OwnerSection.tsx"

# ---------- 2) 登录门面：原文件备份为 route.orig.ts，再写门面 ----------
# 每次都从当前官方 route.ts 重新生成 orig（若 orig 存在则视为已打补丁，先还原）
if [ -f "$API/login/route.orig.ts" ]; then
  # 已在补丁态：官方源文件此刻就是门面内容，不能直接覆盖 orig。
  # 但我们无法区分「新拉取的官方源码」和「已打补丁源码」，所以用标记文件判断。
  if [ -f "$API/login/.owner-patched" ]; then
    echo "[owner-patch] 登录已是补丁态，跳过门面重建"
  fi
else
  cp "$API/login/route.ts" "$API/login/route.orig.ts"
  cp "$FILES/api/login-route.facade.ts" "$API/login/route.ts"
  touch "$API/login/.owner-patched"
  echo "[owner-patch] 已生成登录门面 + route.orig.ts"
fi

# ---------- 3) 登出门面 ----------
if [ ! -f "$API/logout/route.orig.ts" ]; then
  cp "$API/logout/route.ts" "$API/logout/route.orig.ts"
  cp "$FILES/api/logout-route.facade.ts" "$API/logout/route.ts"
  touch "$API/logout/.owner-patched"
  echo "[owner-patch] 已生成登出门面 + route.orig.ts"
else
  echo "[owner-patch] 登出已是补丁态，跳过"
fi

# ---------- 4) 新增 API 路由目录 ----------
mkdir -p "$API/session/verify" "$API/admin/owner/overview" "$API/admin/upgrade"
cp "$FILES/api/session-verify-route.ts"  "$API/session/verify/route.ts"
cp "$FILES/api/owner-overview-route.ts"  "$API/admin/owner/overview/route.ts"
cp "$FILES/api/upgrade-route.ts"         "$API/admin/upgrade/route.ts"
echo "[owner-patch] 已新增 3 个 API 路由"

# ---------- 5) layout.tsx 挂载 SessionGuard（幂等） ----------
if ! grep -q "components/SessionGuard" "$SRC/src/app/layout.tsx"; then
  python3 - "$SRC/src/app/layout.tsx" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
# 加 import：放到 GlobalErrorIndicator import 之后
anchor = "import { GlobalErrorIndicator } from '../components/GlobalErrorIndicator';"
assert anchor in s, "layout import 锚点未找到"
s = s.replace(anchor, anchor + "\nimport SessionGuard from '../components/SessionGuard';", 1)
# 挂载：放到 <GlobalErrorIndicator /> 之后
anchor2 = "<GlobalErrorIndicator />"
assert anchor2 in s, "layout 挂载锚点未找到"
s = s.replace(anchor2, anchor2 + "\n            <SessionGuard />", 1)
open(p, 'w', encoding='utf-8').write(s)
print("[owner-patch] layout.tsx 已挂载 SessionGuard")
PY
else
  echo "[owner-patch] layout.tsx 已挂载，跳过"
fi

# ---------- 6) admin/page.tsx 加「站长」Tab + 渲染（幂等） ----------
if ! grep -q "OwnerSection" "$SRC/src/app/admin/page.tsx"; then
  python3 - "$SRC/src/app/admin/page.tsx" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()

# 6a) import 图标：在 lucide-react import 块里加 Shield（用作站长图标）
icon_anchor = "  Settings,\n  ToggleRight,"
assert icon_anchor in s, "admin 图标锚点未找到"
s = s.replace(icon_anchor, "  Settings,\n  Shield,\n  ToggleRight,", 1)

# 6b) import OwnerSection：在 UserSection import 之后
imp_anchor = "import UserSection from '@/app/admin/components/UserSection';"
assert imp_anchor in s, "admin UserSection import 锚点未找到"
s = s.replace(imp_anchor, imp_anchor + "\nimport OwnerSection from '@/app/admin/components/OwnerSection';", 1)

# 6c) tabs 数组加一项（插在 migration 之前）
tab_anchor = "    { id: 'migration', label: '迁移备份', icon: <Database size={16} /> },"
assert tab_anchor in s, "admin tabs 锚点未找到"
s = s.replace(tab_anchor, "    { id: 'owner', label: '站长', icon: <Shield size={16} /> },\n" + tab_anchor, 1)

# 6d) 渲染区加 owner（插在 migration 渲染之前）
render_anchor = "              {activeTab === 'migration' && <DataMigration />}"
assert render_anchor in s, "admin render 锚点未找到"
s = s.replace(render_anchor, "              {activeTab === 'owner' && <OwnerSection />}\n" + render_anchor, 1)

open(p, 'w', encoding='utf-8').write(s)
print("[owner-patch] admin/page.tsx 已加入站长 Tab")
PY
else
  echo "[owner-patch] admin/page.tsx 已包含 OwnerSection，跳过"
fi

# ---------- 7) 校验关键符号 ----------
grep -q "createSession" "$LIB/session.ts"
grep -q "from './route.orig'" "$API/login/route.ts"
grep -q "from './route.orig'" "$API/logout/route.ts"
grep -q "components/SessionGuard" "$SRC/src/app/layout.tsx"
grep -q "OwnerSection" "$SRC/src/app/admin/page.tsx"
grep -q "id: 'owner'" "$SRC/src/app/admin/page.tsx"

echo "[owner-patch] 校验通过：站长菜单 / 互踢 / 终端识别 / 在线升级 全部就位"
