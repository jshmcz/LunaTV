#!/usr/bin/env python3
"""
一次性数据迁移：为旧版设备记录补建 devidx 全局设备索引。

背景：首个增强版（5.1.8.1）只写了 owner:sess:dev:<deviceId> 单条记录，
没有维护 owner:sess:devidx 汇总索引。新版本 listSessions()/checkDeviceLimit()
依赖该索引遍历"历史所有设备"，若直接升级会导致旧设备看不到、设备数上限误判。

用法（NAS 上，需能读 tv.db）：
    sudo python3 /vol1/lunatv/migrate_devidx.py /vol1/lunatv/data/tv.db

特性：
- 幂等：可重复执行；已存在的 devidx 做合并（union），不覆盖新数据。
- 只读 dev:* 的 key 提取 deviceId，不改动单条设备记录。
- 编码与 db 层一致：写入做双重 JSON.stringify（storage 层 + DbManager 层各一次）。
"""
import json
import sqlite3
import sys
from datetime import datetime, timedelta, timezone

PREFIX_DEV = "owner:sess:dev:"
KEY_IDX = "owner:sess:devidx"
TTL_DAYS = 8


def main() -> None:
    if len(sys.argv) < 2:
        print("用法: sudo python3 migrate_devidx.py <tv.db 路径>")
        sys.exit(1)
    db_path = sys.argv[1]

    conn = sqlite3.connect(db_path)
    now_iso = datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z"
    expiry = (
        datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(days=TTL_DAYS)
    ).isoformat() + "Z"

    # 1) 收集所有未过期的 dev:* 记录的 deviceId（key 后缀即 deviceId）
    rows = conn.execute(
        "SELECT key FROM cache WHERE key LIKE ? AND (expiry IS NULL OR expiry > ?)",
        (PREFIX_DEV + "%", now_iso),
    ).fetchall()
    device_ids = sorted({r[0][len(PREFIX_DEV):] for r in rows if r[0].startswith(PREFIX_DEV)})
    print(f"[migrate] 发现未过期设备记录: {len(device_ids)} 个")

    # 2) 读取现有 devidx（若有），合并。storage.get 解一层，DbManager 再解一层。
    existing: list[str] = []
    row = conn.execute(
        "SELECT data FROM cache WHERE key = ? AND (expiry IS NULL OR expiry > ?)",
        (KEY_IDX, now_iso),
    ).fetchone()
    if row:
        try:
            once = json.loads(row[0])      # storage 层编码
            twice = json.loads(once) if isinstance(once, str) else once  # DbManager 层编码
            if isinstance(twice, list):
                existing = [str(x) for x in twice]
        except Exception as e:
            print(f"[migrate] 解析现有 devidx 失败，将重建: {e}")
    print(f"[migrate] 现有索引设备数: {len(existing)} 个")

    merged = sorted(set(existing) | set(device_ids))
    print(f"[migrate] 合并后设备数: {len(merged)} 个")

    # 3) 写回：模拟 db 层双重 JSON.stringify
    encoded = json.dumps(json.dumps(merged, ensure_ascii=False), ensure_ascii=False)
    conn.execute(
        "INSERT OR REPLACE INTO cache (key, data, expiry) VALUES (?, ?, ?)",
        (KEY_IDX, encoded, expiry),
    )
    conn.commit()
    conn.close()
    print(f"[migrate] 完成，devidx 已写入 {len(merged)} 个设备（过期时间 {expiry}）")


if __name__ == "__main__":
    main()
