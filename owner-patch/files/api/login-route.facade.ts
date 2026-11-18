/* eslint-disable no-console */
/**
 * 站长增强：登录门面（包裹官方登录逻辑）
 *
 * 原登录 route.ts 会被补丁脚本备份为 route.orig.ts，本文件替换 route.ts。
 * 流程：调用原 POST -> 成功后解析 auth cookie -> 创建会话并注入 sid/deviceId -> 返回。
 * 好处：完全不改动官方登录校验逻辑，上游升级只需重新套补丁，冲突面积极小。
 */
import { NextRequest, NextResponse } from 'next/server';

import { createSession, SessionRole } from '@/lib/session';

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
  // 1) 完全沿用官方登录逻辑
  const resp = await origPost(req);

  // 2) 仅处理成功且带签名 cookie 的登录（数据库/redis 模式）
  if (resp.status !== 200) return resp;
  const authCookie = resp.cookies.get('auth');
  if (!authCookie?.value) return resp;

  const data = parseAuth(authCookie.value);
  if (!data || !data.username || !data.signature) {
    // localstorage 模式（cookie 里是 password）不参与多端会话
    return resp;
  }
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  if (storageType === 'localstorage') return resp;

  // 3) 读取设备信息（由 SessionGuard 的 fetch 拦截器注入请求头）
  const deviceId = req.headers.get('x-device-id') || 'unknown';
  const deviceName = req.headers.get('x-device-name') || '未知设备';
  const ua = req.headers.get('user-agent') || '';
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    '';

  // 4) 创建会话（覆盖同用户旧 sid = 互踢），拿到 sid
  const sid = await createSession({
    username: data.username,
    role: data.role || 'user',
    deviceId,
    deviceName,
    ip,
    ua,
  });

  // 5) 把 sid / 设备信息写回 auth cookie（不影响原 signature，因为签名只覆盖 username）
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
