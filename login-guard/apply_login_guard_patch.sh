#!/bin/bash
# 登录防暴破补丁（幂等）：失败计数 + 一次性验证码 + 修复用户名框晚显示
# 用法: bash apply_login_guard_patch.sh <源码根目录>
set -euo pipefail

SRC="${1:-.}"
APP="$SRC/src/app"
LIB="$SRC/src/lib"
PATCHDIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -f "$APP/api/login/route.ts" ] || [ ! -f "$APP/login/page.tsx" ]; then
  echo "ERROR: 找不到 login 路由/页面，源码目录不对？" >&2
  exit 1
fi

echo "[login-guard] 源码目录: $SRC"

# 1) 放入验证码库 + 验证码接口
cp "$PATCHDIR/files/lib/loginGuard.ts" "$LIB/loginGuard.ts"
mkdir -p "$APP/api/captcha"
cp "$PATCHDIR/files/api/captcha-route.ts" "$APP/api/captcha/route.ts"
echo "[login-guard] 已放入 loginGuard.ts + api/captcha/route.ts"

# 2) 登录门面：备份原 route.ts（仅首次），替换为带验证码门禁的版本
# 注意：此脚本在 owner-patch 之后执行，route.ts 此时已是 owner 门面
if [ ! -f "$APP/api/login/route.before-captcha.ts" ]; then
  cp "$APP/api/login/route.ts" "$APP/api/login/route.before-captcha.ts"
  echo "[login-guard] 已备份 login/route.ts -> route.before-captcha.ts"
fi
cp "$PATCHDIR/files/api/login-route.facade.ts" "$APP/api/login/route.ts"
echo "[login-guard] 已替换 login/route.ts"

# 3) 登录页：备份原 page.tsx（仅首次），替换为修复版
if [ ! -f "$APP/login/page.before-captcha.tsx" ]; then
  cp "$APP/login/page.tsx" "$APP/login/page.before-captcha.tsx"
  echo "[login-guard] 已备份 login/page.tsx -> page.before-captcha.tsx"
fi
cp "$PATCHDIR/files/app/login-page.tsx" "$APP/login/page.tsx"
echo "[login-guard] 已替换 login/page.tsx"

# 3b) 用户名框 SSR 首帧修复：SiteProvider 扩展 + layout 传值（精确替换，幂等）
python3 "$PATCHDIR/apply_login_context.py" "$SRC"

# 4) 校验关键符号
grep -q "owner:login:fail:" "$LIB/loginGuard.ts"
grep -q "CAPTCHA_ENABLED" "$LIB/loginGuard.ts"
grep -q "export async function issueCaptcha" "$LIB/loginGuard.ts"
grep -q "X-Captcha-Token" "$APP/api/login/route.ts"
grep -q "needCaptcha" "$APP/api/captcha/route.ts"
grep -q "X-Need-Captcha" "$APP/api/login/route.ts"
grep -q "const { siteName, storageType, openRegister } = useSite()" "$APP/login/page.tsx"
grep -q "storageType={storageType}" "$SRC/src/app/layout.tsx"
grep -q "openRegister?: boolean" "$SRC/src/components/SiteProvider.tsx"
grep -q "X-Captcha-Code" "$APP/login/page.tsx"
grep -q "LAST_USERNAME_KEY" "$APP/login/page.tsx"
echo "[login-guard] 校验通过：验证码门禁 + 用户名框 SSR 首帧渲染 + 记住上次用户名就位"
echo "[login-guard] 提示：compose 可设 CAPTCHA_ENABLED=false 关闭验证码"
