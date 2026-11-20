/**
 * 登录防暴破：验证码接口（GET）
 * - GET /api/captcha?check=1 -> { enabled, needCaptcha }（首屏探测是否需要验证码，不生成图片）
 * - GET /api/captcha         -> { token, svg }（svg 为 data URL，可直接放进 <img src>）
 * 答案由 loginGuard 存入 cache，登录时一次性校验消费。
 */
import { NextRequest, NextResponse } from 'next/server';

import {
  getClientIp,
  isCaptchaEnabled,
  issueCaptcha,
  needCaptcha,
} from '@/lib/loginGuard';

export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isCaptchaEnabled()) {
    return NextResponse.json({ enabled: false, needCaptcha: false });
  }

  // 首屏探测：当前 IP 是否已达失败阈值（前端据此决定是否显示验证码框）
  if (req.nextUrl.searchParams.get('check') === '1') {
    return NextResponse.json(
      { enabled: true, needCaptcha: await needCaptcha(getClientIp(req)) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const { token, svg } = await issueCaptcha();
  return NextResponse.json(
    { token, svg },
    {
      headers: {
        // 验证码图片绝不能被中间层缓存，否则所有人拿到同一张图
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    },
  );
}
