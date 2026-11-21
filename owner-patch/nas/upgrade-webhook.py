#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
站长增强：NAS 在线升级 Webhook（运行在飞牛 NAS 宿主机，不在 Docker 内）

作用：接收网页端「一键升级」请求，校验令牌后，执行：
  1) docker pull ghcr.io/<owner>/lunatv:<version>
  2) 修改 docker-compose.yml 里 lunatv-core 的 image 标签
  3) docker compose up -d --no-deps --force-recreate lunatv-core

安全：
  - 只监听 127.0.0.1（配合 SSH 端口转发）或内网地址；
  - 校验 X-Webhook-Token；
  - 同一时刻只允许一个升级任务（文件锁）。

用法：
  python3 upgrade-webhook.py --port 10099 --token '你的令牌' \
      --compose /vol1/lunatv/docker-compose.yml --service lunatv-core
"""
import argparse
import fcntl
import json
import os
import re
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOCK_PATH = "/tmp/lunatv-upgrade.lock"
LOG_PATH = "/vol1/lunatv/data/upgrade.log"


def log(msg: str) -> None:
    line = f"[upgrade] {msg}"
    print(line, flush=True)
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            import datetime
            f.write(f"{datetime.datetime.now():%Y-%m-%d %H:%M:%S} {line}\n")
    except Exception:
        pass


def run_cmd(cmd: list[str], check: bool = True) -> subprocess.CompletedProcess:
    log("$ " + " ".join(cmd))
    cp = subprocess.run(cmd, capture_output=True, text=True)
    if cp.stdout.strip():
        log(cp.stdout.strip()[-1500:])
    if cp.returncode != 0:
        log(f"命令失败 (code={cp.returncode}): {cp.stderr.strip()[-1500:]}")
        if check:
            raise RuntimeError(cp.stderr.strip()[-500:] or "命令执行失败")
    return cp


def update_compose_image(compose_path: str, service: str, version: str, owner: str) -> None:
    """只替换指定 service 块下的第一个 image: 行，避免误改其它服务。
    同时同步 CURRENT_IMAGE_TAG 环境变量，使面板升级后显示正确的当前版本。"""
    with open(compose_path, "r", encoding="utf-8") as f:
        lines = f.readlines()

    new_image = f"ghcr.io/{owner}/lunatv:{version}"
    in_service = False
    service_indent = None
    replaced = False
    tag_updated = False
    out = []
    svc_re = re.compile(rf"^\s*{re.escape(service)}\s*:\s*$")

    for line in lines:
        if svc_re.match(line):
            in_service = True
            service_indent = len(line) - len(line.lstrip())
            out.append(line)
            continue
        if in_service and service_indent is not None:
            stripped = line.lstrip()
            indent = len(line) - len(stripped)
            # 遇到同级或更高级的新键，说明离开了该 service 块
            if stripped and not stripped.startswith("#") and indent <= service_indent:
                in_service = False
            elif in_service and stripped.startswith("image:"):
                out.append(f"{' ' * indent}image: {new_image}\n")
                replaced = True
                in_service = False
                continue
        # 同步当前版本标记（可能带注释，只改值部分）
        if "CURRENT_IMAGE_TAG=" in line:
            m = re.match(r"^(\s*(?:-\s*)?CURRENT_IMAGE_TAG=)(.*?)(\s*)$", line.rstrip("\n"))
            if m:
                out.append(f"{m.group(1)}{version}{m.group(3)}\n")
                tag_updated = True
                continue
        out.append(line)

    if not replaced:
        raise RuntimeError(f"未在 compose 中找到 service [{service}] 的 image 字段")
    if not tag_updated:
        # compose 里没有该变量则不动（新补丁的 compose 会带上）
        log("提示: compose 中未找到 CURRENT_IMAGE_TAG，面板当前版本显示可能滞后")
    with open(compose_path, "w", encoding="utf-8") as f:
        f.writelines(out)
    log(f"compose 镜像已更新为 {new_image}")


def do_upgrade(version: str, args) -> str:
    # 版本白名单，防注入
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,40}", version):
        raise ValueError(f"非法版本号: {version}")
    with open(LOCK_PATH, "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("已有升级任务在进行中，请稍后再试")

        image = f"ghcr.io/{args.owner}/lunatv:{version}"
        run_cmd(["docker", "pull", image])
        update_compose_image(args.compose, args.service, version, args.owner)
        run_cmd(
            [
                "docker", "compose", "-f", args.compose,
                "up", "-d", "--no-deps", "--force-recreate", args.service,
            ]
        )
        return f"已升级到 {image} 并重建容器 {args.service}"


class Handler(BaseHTTPRequestHandler):
    args: argparse.Namespace

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        if self.path.rstrip("/") != "/upgrade":
            return self._json(404, {"ok": False, "error": "not found"})

        token = self.headers.get("X-Webhook-Token", "")
        if token != self.args.token:
            log("收到令牌错误的升级请求")
            return self._json(403, {"ok": False, "error": "bad token"})

        try:
            length = int(self.headers.get("Content-Length", "0"))
            data = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return self._json(400, {"ok": False, "error": "bad json"})

        version = str(data.get("version", "")).strip()
        if not version:
            return self._json(400, {"ok": False, "error": "missing version"})

        # 异步执行，先回 202，避免网页端超时
        def worker() -> None:
            try:
                msg = do_upgrade(version, self.args)
                log("升级完成: " + msg)
            except Exception as e:
                log("升级失败: " + str(e))

        threading.Thread(target=worker, daemon=True).start()
        self._json(202, {"ok": True, "message": f"升级任务已接受: {version}"})

    def do_GET(self) -> None:
        if self.path.rstrip("/") == "/health":
            return self._json(200, {"ok": True})
        return self._json(404, {"ok": False})

    def log_message(self, fmt: str, *a) -> None:
        pass  # 静默默认访问日志


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=10099)
    p.add_argument("--token", required=True)
    p.add_argument("--compose", default="/vol1/lunatv/docker-compose.yml")
    p.add_argument("--service", default="lunatv-core")
    p.add_argument("--owner", default="jshmcz", help="GHCR 镜像 owner（小写）")
    args = p.parse_args()
    Handler.args = args

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    log(f"升级 webhook 已启动: http://{args.host}:{args.port}  compose={args.compose}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("已停止")


if __name__ == "__main__":
    main()
