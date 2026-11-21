#!/usr/bin/env python3
"""静默全局红色错误提示（播放中保存记录失败/后台同步失败等 38 处提示）。

方案：在 layout 的运行时配置里注入 HIDE_GLOBAL_ERRORS 开关（默认 true=隐藏），
GlobalErrorIndicator 收到 globalError 事件时读该开关：隐藏时只记 console、不弹卡片。
compose 里设 HIDE_GLOBAL_ERRORS=false 即可恢复显示。

改两个文件（精确替换，幂等）：
  - src/app/layout.tsx                    : runtimeConfig 增加 HIDE_GLOBAL_ERRORS
  - src/components/GlobalErrorIndicator.tsx : handleError 读开关，隐藏时不显示
用法: python3 apply_ui_quiet.py <源码根目录>
"""
import sys
import os

SRC = sys.argv[1] if len(sys.argv) > 1 else '.'
LAYOUT = os.path.join(SRC, 'src/app/layout.tsx')
IND = os.path.join(SRC, 'src/components/GlobalErrorIndicator.tsx')


def read(p):
    with open(p, 'r', encoding='utf-8') as f:
        return f.read()


def write(p, s):
    with open(p, 'w', encoding='utf-8') as f:
        f.write(s)


def apply(path, old, new, label):
    s = read(path)
    if new in s:
        print(f'  [skip] {label}（已应用）')
        return
    if old not in s:
        print(f'  [FAIL] {label}：找不到锚点', file=sys.stderr)
        sys.exit(1)
    write(path, s.replace(old, new, 1))
    print(f'  [ok] {label}')


for path in (LAYOUT, IND):
    if not os.path.isfile(path):
        print(f'[FAIL] 找不到文件: {path}', file=sys.stderr)
        sys.exit(1)

# ---- layout.tsx: 运行时配置注入开关 ----
apply(
    LAYOUT,
    "    SOURCE_FILTER_ADS: sourceFilterAds,\n  };",
    "    SOURCE_FILTER_ADS: sourceFilterAds,\n    // 全局错误红卡片显示开关：默认隐藏（!= 'false'），设 HIDE_GLOBAL_ERRORS=false 恢复显示\n    HIDE_GLOBAL_ERRORS: process.env.HIDE_GLOBAL_ERRORS !== 'false',\n  };",
    'layout 注入 HIDE_GLOBAL_ERRORS 开关',
)

# ---- GlobalErrorIndicator.tsx: handleError 读开关 ----
apply(
    IND,
    "    const handleError = (event: CustomEvent) => {\n      const { message } = event.detail;\n      const newError: ErrorInfo = {",
    "    const handleError = (event: CustomEvent) => {\n      const { message } = event.detail;\n      // 静默模式（默认）：红色错误提示影响观感，仅保留 console 日志便于排查\n      const runtime = (window as any).RUNTIME_CONFIG;\n      if (runtime && runtime.HIDE_GLOBAL_ERRORS !== false) {\n        // eslint-disable-next-line no-console\n        console.error('[globalError]', message);\n        return;\n      }\n      const newError: ErrorInfo = {",
    'handleError 读开关静默',
)

print('[ui-quiet] 完成')
