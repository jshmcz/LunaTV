/* eslint-disable no-console */
/**
 * 站长增强：会话校验接口（客户端 SessionGuard 轮询）
 *
 * - 200 { valid:true }  ：会话仍为当前活跃会话
 * - 401 { valid:false, reason:'kicked' }：已被其它设备顶下线
 * - 401 { valid:false, reason:'expired' }：会话过期/服务端已清除
 */
import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { verifySession } from '@/lib/session';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  // localstorage 模式无多用户会话，直接放行
  if (storageType === 'localstorage') {
    return NextResponse.json({ valid: true, reason: 'ok' });
  }

  const authInfo = getAuthInfoFromCookie(request);
  const username = authInfo?.username;
  const sid = (authInfo as { sid?: string } | null)?.sid;

  if (!username || !sid) {
    return NextResponse.json(
      { valid: false, reason: 'no-session' },
      { status: 401 },
    );
  }

  const result = await verifySession(username, sid);
  if (!result.valid) {
    return NextResponse.json(
      { valid: false, reason: result.reason },
      { status: 401 },
    );
  }
  return NextResponse.json({ valid: true, reason: 'ok' });
}
