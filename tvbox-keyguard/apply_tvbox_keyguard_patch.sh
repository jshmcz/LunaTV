#!/bin/bash
# TVBox key 防泄漏守卫补丁（幂等）
# 用法: bash apply_tvbox_keyguard_patch.sh <源码根目录>
set -euo pipefail
SRC="${1:-.}"
echo "[tvbox-keyguard] 源码目录: $SRC"

# ---------- 0) 前置：放核心库 ----------
mkdir -p "$SRC/src/lib"
cp -f "$(dirname "$0")/files/lib/tvboxKeyGuard.ts" "$SRC/src/lib/tvboxKeyGuard.ts"
echo "[tvbox-keyguard] 已写入 src/lib/tvboxKeyGuard.ts"

# ---------- 1) /api/tvbox/route.ts：鉴权后记录设备并守卫 ----------
ROUTE="$SRC/src/app/api/tvbox/route.ts"
if grep -q "tvboxKeyGuard" "$ROUTE"; then
  echo "[tvbox-keyguard] route.ts 已打补丁，跳过"
else
  python3 - "$ROUTE" <<'PY'
import sys, re
p = sys.argv[1]
s = open(p, encoding='utf-8').read()

# 1a) 加 import（放在 getConfig import 之后）
imp = "import { getConfig } from '@/lib/config';"
if imp in s:
    s = s.replace(
        imp,
        imp + "\nimport { recordDeviceAndGuard } from '@/lib/tvboxKeyGuard';",
        1,
    )
else:
    raise SystemExit('[tvbox-keyguard] route.ts 未找到 getConfig import 锚点')

# 1b) 找到 validKey 校验块，在其后插入设备记录。
# 原代码：
#   const validKey = config.UserConfig.Users.some(
#     (user) => user.key === k && !user.banned
#   );
#   if (!config.TvBoxConfig || config.TvBoxConfig.disabled || !validKey) {
# 我们在 if 之前插入：找到匹配的用户并记账。
anchor = """    if (!config.TvBoxConfig || config.TvBoxConfig.disabled || !validKey) {"""
insert = """    // [tvbox-keyguard] 记录设备并按超限守卫（只影响该用户自己的 key）
    if (validKey) {
      const matchedUser = config.UserConfig.Users.find(
        (user: any) => user.key === k && !user.banned,
      );
      if (matchedUser) {
        try {
          const guard = await recordDeviceAndGuard(
            matchedUser.username,
            k,
            request.headers,
          );
          if (guard.rotated) {
            console.warn(
              `[tvbox-keyguard] 用户 ${matchedUser.username} key 因设备超限已轮换，本次仍返回配置，后续请用新 key 重新配置 TVBox`,
            );
          }
        } catch (e) {
          console.error('[tvbox-keyguard] 设备记录失败:', e);
        }
      }
    }
    if (!config.TvBoxConfig || config.TvBoxConfig.disabled || !validKey) {"""
if anchor not in s:
    raise SystemExit('[tvbox-keyguard] route.ts 未找到 validKey 校验锚点')
s = s.replace(anchor, insert, 1)
open(p, 'w', encoding='utf-8').write(s)
print('[tvbox-keyguard] route.ts 注入完成')
PY
fi

# ---------- 2) common.ts validateRequest：同样记录设备 ----------
COMMON="$SRC/src/app/api/tvbox/common.ts"
if grep -q "tvboxKeyGuard" "$COMMON"; then
  echo "[tvbox-keyguard] common.ts 已打补丁，跳过"
else
  python3 - "$COMMON" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()

imp = "import { searchFromApi } from '@/lib/downstream';"
if imp in s:
    s = s.replace(
        imp,
        imp + "\nimport { recordDeviceAndGuard } from '@/lib/tvboxKeyGuard';",
        1,
    )
else:
    raise SystemExit('[tvbox-keyguard] common.ts 未找到 downstream import 锚点')

# validateRequest 只拿到 k 字符串，没有 headers。改为可选第二参数 request。
old_sig = "export const validateRequest = async (k: string | null) => {"
new_sig = """export const validateRequest = async (
  k: string | null,
  request?: NextRequest,
) => {"""
if old_sig not in s:
    raise SystemExit('[tvbox-keyguard] common.ts 未找到 validateRequest 签名锚点')
s = s.replace(old_sig, new_sig, 1)

old_ret = """  if (user.banned) return { error: '用户已被封禁', status: 401 };
  return { user, config, ok: true };"""
new_ret = """  if (user.banned) return { error: '用户已被封禁', status: 401 };
  // [tvbox-keyguard] 记录设备并按超限守卫
  if (request) {
    try {
      await recordDeviceAndGuard(user.username, k, request.headers);
    } catch (e) {
      console.error('[tvbox-keyguard] 设备记录失败:', e);
    }
  }
  return { user, config, ok: true };"""
if old_ret not in s:
    raise SystemExit('[tvbox-keyguard] common.ts 未找到 validateRequest 返回锚点')
s = s.replace(old_ret, new_ret, 1)
open(p, 'w', encoding='utf-8').write(s)
print('[tvbox-keyguard] common.ts 注入完成')
PY
fi

# ---------- 3) 让 history/keep/keyword 把 request 传给 validateRequest ----------
for f in history keep keyword; do
  R="$SRC/src/app/api/tvbox/$f/route.ts"
  [ -f "$R" ] || continue
  if grep -q "validateRequest(searchParams.get('k'), request)" "$R"; then
    echo "[tvbox-keyguard] $f 已传 request，跳过"
    continue
  fi
  python3 - "$R" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
s = s.replace("validateRequest(searchParams.get('k'))", "validateRequest(searchParams.get('k'), request)")
open(p, 'w', encoding='utf-8').write(s)
print("[tvbox-keyguard] " + p.split('/')[-2] + " 已传 request")
PY
done

# ---------- 4) utils.ts：key 加长 ----------
UTILS="$SRC/src/lib/utils.ts"
if grep -q "加长 key：SHA256" "$UTILS"; then
  echo "[tvbox-keyguard] utils.ts 已加长 key，跳过"
else
  python3 - "$UTILS" "$(dirname "$0")/files/lib/generateShortKey.facade.ts" <<'PY'
import sys
p, facade = sys.argv[1], sys.argv[2]
s = open(p, encoding='utf-8').read()
new = open(facade, encoding='utf-8').read().rstrip('\n')
start = s.find('export const generateShortKey = (username: string) => {')
if start < 0:
    raise SystemExit('[tvbox-keyguard] utils.ts 未找到 generateShortKey 起点')
# 从起点向后找配对的结尾：函数以 '\n};' 结束
end = s.find('\n};', start)
if end < 0:
    raise SystemExit('[tvbox-keyguard] utils.ts 未找到 generateShortKey 结尾')
end += len('\n};')
s = s[:start] + new + s[end:]
open(p, 'w', encoding='utf-8').write(s)
print('[tvbox-keyguard] generateShortKey 已加长')
PY
fi

# ---------- 5) OwnerSection.tsx：加 TVBox 设备数列 ----------
OWNER="$SRC/src/app/admin/components/OwnerSection.tsx"
if grep -q "tvboxDeviceCount" "$OWNER"; then
  echo "[tvbox-keyguard] OwnerSection.tsx 已加 TVBox 列，跳过"
else
  python3 - "$OWNER" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()

# 5a) interface UserRow 加字段
old = "  kickCount: number;\n  devices: DeviceInfo[];"
new = "  kickCount: number;\n  tvboxDeviceCount?: number;\n  devices: DeviceInfo[];"
if old not in s:
    raise SystemExit('[tvbox-keyguard] OwnerSection interface 锚点缺失')
s = s.replace(old, new, 1)

# 5b) 表头：在互踢次数列后插入 TVBox 设备列
old_th = """                <th className='text-center px-4 py-3 font-medium' title='该账号被顶下线的次数'>互踢次数</th>"""
new_th = """                <th className='text-center px-4 py-3 font-medium' title='该账号被顶下线的次数'>互踢次数</th>
                <th className='text-center px-4 py-3 font-medium' title='TVBox key 关联的不同设备数，超过上限会自动换 key'>TVBox设备</th>"""
if old_th not in s:
    raise SystemExit('[tvbox-keyguard] OwnerSection 表头锚点缺失')
s = s.replace(old_th, new_th, 1)

# 5c) 单元格：在互踢次数 td 后插入 TVBox 设备 td
old_td = """                  <td className='px-4 py-3 text-center text-amber-600 dark:text-amber-400'>
                    {u.kickCount}
                  </td>"""
new_td = """                  <td className='px-4 py-3 text-center text-amber-600 dark:text-amber-400'>
                    {u.kickCount}
                  </td>
                  <td className='px-4 py-3 text-center'>
                    <span className={(u.tvboxDeviceCount ?? 0) >= 10 ? 'text-red-600 dark:text-red-400 font-semibold' : 'text-gray-700 dark:text-gray-300'} title={(u.tvboxDeviceCount ?? 0) >= 10 ? '已达上限，触发时将自动换 key' : ''}>
                      {u.tvboxDeviceCount ?? 0}
                    </span>
                  </td>"""
if old_td not in s:
    raise SystemExit('[tvbox-keyguard] OwnerSection 单元格锚点缺失')
s = s.replace(old_td, new_td, 1)

open(p, 'w', encoding='utf-8').write(s)
print('[tvbox-keyguard] OwnerSection.tsx 已加 TVBox 设备列')
PY
fi

# ---------- 6) 用带 TVBox 设备数的版本覆盖 owner overview 路由 ----------
OVERVIEW="$SRC/src/app/api/admin/owner/overview/route.ts"
cp -f "$(dirname "$0")/files/api/owner-overview-route.ts" "$OVERVIEW"
echo "[tvbox-keyguard] owner overview 路由已更新（含 TVBox 设备数）"

echo "[tvbox-keyguard] 全部完成"
