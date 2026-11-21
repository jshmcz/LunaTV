#!/usr/bin/env python3
"""让登录页 SSR 首帧即渲染用户名框：把服务端配置经 SiteProvider 传给客户端。

改两个文件（精确替换，幂等）：
  - src/components/SiteProvider.tsx : Context 增加 storageType / openRegister
  - src/app/layout.tsx              : <SiteProvider> 传入这两个服务端变量
用法: python3 apply_login_context.py <源码根目录>
"""
import sys
import os

SRC = sys.argv[1] if len(sys.argv) > 1 else '.'
SP = os.path.join(SRC, 'src/components/SiteProvider.tsx')
LAYOUT = os.path.join(SRC, 'src/app/layout.tsx')
MARK = 'storageType'


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


for path in (SP, LAYOUT):
    if not os.path.isfile(path):
        print(f'[FAIL] 找不到文件: {path}', file=sys.stderr)
        sys.exit(1)

# ---- SiteProvider.tsx ----
apply(
    SP,
    "const SiteContext = createContext<{ siteName: string; announcement?: string }>({",
    "const SiteContext = createContext<{ siteName: string; announcement?: string; storageType?: string; openRegister?: boolean }>({",
    'SiteProvider Context 类型扩展',
)
apply(
    SP,
    "  announcement:\n    '本网站仅提供影视信息搜索服务，所有内容均来自第三方网站。本站不存储任何视频资源，不对任何内容的准确性、合法性、完整性负责。',\n});",
    "  announcement:\n    '本网站仅提供影视信息搜索服务，所有内容均来自第三方网站。本站不存储任何视频资源，不对任何内容的准确性、合法性、完整性负责。',\n  storageType: 'localstorage',\n  openRegister: false,\n});",
    'SiteProvider Context 默认值',
)
apply(
    SP,
    "export function SiteProvider({\n  children,\n  siteName,\n  announcement,\n}: {\n  children: ReactNode;\n  siteName: string;\n  announcement?: string;\n}) {\n  return (\n    <SiteContext.Provider value={{ siteName, announcement }}>",
    "export function SiteProvider({\n  children,\n  siteName,\n  announcement,\n  storageType,\n  openRegister,\n}: {\n  children: ReactNode;\n  siteName: string;\n  announcement?: string;\n  storageType?: string;\n  openRegister?: boolean;\n}) {\n  return (\n    <SiteContext.Provider value={{ siteName, announcement, storageType, openRegister }}>",
    'SiteProvider 参数与 value',
)

# ---- layout.tsx ----
apply(
    LAYOUT,
    "<SiteProvider siteName={siteName} announcement={announcement}>",
    "<SiteProvider\n            siteName={siteName}\n            announcement={announcement}\n            storageType={storageType}\n            openRegister={openRegister}\n          >",
    'layout 向 SiteProvider 传值',
)

# 校验
sp = read(SP)
lo = read(LAYOUT)
assert 'storageType?: string' in sp and 'openRegister?: boolean' in sp, 'SiteProvider 类型校验失败'
assert 'value={{ siteName, announcement, storageType, openRegister }}' in sp, 'SiteProvider value 校验失败'
assert 'storageType={storageType}' in lo and 'openRegister={openRegister}' in lo, 'layout 传值校验失败'
print('[login-context] 校验通过：服务端配置已注入客户端 Context')
