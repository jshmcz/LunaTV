/* eslint-disable no-console */
/**
 * 站长增强：单终端登录 / 终端识别 / 互踢会话层
 *
 * 设计要点：
 * - 完全基于现有 cache 表（getCacheByKey / setCacheByKey），不新增数据库表，
 *   因此 sqlite / redis / upstash / kvrocks 四种后端都能直接工作，且上游升级零冲突。
 * - Web 会话用 sid 标识；同一用户只保留一个活跃 sid（session:user:<username>）。
 *   新登录会覆盖旧 sid，旧设备被判定为「已踢」，由客户端 SessionGuard 引导重新登录。
 * - TVBox 走 key 校验，不经过浏览器组件，天然豁免互踢。
 */

import { db } from '@/lib/db';

export const runtime = 'nodejs';

// sid 有效期：8 天（比 cookie 的 7 天多 1 天，避免边界抖动）
const SESSION_TTL = 8 * 24 * 60 * 60;

const PREFIX = {
  sid: 'owner:sess:sid:', // owner:sess:sid:<sid>       -> SessionInfo
  user: 'owner:sess:user:', // owner:sess:user:<username> -> { sid }
  idx: 'owner:sess:idx', // owner:sess:idx             -> string[]（所有活跃 sid）
  device: 'owner:sess:dev:', // owner:sess:dev:<deviceId> -> DeviceInfo（终端聚合）
  kicks: 'owner:sess:kicks:', // owner:sess:kicks:<username> -> KickLog[]（互踢痕迹）
};

export type SessionRole = 'owner' | 'admin' | 'user';

export interface SessionInfo {
  sid: string;
  username: string;
  role: SessionRole;
  deviceId: string;
  deviceName: string;
  loginAt: number;
  lastActive: number;
  ip: string;
  ua: string;
}

export interface DeviceInfo {
  deviceId: string;
  deviceName: string;
  username: string;
  firstSeen: number;
  lastSeen: number;
  loginCount: number;
}

/** 互踢痕迹：谁在何时被哪台新设备顶下线 */
export interface KickLog {
  at: number;
  username: string;
  kickedDevice: string; // 被顶掉的设备名
  kickerDevice: string; // 发起登录的设备名
  kickerIp: string;
}

export interface VerifyResult {
  valid: boolean;
  reason?: 'no-session' | 'kicked' | 'expired' | 'ok';
  session?: SessionInfo;
}

/** 生成一个会话 id */
export function newSid(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

function sidKey(sid: string): string {
  return `${PREFIX.sid}${sid}`;
}
function userKey(username: string): string {
  return `${PREFIX.user}${username}`;
}
function deviceKey(deviceId: string): string {
  return `${PREFIX.device}${deviceId}`;
}

/**
 * 登录成功后调用：创建会话并踢掉该用户之前的会话。
 * 返回新 sid，需写入 cookie 的 sid 字段。
 */
export async function createSession(params: {
  username: string;
  role: SessionRole;
  deviceId?: string;
  deviceName?: string;
  ip?: string;
  ua?: string;
}): Promise<string> {
  const sid = newSid();
  const now = Date.now();
  const deviceId = params.deviceId || 'unknown';
  const deviceName = params.deviceName || '未知设备';

  const info: SessionInfo = {
    sid,
    username: params.username,
    role: params.role,
    deviceId,
    deviceName,
    loginAt: now,
    lastActive: now,
    ip: params.ip || '',
    ua: (params.ua || '').slice(0, 300),
  };

  // 1) 记录该用户当前活跃 sid（覆盖即互踢）；若已有别的活跃 sid，留下互踢痕迹
  const previous = await db.getCacheByKey(userKey(params.username));
  if (previous && previous.sid && previous.sid !== sid) {
    const oldInfo: SessionInfo | null = await db.getCacheByKey(
      sidKey(previous.sid),
    );
    const kicksKey = `${PREFIX.kicks}${params.username}`;
    const kicks: KickLog[] = (await db.getCacheByKey(kicksKey)) || [];
    kicks.unshift({
      at: now,
      username: params.username,
      kickedDevice: oldInfo?.deviceName || '未知设备',
      kickerDevice: deviceName,
      kickerIp: params.ip || '',
    });
    await db.setCacheByKey(kicksKey, kicks.slice(0, 50), SESSION_TTL);
    // 旧会话立即失效（把它的详情清成过期）
    await db.setCacheByKey(sidKey(previous.sid), null, 1);
  }
  await db.setCacheByKey(userKey(params.username), { sid }, SESSION_TTL);

  // 2) 写入会话详情
  await db.setCacheByKey(sidKey(sid), info, SESSION_TTL);

  // 3) 加入全局索引（cache 表无法按前缀列举，需自维护索引）
  const idx: string[] = (await db.getCacheByKey(PREFIX.idx)) || [];
  const cleanIdx = idx.filter((s) => s !== sid);
  cleanIdx.push(sid);
  await db.setCacheByKey(PREFIX.idx, cleanIdx, SESSION_TTL);

  // 4) 终端聚合：同一 deviceId 累计登录次数
  const dev: DeviceInfo | null = await db.getCacheByKey(deviceKey(deviceId));
  const nextDev: DeviceInfo = {
    deviceId,
    deviceName,
    username: params.username,
    firstSeen: dev?.firstSeen || now,
    lastSeen: now,
    loginCount: (dev?.loginCount || 0) + 1,
  };
  await db.setCacheByKey(deviceKey(deviceId), nextDev, SESSION_TTL);

  return sid;
}

/**
 * 客户端轮询校验：cookie 的 sid 是否仍为该用户的活跃会话。
 */
export async function verifySession(
  username: string,
  sid: string,
  touch = true,
): Promise<VerifyResult> {
  if (!username || !sid) {
    return { valid: false, reason: 'no-session' };
  }

  const current = await db.getCacheByKey(userKey(username));
  if (!current || !current.sid) {
    return { valid: false, reason: 'expired' };
  }
  if (current.sid !== sid) {
    return { valid: false, reason: 'kicked' };
  }

  const info: SessionInfo | null = await db.getCacheByKey(sidKey(sid));
  if (!info) {
    return { valid: false, reason: 'expired' };
  }

  if (touch) {
    info.lastActive = Date.now();
    await db.setCacheByKey(sidKey(sid), info, SESSION_TTL);
  }
  return { valid: true, reason: 'ok', session: info };
}

/** 登出：清除会话；若登出的正是活跃会话则一并清除 user 映射 */
export async function destroySession(username: string, sid: string): Promise<void> {
  if (sid) {
    await db.setCacheByKey(sidKey(sid), null, 1);
    const current = await db.getCacheByKey(userKey(username));
    if (current && current.sid === sid) {
      await db.setCacheByKey(userKey(username), null, 1);
    }
    const idx: string[] = (await db.getCacheByKey(PREFIX.idx)) || [];
    await db.setCacheByKey(
      PREFIX.idx,
      idx.filter((s) => s !== sid),
      SESSION_TTL,
    );
  }
}

/**
 * 站长面板数据：列出所有活跃会话 + 终端聚合。
 */
export async function listSessions(): Promise<{
  sessions: SessionInfo[];
  devices: DeviceInfo[];
}> {
  const idx: string[] = (await db.getCacheByKey(PREFIX.idx)) || [];
  const sessions: SessionInfo[] = [];
  for (const sid of idx) {
    const info: SessionInfo | null = await db.getCacheByKey(sidKey(sid));
    if (info) sessions.push(info);
  }
  sessions.sort((a, b) => b.lastActive - a.lastActive);

  // 终端聚合：从所有会话里按 deviceId 归并，同时补充设备表里的历史登录次数
  const devMap = new Map<string, DeviceInfo>();
  for (const s of sessions) {
    const stored: DeviceInfo | null = await db.getCacheByKey(deviceKey(s.deviceId));
    const prev = devMap.get(s.deviceId);
    devMap.set(s.deviceId, {
      deviceId: s.deviceId,
      deviceName: s.deviceName,
      username: s.username,
      firstSeen: Math.min(prev?.firstSeen ?? s.loginAt, stored?.firstSeen ?? s.loginAt),
      lastSeen: Math.max(prev?.lastSeen ?? s.lastActive, stored?.lastSeen ?? s.lastActive),
      loginCount: stored?.loginCount ?? prev?.loginCount ?? 1,
    });
  }
  const devices = Array.from(devMap.values()).sort((a, b) => b.lastSeen - a.lastSeen);
  return { sessions, devices };
}

/** 统计某用户当前活跃终端数 */
export async function countActiveSessions(username: string): Promise<number> {
  const current = await db.getCacheByKey(userKey(username));
  return current && current.sid ? 1 : 0;
}

/** 读取某用户的互踢痕迹（最多 50 条） */
export async function listKicks(username: string): Promise<KickLog[]> {
  return (await db.getCacheByKey(`${PREFIX.kicks}${username}`)) || [];
}
