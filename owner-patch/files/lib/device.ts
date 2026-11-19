'use client';
/**
 * 站长增强：浏览器持久终端 ID
 *
 * - 首次访问生成 UUID 存 localStorage，同一浏览器重登录算同一终端；
 * - 通过 fetch 拦截器给 /api/login 自动附加 X-Device-Id / X-Device-Name，
 *   因此无需改动官方登录页 login/page.tsx（上游升级零冲突）。
 */

const DEVICE_ID_KEY = 'ltv_device_id';
const DEVICE_NAME_KEY = 'ltv_device_name';

/** 读取（或首次生成）本浏览器的持久设备 ID */
export function getOrCreateDeviceId(): string {
  if (typeof window === 'undefined') return 'server';
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = crypto.randomUUID().replace(/-/g, '');
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    return 'unknown';
  }
}

/** 根据 UA 推断一个可读的设备名 */
export function getDeviceName(): string {
  if (typeof window === 'undefined') return '服务端';
  try {
    const cached = localStorage.getItem(DEVICE_NAME_KEY);
    if (cached) return cached;
    const ua = navigator.userAgent;
    let os = '未知系统';
    if (/Windows/i.test(ua)) os = 'Windows';
    else if (/Android/i.test(ua)) os = 'Android';
    else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
    else if (/Mac OS X/i.test(ua)) os = 'macOS';
    else if (/Linux/i.test(ua)) os = 'Linux';
    else if (/TV|HDMI|SmartTV/i.test(ua)) os = '电视/盒子';

    let app = '浏览器';
    if (/Edg\//.test(ua)) app = 'Edge';
    else if (/Chrome\//.test(ua) && !/Edg\//.test(ua)) app = 'Chrome';
    else if (/Firefox\//.test(ua)) app = 'Firefox';
    else if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) app = 'Safari';
    else if (/MicroMessenger/i.test(ua)) app = '微信';
    else if (/TVBox/i.test(ua)) app = 'TVBox';

    const name = `${os} · ${app}`;
    localStorage.setItem(DEVICE_NAME_KEY, name);
    return name;
  } catch {
    return '未知设备';
  }
}
