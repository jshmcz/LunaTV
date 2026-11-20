/**
 * 登录防暴破：失败计数 + 一次性图形验证码
 *
 * 设计要点：
 * - 完全基于现有 cache 表（getCacheByKey / setCacheByKey），不新增数据库表，
 *   sqlite / redis / upstash / kvrocks 四种后端都能直接工作。
 * - 无第三方依赖：验证码为服务端自绘的 4 位数字 SVG，答案存 cache，校验后立即消费。
 * - 开关：CAPTCHA_ENABLED !== 'false' 时启用；阈值：连续失败 2 次后要求验证码。
 * - 失败计数按客户端 IP（XFF 首段 / x-real-ip）统计，15 分钟无失败自动过期。
 */
import { NextRequest } from 'next/server';

import { db } from '@/lib/db';

export const runtime = 'nodejs';

const PREFIX = {
  fail: 'owner:login:fail:', // owner:login:fail:<ip>       -> { count, lastFail }
  captcha: 'owner:login:captcha:', // owner:login:captcha:<token>  -> { code, consumed }
};

/** 连续失败多少次后要求验证码 */
export const CAPTCHA_THRESHOLD = 2;
/** 失败计数 / 验证码答案的 TTL（秒） */
const FAIL_TTL = 15 * 60;
const CAPTCHA_TTL = 5 * 60;

export function isCaptchaEnabled(): boolean {
  return process.env.CAPTCHA_ENABLED !== 'false';
}

/** 取客户端真实 IP：优先 XFF 第一段，其次 x-real-ip */
export function getClientIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip')?.trim() ||
    'unknown'
  );
}

function failKey(ip: string): string {
  return `${PREFIX.fail}${ip}`;
}
function captchaKey(token: string): string {
  return `${PREFIX.captcha}${token}`;
}

export interface FailState {
  count: number;
  lastFail: number;
}

export async function getFailCount(ip: string): Promise<number> {
  const data: FailState | null = await db.getCacheByKey(failKey(ip));
  return data && typeof data.count === 'number' ? data.count : 0;
}

/** 记录一次失败，返回累计失败次数 */
export async function recordFail(ip: string): Promise<number> {
  const data: FailState | null = await db.getCacheByKey(failKey(ip));
  const count = data && typeof data.count === 'number' ? data.count + 1 : 1;
  await db.setCacheByKey(failKey(ip), { count, lastFail: Date.now() }, FAIL_TTL);
  return count;
}

/** 登录成功后清空失败计数 */
export async function clearFail(ip: string): Promise<void> {
  await db.setCacheByKey(failKey(ip), { count: 0, lastFail: 0 }, 1);
}

/** 当前 IP 是否必须输入验证码 */
export async function needCaptcha(ip: string): Promise<boolean> {
  if (!isCaptchaEnabled()) return false;
  return (await getFailCount(ip)) >= CAPTCHA_THRESHOLD;
}

/** 4 位数字验证码 -> data URL（自绘 SVG，无第三方依赖） */
function makeSvg(code: string): string {
  const colors = ['#1d4ed8', '#dc2626', '#059669', '#7c3aed', '#b45309'];
  let chars = '';
  for (let i = 0; i < code.length; i++) {
    const x = 10 + i * 26;
    const rot = (Math.random() * 40 - 20).toFixed(1);
    const color = colors[Math.floor(Math.random() * colors.length)];
    const size = 27 + Math.floor(Math.random() * 7);
    chars += `<text x="${x}" y="33" font-family="Arial,Helvetica,sans-serif" font-size="${size}" font-weight="bold" fill="${color}" transform="rotate(${rot} ${x} 29)">${code[i]}</text>`;
  }
  let lines = '';
  for (let i = 0; i < 3; i++) {
    const x1 = Math.floor(Math.random() * 112);
    const y1 = Math.floor(Math.random() * 40);
    const x2 = Math.floor(Math.random() * 112);
    const y2 = Math.floor(Math.random() * 40);
    lines += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#9ca3af" stroke-width="1" opacity="0.6"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="112" height="40" viewBox="0 0 112 40"><rect width="112" height="40" fill="#f3f4f6"/>${lines}${chars}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** 生成验证码：返回 token 与图片 data URL，答案存 cache */
export async function issueCaptcha(): Promise<{ token: string; svg: string }> {
  const code = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  const token = crypto.randomUUID().replace(/-/g, '');
  await db.setCacheByKey(
    captchaKey(token),
    { code, consumed: false },
    CAPTCHA_TTL,
  );
  return { token, svg: makeSvg(code) };
}

/** 校验验证码（一次性，大小写/空白不敏感），成功即消费 */
export async function verifyCaptcha(
  token: string | undefined,
  input: string | undefined,
): Promise<boolean> {
  if (!token || !input) return false;
  const data: { code?: string; consumed?: boolean } | null =
    await db.getCacheByKey(captchaKey(token));
  if (!data || data.consumed || !data.code) return false;
  const ok = String(data.code) === String(input).trim();
  if (ok) {
    // 消费掉：写回已消费标记，短 TTL 让其尽快过期
    await db.setCacheByKey(captchaKey(token), { consumed: true }, 5);
  }
  return ok;
}
