#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TVBox key 全量换新（升级后手动执行一次）。
- 把 admin_config(UserConfig.Users[].key) 里所有 key 换成 10 位 base62 key；
- 同步更新 users 表（若有对应行）；
- 写入一次性标记，避免重复执行。
幂等：检测到标记后立即退出，除非 --force。

【重要】Next.js 的 unstable_cache 会持久化缓存 config（含旧 key），直接改数据库
会被应用层读旧缓存写回覆盖。因此本脚本改完库后会：
  1) 通过 docker exec 删除容器内 /app/.next/cache/fetch-cache；
  2) 提示需重启容器让应用从数据库重新加载新 key。
正确执行顺序（脚本已自动处理 1，需按提示完成 2）：
  停容器 -> 跑本脚本 -> 启动/重启容器 -> 端到端验证。
"""
import sys, os, json, secrets, string, sqlite3, subprocess

DB_PATH = "/vol1/lunatv/data/tv.db"
FLAG_KEY = "tvbox:keyguard:migrated:v1"
CONTAINER = os.environ.get("TVBOX_CONTAINER", "lunatv-core")
ALPHABET = string.digits + string.ascii_lowercase + string.ascii_uppercase
KEY_LEN = 10  # base62 固定 10 位（约 59 位熵，防枚举且便于手动复制）


def long_key() -> str:
    # 16 字节随机 -> 大整数取模 62^10 -> 固定 10 位 base62
    num = int.from_bytes(secrets.token_bytes(16), "big")
    out = []
    base = len(ALPHABET)
    num %= base ** KEY_LEN
    for _ in range(KEY_LEN):
        num, r = divmod(num, base)
        out.append(ALPHABET[r])
    return "".join(reversed(out)) or ALPHABET[0]


def clear_next_cache():
    """删除容器内 Next.js 持久化 fetch-cache，避免旧 config 被写回。"""
    try:
        subprocess.run(
            ["docker", "exec", CONTAINER, "sh", "-c",
             "rm -rf /app/.next/cache/fetch-cache"],
            check=False, capture_output=True, timeout=20,
        )
        print(f"[cache] 已清除容器 {CONTAINER} 的 Next.js fetch-cache")
    except Exception as e:
        print(f"[cache] 清除缓存失败（请手动处理）: {e}")


def get_cache(cur, key):
    row = cur.execute("SELECT data FROM cache WHERE key=?", (key,)).fetchone()
    return row[0] if row else None


def set_cache(cur, key, value):
    cur.execute(
        "INSERT OR REPLACE INTO cache (key, data) VALUES (?, ?)",
        (key, json.dumps(value) if not isinstance(value, str) else value),
    )


def main():
    force = "--force" in sys.argv
    if not os.path.exists(DB_PATH):
        print(f"数据库不存在: {DB_PATH}")
        sys.exit(1)

    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()

    if not force:
        flag = get_cache(cur, FLAG_KEY)
        if flag:
            print("已执行过全量换新，跳过（如需强制重跑加 --force）")
            con.close()
            return

    row = cur.execute(
        "SELECT config FROM admin_config WHERE key='admin:config'"
    ).fetchone()
    if not row:
        print("未找到 admin:config 配置")
        sys.exit(1)

    cfg = json.loads(row[0])
    users = cfg.get("UserConfig", {}).get("Users", [])
    changed = []
    for u in users:
        username = u.get("username")
        if not username:
            continue
        new_key = long_key()
        old_key = u.get("key", "")
        u["key"] = new_key
        # 同步 users 表（登录库），保持两处一致
        cur.execute(
            "UPDATE users SET key=? WHERE user_name=?", (new_key, username)
        )
        changed.append((username, old_key, new_key))

    cfg["UserConfig"]["Users"] = users
    cur.execute(
        "UPDATE admin_config SET config=? WHERE key='admin:config'",
        (json.dumps(cfg, ensure_ascii=False),),
    )
    set_cache(cur, FLAG_KEY, {"done": True, "count": len(changed)})
    con.commit()
    con.close()

    # 清除 Next.js 持久化缓存，避免旧 config 被应用层写回
    clear_next_cache()

    print(f"全量换新完成，共 {len(changed)} 个用户：")
    for username, old, new in changed:
        print(f"  {username}: {old} -> {new}")
    print("请通知所有用户重新从网页复制新的 TVBox 配置地址。")
    print("\n===== 必须重启容器让新 key 生效 =====")
    print(f"  docker restart {CONTAINER}")
    print("重启后再验证：新 key 请求返回 200、旧 key 返回 401。")


if __name__ == "__main__":
    main()
