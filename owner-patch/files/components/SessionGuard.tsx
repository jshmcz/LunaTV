'use client';
/**
 * 站长增强：单终端会话守卫（全局挂载）
 *
 * 职责：
 * 1) 拦截 fetch，给 /api/login 请求附加可靠的一次性设备 ID（localStorage 持久化）；
 * 2) 定时轮询 /api/session/verify，一旦被顶下线，清 cookie 并跳转登录页；
 * 3) 页面从后台切回前台时立即校验一次，缩短被踢后的感知延迟；
 * 4) 被顶下线后在登录页显示「已被其他设备顶下线」提示。
 *
 * 对官方页面零侵入：只在 layout.tsx 里多挂一个 <SessionGuard />。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { getDeviceName, getOrCreateDeviceId as getDeviceId } from '@/lib/device';

const LOGIN_PATH = '/api/login';
const VERIFY_PATH = '/api/session/verify';
const POLL_INTERVAL = 15 * 1000; // 15 秒轮询一次

export default function SessionGuard() {
  const redirecting = useRef(false);
  const [kickedNotice, setKickedNotice] = useState(false);

  // 登录页若带 reason=kicked，展示被顶下线提示
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const reason = new URLSearchParams(window.location.search).get('reason');
    if (reason === 'kicked') setKickedNotice(true);
  }, []);

  const check = useCallback(async () => {
    if (redirecting.current) return;
    const path = window.location.pathname;
    if (
      path.startsWith('/login') ||
      path.startsWith('/warning') ||
      path.startsWith('/icons')
    ) {
      return;
    }
    const hasAuth = document.cookie
      .split(';')
      .some((c) => c.trim().startsWith('auth='));
    if (!hasAuth) return;

    try {
      const resp = await fetch(VERIFY_PATH, { cache: 'no-store' });
      if (resp.status === 401) {
        redirecting.current = true;
        const data = await resp.json().catch(() => ({}));
        const reason = data?.reason || 'kicked';
        await fetch('/api/logout', { method: 'POST' }).catch(() => {});
        const loginUrl = new URL('/login', window.location.origin);
        loginUrl.searchParams.set('reason', reason);
        loginUrl.searchParams.set(
          'redirect',
          window.location.pathname + window.location.search,
        );
        window.location.replace(loginUrl.toString());
      }
    } catch {
      // 网络抖动不处理，下一轮再校验
    }
  }, []);

  useEffect(() => {
    // --- 1) 安装 fetch 拦截器：给登录请求注入设备信息 ---
    const originalFetch = window.fetch.bind(window);
    const patchedFetch = (
      input: Parameters<typeof window.fetch>[0],
      init?: RequestInit,
    ): Promise<Response> => {
      let url = '';
      if (typeof input === 'string') url = input;
      else if (input instanceof URL) url = input.pathname;
      else if (input && (input as Request).url) url = (input as Request).url;

      const isLogin =
        url === LOGIN_PATH ||
        url.endsWith(LOGIN_PATH) ||
        url.includes(`${LOGIN_PATH}?`);
      if (!isLogin) return originalFetch(input, init);

      const headers = new Headers(init?.headers || {});
      headers.set('X-Device-Id', getDeviceId());
      headers.set('X-Device-Name', getDeviceName());

      let body = init?.body;
      if (typeof body === 'string') {
        try {
          const obj = JSON.parse(body);
          obj.deviceId = getDeviceId();
          obj.deviceName = getDeviceName();
          body = JSON.stringify(obj);
        } catch {
          /* 保持原样 */
        }
      }
      return originalFetch(input, { ...init, headers, body });
    };
    window.fetch = patchedFetch as typeof window.fetch;

    // --- 2) 定时轮询 + 前台切回立即校验 ---
    const timer = window.setInterval(check, POLL_INTERVAL);
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', check);
    const first = window.setTimeout(check, 3000);

    return () => {
      window.fetch = originalFetch;
      window.clearInterval(timer);
      window.clearTimeout(first);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', check);
    };
  }, [check]);

  if (!kickedNotice || typeof document === 'undefined') return null;
  return createPortal(
    <div className='fixed top-4 left-1/2 z-100 -translate-x-1/2 px-4 py-3 rounded-xl bg-red-600 text-white text-sm shadow-lg flex items-center gap-3'>
      <span>该账号已在其他设备登录，当前会话已下线</span>
      <button
        onClick={() => setKickedNotice(false)}
        className='ml-2 px-2 py-0.5 rounded bg-white/20 hover:bg-white/30'
      >
        知道了
      </button>
    </div>,
    document.body,
  );
}
