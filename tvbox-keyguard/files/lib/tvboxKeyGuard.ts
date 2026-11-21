/* eslint-disable no-console */
/**
 * TVBox key 防泄漏守卫
 *
 * 功能：
 *  1) key 生成（取模映射到 10 位 base62），无法被枚举/猜测，且便于手动配置；
 *  2) 按 key 记录连接过的设备（来源 X-Forwarded-For 第一段，UA 辅助），超过
 *     MAX_TVBOX_DEVICES（默认 10）台时，只轮换“这一个” key（旧 key 立即失效）；
 *  3) 升级后一次性把全部老 key 换成长 key（全量轮换）。
 *
 * 说明：TVBox key 只作为配置接口的 token，登录鉴权走的是密码，不依赖 users 表
 * 的 key 字段。因此轮换 key 只需更新 admin_config 的 UserConfig.Users 即可生效，
 * 面板与管理接口均从此处读取。
 *
 * 纯服务端模块，仅依赖 next/cache 与项目内 db/config。
 */

import { getConfig, setCachedConfig } from '@/lib/config';
import { db } from '@/lib/db';

/** 单 key 允许的最大不同设备数，可用环境变量覆盖 */
export const MAX_TVBOX_DEVICES = Math.max(
  1,
  parseInt(process.env.MAX_TVBOX_DEVICES || '10', 10) || 10,
);

/** 设备记录缓存前缀与 TTL（30 天） */
const DEV_CACHE_PREFIX = 'tvbox:dev:';
const DEV_CACHE_TTL = 60 * 60 * 24 * 30;
/** 全量换新一次性标记 */
const MIGRATION_FLAG = 'tvbox:keyguard:migrated:v1';

const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** key 字符长度（base62，约 59 位熵，防枚举且便于手动复制） */
const KEY_LEN = 10;

/**
 * 生成 key：随机字节取模映射到固定 KEY_LEN 位 base62。
 * 使用 Node 的 randomBytes，密码学强度，无第三方依赖。
 */
export function generateLongKey(): string {
  const { randomBytes } = require('crypto') as typeof import('crypto');
  const bytes = randomBytes(16);
  const big = BigInt(BASE62.length);
  const max = big ** BigInt(KEY_LEN);
  let num = BigInt('0x' + bytes.toString('hex')) % max;
  let out = '';
  for (let i = 0; i < KEY_LEN; i++) {
    out = BASE62[Number(num % big)] + out;
    num = num / big;
  }
  return out || BASE62[0];
}

export interface DeviceEntry {
  ip: string;
  ua: string;
  ts: number;
}

interface DeviceStore {
  devices: DeviceEntry[];
}

export interface RotateResult {
  rotated: boolean;
  reason?: 'device-limit';
  oldKey?: string;
  newKey?: string;
  deviceCount: number;
}

/** 从请求头提取客户端 IP：优先 X-Forwarded-For 第一段，其次 X-Real-Ip */
export function extractClientIp(headers: {
  get(name: string): string | null;
}): string {
  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  const xreal = headers.get('x-real-ip');
  if (xreal && xreal.trim()) return xreal.trim();
  return 'unknown';
}

async function getDeviceStore(key: string): Promise<DeviceStore> {
  const data = await db.getCacheByKey(`${DEV_CACHE_PREFIX}${key}`);
  if (data && Array.isArray(data.devices)) return data as DeviceStore;
  return { devices: [] };
}

async function setDeviceStore(key: string, store: DeviceStore): Promise<void> {
  await db.setCacheByKey(`${DEV_CACHE_PREFIX}${key}`, store, DEV_CACHE_TTL);
}

/** 读取某 key 当前记录的设备数（给站长面板用） */
export async function getKeyDeviceCount(key: string): Promise<number> {
  const store = await getDeviceStore(key);
  return store.devices.length;
}

/** 读取某 key 的设备明细（给站长面板用） */
export async function getKeyDevices(key: string): Promise<DeviceEntry[]> {
  const store = await getDeviceStore(key);
  return store.devices;
}

/**
 * 轮换指定用户的 key：生成新长 key → 更新 admin_config 的 UserConfig.Users
 * → 失效配置缓存 → 清空旧 key 的设备记录。
 * 返回新 key 供调用方记录。
 */
export async function rotateUserKey(username: string): Promise<string> {
  const newKey = generateLongKey();
  const config = await getConfig();
  const users = config?.UserConfig?.Users;
  if (Array.isArray(users)) {
    const target = users.find((u: any) => u.username === username);
    if (target) {
      const oldKey = target.key;
      target.key = newKey;
      await setCachedConfig(config); // 内部 revalidateTag('admin-config')
      if (oldKey) await setDeviceStore(oldKey, { devices: [] });
      console.log(
        `[tvbox-keyguard] 已轮换用户 ${username} 的 key（旧 ${oldKey} → 新 ${newKey}）`,
      );
    }
  }
  return newKey;
}

/**
 * 记录一次 key 使用；若该 key 关联的不同设备数超过上限，则轮换该 key。
 * 应在 TVBox 鉴权成功后调用（每个带 k 的请求）。
 * @param username 该 key 所属用户名
 * @param key 本次请求携带的 key
 * @param headers 请求头（用于取 XFF / UA）
 */
export async function recordDeviceAndGuard(
  username: string,
  key: string,
  headers: { get(name: string): string | null },
): Promise<RotateResult> {
  const ip = extractClientIp(headers);
  const ua = (headers.get('user-agent') || '').slice(0, 120);

  const store = await getDeviceStore(key);
  const now = Date.now();
  const existing = store.devices.find((d) => d.ip === ip);
  if (existing) {
    existing.ts = now;
    existing.ua = ua;
  } else {
    store.devices.push({ ip, ua, ts: now });
  }
  await setDeviceStore(key, store);

  if (store.devices.length > MAX_TVBOX_DEVICES) {
    const newKey = await rotateUserKey(username);
    console.warn(
      `[tvbox-keyguard] key 关联设备数 ${store.devices.length} > ${MAX_TVBOX_DEVICES}，已轮换用户 ${username} 的 key`,
    );
    return {
      rotated: true,
      reason: 'device-limit',
      oldKey: key,
      newKey,
      deviceCount: store.devices.length,
    };
  }

  return { rotated: false, deviceCount: store.devices.length };
}

/**
 * 升级后一次性全量换新所有 key（把短 key 换成长 key）。
 * 用 cache 标记保证只执行一次。
 */
export async function rotateAllKeysOnce(): Promise<{
  migrated: boolean;
  count: number;
}> {
  const flag = await db.getCacheByKey(MIGRATION_FLAG);
  if (flag) return { migrated: false, count: 0 };

  const config = await getConfig();
  const users = config?.UserConfig?.Users;
  if (!Array.isArray(users) || users.length === 0) {
    await db.setCacheByKey(MIGRATION_FLAG, { at: Date.now() }, DEV_CACHE_TTL);
    return { migrated: false, count: 0 };
  }

  let count = 0;
  for (const u of users as any[]) {
    if (!u.username) continue;
    u.key = generateLongKey();
    count++;
  }
  await setCachedConfig(config);
  await db.setCacheByKey(
    MIGRATION_FLAG,
    { at: Date.now(), count },
    DEV_CACHE_TTL,
  );
  console.log(`[tvbox-keyguard] 全量换新完成，共更新 ${count} 个 key`);
  return { migrated: true, count };
}
