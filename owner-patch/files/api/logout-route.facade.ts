/* eslint-disable no-console */
/**
 * 站长增强：登出门面（包裹官方登出，额外清理服务端会话）
 */
import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { destroySession } from '@/lib/session';

import { POST as origPost } from './route.orig';

export const runtime = 'nodejs';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const authInfo = getAuthInfoFromCookie(request);
  const username = authInfo?.username;
  const sid = (authInfo as { sid?: string } | null)?.sid;

  // 沿用官方清 cookie 逻辑
  const resp = await origPost();

  // 额外清理服务端会话记录（失败不影响登出）
  if (username && sid) {
    try {
      await destroySession(username, sid);
    } catch (error) {
      console.error('清理会话失败:', error);
    }
  }
  return resp;
}
