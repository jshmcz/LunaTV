#!/bin/bash
# 在 LunaTV 源码根目录执行：把「TVBox 代理去广告升级为网页同款四层启发式」固化进源码。
# 同时修复官方两个 bug：
#   bug1: detailContent 仅在 hasAdRule 时才改写播放地址为代理，导致没配 ad_rules 时去广告开关空转；
#   bug2: config.AdRules 从未从配置文件的 ad_rules 字段加载，规则回退路径永远拿不到规则。
# 用法: bash apply_tvbox_ad_patch.sh <源码根目录>
# 幂等：可重复执行。
set -euo pipefail

SRC="${1:-.}"
PATCHDIR="$(cd "$(dirname "$0")" && pwd)"
FILES="$PATCHDIR/files"

fail() { echo "ERROR: $*" >&2; exit 1; }

ROUTE_AD="$SRC/src/app/api/proxy/ad/route.ts"
DETAIL="$SRC/src/app/api/tvbox/detailContent/route.ts"
CONFIG="$SRC/src/lib/config.ts"

[ -f "$ROUTE_AD" ] || fail "找不到 $ROUTE_AD，源码目录不对？"
[ -f "$DETAIL" ]   || fail "找不到 $DETAIL"
[ -f "$CONFIG" ]   || fail "找不到 $CONFIG"
[ -f "$FILES/lib/serverAdFilter.ts" ] || fail "找不到补丁文件 serverAdFilter.ts"
[ -f "$FILES/api/proxy-ad-route.ts" ] || fail "找不到补丁文件 proxy-ad-route.ts"

echo "[tvbox-ad] 源码目录: $(cd "$SRC" && pwd)"

# ---------- 1) 放置服务端启发式模块 ----------
cp "$FILES/lib/serverAdFilter.ts" "$SRC/src/lib/serverAdFilter.ts"
echo "[tvbox-ad] 已放置 src/lib/serverAdFilter.ts"

# ---------- 2) 替换 /api/proxy/ad/route.ts ----------
# 备份一次原件供追溯；每次都用补丁版覆盖（补丁版已含官方 KEY/m3u8 处理逻辑）。
if [ ! -f "$SRC/src/app/api/proxy/ad/route.orig.ts" ]; then
  cp "$ROUTE_AD" "$SRC/src/app/api/proxy/ad/route.orig.ts"
fi
cp "$FILES/api/proxy-ad-route.ts" "$ROUTE_AD"
echo "[tvbox-ad] 已替换 proxy/ad/route.ts（启发式优先 + 规则回退）"

# ---------- 3) detailContent：去掉 hasAdRule 门槛（bug1） ----------
python3 - "$DETAIL" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()

old = """            let url = `${item.episodes[index]}`;
            if (isProxyFilterAds && hasAdRule) {
              url =
                urlPrefix + '/api/proxy/ad?source=' + source + '&url=' + url;
            }"""
new = """            let url = `${item.episodes[index]}`;
            // [tvbox-ad] 去广告开关开启即走代理，由服务端启发式过滤，不再要求 ad_rules
            if (isProxyFilterAds) {
              url =
                urlPrefix + '/api/proxy/ad?source=' + source + '&url=' + url;
            }"""
if old in s:
    s = s.replace(old, new, 1)
    print("[tvbox-ad] detailContent 已去掉 hasAdRule 门槛")
elif "[tvbox-ad] 去广告开关开启即走代理" in s:
    print("[tvbox-ad] detailContent 已打过补丁，跳过")
else:
    print("ERROR: detailContent 锚点未找到，源码结构可能变化", file=sys.stderr)
    sys.exit(1)
open(p, 'w', encoding='utf-8').write(s)
PY

# ---------- 4) configSelfCheck：从 ConfigFile 补加载 AdRules（bug2） ----------
python3 - "$CONFIG" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()

marker = "// [tvbox-ad] 从配置文件补加载 ad_rules"
if marker in s:
    print("[tvbox-ad] configSelfCheck 已打过补丁，跳过")
else:
    anchor = "export function configSelfCheck(adminConfig: AdminConfig): AdminConfig {\n  // 确保必要的属性存在和初始化"
    insert = """export function configSelfCheck(adminConfig: AdminConfig): AdminConfig {
  // [tvbox-ad] 从配置文件补加载 ad_rules（官方 refineConfig 不映射它，规则回退路径会永远为空）
  if (!adminConfig.AdRules && adminConfig.ConfigFile) {
    try {
      const _cf = JSON.parse(adminConfig.ConfigFile);
      if (typeof _cf.ad_rules === 'string') adminConfig.AdRules = _cf.ad_rules;
    } catch (_e) {
      /* ignore malformed config */
    }
  }
  // 确保必要的属性存在和初始化"""
    if anchor not in s:
        print("ERROR: configSelfCheck 锚点未找到，源码结构可能变化", file=sys.stderr)
        sys.exit(1)
    s = s.replace(anchor, insert, 1)
    print("[tvbox-ad] configSelfCheck 已补加载 AdRules")
    open(p, 'w', encoding='utf-8').write(s)
PY

# ---------- 5) 校验关键符号 ----------
grep -q "filterAdsServerSide" "$SRC/src/lib/serverAdFilter.ts"
grep -q "filterAdsServerSide" "$ROUTE_AD"
grep -q "\[ServerAdFilter\] 启发式命中" "$ROUTE_AD"
grep -q "if (isProxyFilterAds)" "$DETAIL"
grep -q "从配置文件补加载 ad_rules" "$CONFIG"

echo "[tvbox-ad] 校验通过：TVBox 代理去广告已升级为网页同款四层启发式"
