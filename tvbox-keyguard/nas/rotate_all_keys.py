#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TVBox key 全量换新（升级后手动执行一次）。
- 把 admin_config(UserConfig.Users[].key) 里所有 key 换成 10 位 base62 key；
- 同步更新 users 表（若有对应行）；
- 写入一次性标记，避免重复执行。
幂等：检测到标记后立即退出，除非 --force。
"""
import sys, os, json, secrets, string, sqlite3

DB_PATH = "/vol1/lunatv/data/tv.db"
FLAG_KEY = "tvbox:keyguard:migrated:v1"
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

    print(f"全量换新完成，共 {len(changed)} 个用户：")
    for username, old, new in changed:
        print(f"  {username}: {old} -> {new}")
    print("请通知所有用户重新从网页复制新的 TVBox 配置地址。")


if __name__ == "__main__":
    main()
