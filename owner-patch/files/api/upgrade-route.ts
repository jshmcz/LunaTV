/* eslint-disable no-console */
/**
 * 站长增强：在线升级接口（仅站长）
 *
 * GET  /api/admin/upgrade        -> 检测是否有更新的镜像版本
 * POST /api/admin/upgrade        -> 触发 NAS 上的升级 webhook（真正执行 pull + recreate）
 *
 * 容器内没有 docker 命令，因此「在线升级」通过 webhook 交给宿主机脚本完成。
 * 版本源：直接查询 GHCR 上本人仓库已编译产出的镜像 tags（真实可升级的镜像），
 *        而不是官方仓库的源码版本文件——只有编译出的镜像才可 pull 升级。
 *
 * 需在 compose 里配置环境变量：
 *   UPGRADE_WEBHOOK_URL=http://<NAS_IP>:<PORT>/upgrade
 *   UPGRADE_WEBHOOK_TOKEN=<自定义令牌>
 *   GHCR_OWNER=<GHCR 用户名小写，默认 jshmcz>；GHCR_REPO=<镜像名，默认 lunatv>
 *   CURRENT_IMAGE_TAG=<当前运行的镜像 tag，用于判断是否需要升级，如 5.1.8.1>
 */
import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { CURRENT_VERSION } from '@/lib/utils';

export const runtime = 'nodejs';

function isOwner(request: NextRequest): boolean {
  const authInfo = getAuthInfoFromCookie(request);
  return !!authInfo?.username && authInfo.username === process.env.USERNAME;
}

/** 当前运行的镜像版本号：优先环境变量，回退到编译时的源码版本 */
function currentVersion(): string {
  return (process.env.CURRENT_IMAGE_TAG || CURRENT_VERSION || '').trim();
}

/** 解析 x.y.z[.p] 版本号（最多 4 段），无法解析返回 null */
function parseVersion(v: string): number[] | null {
  try {
    const parts = v
      .trim()
      .replace(/^v/i, '')
      .split('.')
      .slice(0, 4)
      .map((p) => {
        const n = parseInt(p, 10);
        if (isNaN(n) || n < 0) throw new Error('bad');
        return n;
      });
    if (parts.length === 0) return null;
    return parts;
  } catch {
    return null;
  }
}

function compare(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return a === b ? 0 : -1;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function imageRepo(): string {
  const owner = (process.env.GHCR_OWNER || 'jshmcz').toLowerCase();
  const repo = (process.env.GHCR_REPO || 'lunatv').toLowerCase();
  return `${owner}/${repo}`;
}

/**
 * 从 GHCR 公开 tags API 拉取已编译的镜像版本列表。
 * 匿名 pull token 即可读取 public 包，无需凭据。
 */
async function fetchGhcrTags(): Promise<string[]> {
  const repo = imageRepo();
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 6000);
    const tokenResp = await fetch(
      `https://ghcr.io/token?scope=repository:${repo}:pull&service=ghcr.io`,
      { signal: controller.signal, cache: 'no-store' },
    );
    if (!tokenResp.ok) {
      clearTimeout(t);
      return [];
    }
    const tokenData = (await tokenResp.json()) as { token?: string };
    if (!tokenData.token) {
      clearTimeout(t);
      return [];
    }
    const listResp = await fetch(
      `https://ghcr.io/v2/${repo}/tags/list`,
      {
        headers: { Authorization: `Bearer ${tokenData.token}` },
        signal: controller.signal,
        cache: 'no-store',
      },
    );
    clearTimeout(t);
    if (!listResp.ok) return [];
    const data = (await listResp.json()) as { tags?: string[] };
    return Array.isArray(data.tags) ? data.tags : [];
  } catch (e) {
    console.warn('GHCR tags 检测失败:', e);
    return [];
  }
}

/** 从 tag 列表中挑出比当前版本更新的、语义化最高的 tag */
function pickNewest(tags: string[], current: string): string | null {
  const candidates = tags.filter((tag) => {
    if (/^latest$/i.test(tag)) return false;
    return parseVersion(tag) !== null && compare(tag, current) > 0;
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => compare(b, a));
  return candidates[0];
}

export async function GET(request: NextRequest) {
  if (!isOwner(request)) {
    return NextResponse.json({ error: '仅站长可用' }, { status: 401 });
  }

  const webhookConfigured = !!process.env.UPGRADE_WEBHOOK_URL;
  const current = currentVersion();
  const tags = await fetchGhcrTags();
  const latest = pickNewest(tags, current);
  const hasUpdate = !!latest;

  return NextResponse.json({
    ok: true,
    currentVersion: current,
    latestVersion: latest,
    availableTags: tags.filter((t) => !/^latest$/i.test(t)).slice(0, 20),
    hasUpdate,
    webhookConfigured,
    message: tags.length === 0
      ? '无法连接 GHCR 镜像源，请检查网络或稍后重试'
      : hasUpdate
        ? webhookConfigured
          ? `发现新镜像 ${latest}，可点击下方按钮在线升级`
          : `发现新镜像 ${latest}，但尚未配置升级 webhook`
        : '当前已是最新镜像',
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
    const tags = await fetchGhcrTags();
    const latest = pickNewest(tags, currentVersion());
    if (!latest) {
      return NextResponse.json(
        { error: '未发现可升级的新镜像，请在请求中指定 version' },
        { status: 400 },
      );
    }
    targetVersion = latest;
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
