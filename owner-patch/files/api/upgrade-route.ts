/* eslint-disable no-console */
/**
 * 站长增强：在线升级接口（仅站长）
 *
 * GET  /api/admin/upgrade        -> 检测 GitHub 是否有新版本
 * POST /api/admin/upgrade        -> 触发 NAS 上的升级 webhook（真正执行 pull + recreate）
 *
 * 容器内没有 docker 命令，因此「在线升级」通过 webhook 交给宿主机脚本完成。
 * 需在 compose 里配置环境变量：
 *   UPGRADE_WEBHOOK_URL=http://<NAS_IP>:<PORT>/upgrade
 *   UPGRADE_WEBHOOK_TOKEN=<自定义令牌>
 *   UPGRADE_VERSION_URL=<可选，版本文件 raw 地址>
 */
import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { CURRENT_VERSION } from '@/lib/utils';

export const runtime = 'nodejs';

function isOwner(request: NextRequest): boolean {
  const authInfo = getAuthInfoFromCookie(request);
  return !!authInfo?.username && authInfo.username === process.env.USERNAME;
}

/** 解析 x.y.z 三段版本号，无法解析返回 null */
function parseVersion(v: string): number[] | null {
  try {
    const parts = v
      .trim()
      .replace(/^v/i, '')
      .split('.')
      .slice(0, 3)
      .map((p) => {
        const n = parseInt(p, 10);
        if (isNaN(n) || n < 0) throw new Error('bad');
        return n;
      });
    while (parts.length < 3) parts.push(0);
    return parts;
  } catch {
    return null;
  }
}

function compare(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return a === b ? 0 : -1;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

function buildVersionUrls(): string[] {
  const custom = process.env.UPGRADE_VERSION_URL;
  if (custom) return [custom];
  const user = process.env.GIT_USER || 'laboratorys';
  const repo = process.env.GIT_REPO || 'LunaTV';
  const branch = (process.env.GIT_BRANCH || 'main').toUpperCase();
  return [
    `https://raw.githubusercontent.com/${user}/${repo}/main/VERSION_${branch}.txt`,
    `https://cdn.jsdelivr.net/gh/${user}/${repo}@main/VERSION_${branch}.txt`,
  ];
}

async function fetchRemoteVersion(): Promise<string | null> {
  for (const url of buildVersionUrls()) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 6000);
      const resp = await fetch(`${url}?_t=${Date.now()}`, {
        signal: controller.signal,
        cache: 'no-store',
      });
      clearTimeout(t);
      if (!resp.ok) continue;
      const text = (await resp.text()).trim();
      if (text && text.length < 40) return text;
    } catch (e) {
      console.warn('版本检测失败:', url, e);
    }
  }
  return null;
}

export async function GET(request: NextRequest) {
  if (!isOwner(request)) {
    return NextResponse.json({ error: '仅站长可用' }, { status: 401 });
  }

  const webhookConfigured = !!process.env.UPGRADE_WEBHOOK_URL;
  const remote = await fetchRemoteVersion();
  const hasUpdate = remote ? compare(remote, CURRENT_VERSION) > 0 : false;

  return NextResponse.json({
    ok: true,
    currentVersion: CURRENT_VERSION,
    latestVersion: remote || null,
    hasUpdate,
    webhookConfigured,
    message: !remote
      ? '无法连接 GitHub 版本源，请稍后重试或检查网络'
      : hasUpdate
        ? webhookConfigured
          ? `发现新版本 ${remote}，可点击下方按钮在线升级`
          : `发现新版本 ${remote}，但尚未配置升级 webhook`
        : '当前已是最新版本',
  });
}

export async function POST(request: NextRequest) {
  if (!isOwner(request)) {
    return NextResponse.json({ error: '仅站长可用' }, { status: 401 });
  }
  if (!process.env.UPGRADE_WEBHOOK_URL) {
    return NextResponse.json(
      { error: '未配置 UPGRADE_WEBHOOK_URL，无法在线升级' },
      { status: 400 },
    );
  }

  let targetVersion = '';
  try {
    const body = await request.json().catch(() => ({}));
    targetVersion = (body.version || '').toString();
  } catch {
    /* 忽略 */
  }
  if (!targetVersion) {
    const remote = await fetchRemoteVersion();
    if (!remote) {
      return NextResponse.json(
        { error: '无法获取最新版本号，请在请求中指定 version' },
        { status: 400 },
      );
    }
    targetVersion = remote;
  }

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch(process.env.UPGRADE_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Token': process.env.UPGRADE_WEBHOOK_TOKEN || '',
      },
      body: JSON.stringify({
        version: targetVersion,
        requestedBy: getAuthInfoFromCookie(request)?.username,
      }),
      signal: controller.signal,
    });
    clearTimeout(t);
    const text = await resp.text().catch(() => '');
    if (!resp.ok) {
      return NextResponse.json(
        { error: `升级服务返回错误: ${resp.status} ${text.slice(0, 200)}` },
        { status: 502 },
      );
    }
    return NextResponse.json({
      ok: true,
      version: targetVersion,
      message:
        '升级任务已提交。镜像拉取并重启通常需要 1-3 分钟，期间页面可能短暂不可用，请稍后刷新。',
      detail: text.slice(0, 500),
    });
  } catch (error) {
    console.error('触发升级失败:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `无法连接升级服务: ${error.message}`
            : '触发升级失败',
      },
      { status: 502 },
    );
  }
}
