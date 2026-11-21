/**
 * 站长增强：登录门面（包裹官方登录逻辑）+ 防暴破验证码
 *
 * 在原有门面（会话/设备限制）之前插入验证码门禁：
 * - CAPTCHA_ENABLED !== 'false' 时生效
 * - 同一 IP 连续失败达到阈值（2 次）后，第 3 次起必须带正确验证码
 * - 验证码通过请求头 X-Captcha-Token / X-Captcha-Code 传递（不碰 body，origPost 照常读 body）
 * - 验证码一次性消费；登录成功清空该 IP 失败计数
 *
 * 完全不改官方校验逻辑（origPost），上游升级只需重新套补丁。
 */
import { NextRequest, NextResponse } from 'next/server';

import {
  clearFail,
  getClientIp,
  isCaptchaEnabled,
  needCaptcha,
  recordFail,
  verifyCaptcha,
} from '@/lib/loginGuard';
import { checkDeviceLimit, createSession, SessionRole } from '@/lib/session';

import { POST as origPost } from './route.orig';

export const runtime = 'nodejs';

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

interface AuthData {
  role?: SessionRole;
  username?: string;
  signature?: string;
  timestamp?: number;
  password?: string;
  sid?: string;
  deviceId?: string;
  deviceName?: string;
}

function parseAuth(value: string): AuthData | null {
  try {
    return JSON.parse(decodeURIComponent(value));
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIp(req);

  // ---------- 0) 防暴破验证码门禁 ----------
  if (isCaptchaEnabled() && (await needCaptcha(ip))) {
    const token = req.headers.get('x-captcha-token') || undefined;
    const code = req.headers.get('x-captcha-code') || undefined;
    if (!(await verifyCaptcha(token, code))) {
      return NextResponse.json(
        {
          error: '连续登录失败次数过多，请输入验证码',
          needCaptcha: true,
        },
        { status: 429 },
      );
    }
  }

  // 1) 完全沿用官方登录逻辑（body 未被读取，origPost 可正常 json()）
  const resp = await origPost(req);

  // 2) 登录失败：累加失败计数，并告知前端是否需要验证码
  if (resp.status !== 200) {
    if (isCaptchaEnabled()) {
      const count = await recordFail(ip);
      const out = new NextResponse(resp.body, {
        status: resp.status,
        headers: resp.headers,
      });
      out.headers.set('X-Need-Captcha', count >= 2 ? '1' : '0');
      return out;
    }
    return resp;
  }

  // 3) 登录成功：清空失败计数
  if (isCaptchaEnabled()) await clearFail(ip);

  // 4) 仅处理带签名 cookie 的登录（数据库/redis 模式）
  const authCookie = resp.cookies.get('auth');
  if (!authCookie?.value) return resp;

  const data = parseAuth(authCookie.value);
  if (!data || !data.username || !data.signature) {
    // localstorage 模式（cookie 里是 password）不参与多端会话
    return resp;
  }
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  if (storageType === 'localstorage') return resp;

  // 5) 读取设备信息（由 SessionGuard 的 fetch 拦截器注入请求头）
  const deviceId = req.headers.get('x-device-id') || 'unknown';
  const deviceName = req.headers.get('x-device-name') || '未知设备';
  const ua = req.headers.get('user-agent') || '';

  // 5.5) 登录设备数限制（仅统计不同设备；admin 豁免）。
  const deviceLimit = await checkDeviceLimit(data.username, deviceId);
  if (!deviceLimit.allowed) {
    const denied = NextResponse.json(
      {
        error: `该账号已登录 ${deviceLimit.count} 台设备，达到上限 ${deviceLimit.limit} 台。请先在其他设备退出或联系管理员清理设备记录后再登录。`,
        code: 'DEVICE_LIMIT_REACHED',
      },
      { status: 403 },
    );
    denied.cookies.set('auth', '', { path: '/', maxAge: 0 });
    return denied;
  }

  // 6) 创建会话（覆盖同用户旧 sid = 互踢），拿到 sid
  const sid = await createSession({
    username: data.username,
    role: data.role || 'user',
    deviceId,
    deviceName,
    ip,
    ua,
  });

  // 7) 把 sid / 设备信息写回 auth cookie
  data.sid = sid;
  data.deviceId = deviceId;
  data.deviceName = deviceName;
  resp.cookies.set('auth', encodeURIComponent(JSON.stringify(data)), {
    path: '/',
    expires: new Date(Date.now() + SEVEN_DAYS),
    sameSite: 'lax',
    httpOnly: false,
    secure: false,
  });

  return resp;
}
