/* eslint-disable no-console */
/**
 * 站长增强：用户活动总览接口（仅站长）
 *
 * 返回：
 *  - users[].playCount / lastPlayAt      每个用户播放记录数与最近播放时间
 *  - users[].searchCount / lastSearchAt  每个用户搜索次数与最近搜索时间
 *  - users[].online / deviceCount        是否在线、活跃终端数
 *  - users[].tvboxDeviceCount            TVBox key 关联的不同设备数（防泄漏）
 *  - sessions                            当前活跃会话明细
 *  - devices                             终端聚合（累计登录次数）
 *  - kicks                               互踢痕迹
 */
import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { db } from '@/lib/db';
import {
  DeviceInfo,
  KickLog,
  listKicks,
  listSessions,
  SessionInfo,
} from '@/lib/session';
import { getKeyDevices } from '@/lib/tvboxKeyGuard';

export const runtime = 'nodejs';

interface UserOverview {
  username: string;
  role: string;
  banned: boolean;
  playCount: number;
  lastPlayAt: number | null;
  searchCount: number;
  lastSearchAt: number | null;
  online: boolean;
  activeSessions: number;
  deviceCount: number;
  activeDeviceCount: number;
  kickCount: number;
  tvboxDeviceCount: number;
  devices: DeviceInfo[];
}

const ONLINE_WINDOW = 60 * 1000; // 最近 60 秒有活动算在线

export async function GET(request: NextRequest) {
  try {
    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo?.username) {
      return NextResponse.json({ error: '未登录' }, { status: 401 });
    }
    if (authInfo.username !== process.env.USERNAME) {
      return NextResponse.json(
        { error: '权限不足，仅站长可查看' },
        { status: 401 },
      );
    }

    const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
    if (storageType === 'localstorage') {
      return NextResponse.json(
        { error: '当前为本地存储模式，无用户数据' },
        { status: 400 },
      );
    }

    const dbUsers = await db.getAllUsers();
    const config = await getConfig();
    const configured = config.UserConfig?.Users || [];

    const usernames = new Set<string>();
    dbUsers.forEach((u) => usernames.add(u.user_name));
    configured.forEach((u) => usernames.add(u.username));
    if (process.env.USERNAME) usernames.add(process.env.USERNAME);

    const { sessions, devices } = await listSessions();
    const now = Date.now();

    const kickCountByUser = new Map<string, number>();
    for (const name of Array.from(usernames)) {
      kickCountByUser.set(name, (await listKicks(name)).length);
    }

    const users: UserOverview[] = [];
    for (const username of Array.from(usernames)) {
      const cfg = configured.find((u) => u.username === username);

      const playRecords = await db.getAllPlayRecords(username);
      const playValues = Object.values(playRecords || {});
      let lastPlayAt: number | null = null;
      for (const r of playValues) {
        const t = (r as { save_time?: number })?.save_time;
        if (typeof t === 'number' && (!lastPlayAt || t > lastPlayAt)) {
          lastPlayAt = t;
        }
      }

      const search = await db.getSearchHistory(username);
      const userSessions = sessions.filter((s) => s.username === username);
      const userDevices = devices.filter((d) => d.username === username);
      const online = userSessions.some(
        (s) => now - s.lastActive < ONLINE_WINDOW,
      );

      // [tvbox-keyguard] 该用户 TVBox key 关联的不同设备数
      let tvboxDeviceCount = 0;
      if (cfg?.key) {
        try {
          const tvDevices = await getKeyDevices(cfg.key);
          tvboxDeviceCount = tvDevices.length;
        } catch {
          tvboxDeviceCount = 0;
        }
      }

      users.push({
        username,
        role:
          username === process.env.USERNAME ? 'owner' : (cfg?.role || 'user'),
        banned: cfg?.banned || false,
        playCount: playValues.length,
        lastPlayAt,
        searchCount: search.length,
        lastSearchAt: null,
        online,
        activeSessions: userSessions.length,
        deviceCount: userDevices.length,
        activeDeviceCount: userDevices.filter((d) => d.active).length,
        kickCount: kickCountByUser.get(username) || 0,
        tvboxDeviceCount,
        devices: userDevices,
      });
    }

    users.sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      if (a.activeSessions !== b.activeSessions)
        return b.activeSessions - a.activeSessions;
      return b.playCount - a.playCount;
    });

    const allKicks: KickLog[] = [];
    for (const username of Array.from(usernames)) {
      allKicks.push(...(await listKicks(username)));
    }
    allKicks.sort((a, b) => b.at - a.at);

    return NextResponse.json({
      ok: true,
      generatedAt: now,
      users,
      sessions: sessions as SessionInfo[],
      devices,
      kicks: allKicks.slice(0, 50),
      summary: {
        totalUsers: users.length,
        onlineUsers: users.filter((u) => u.online).length,
        totalSessions: sessions.length,
        totalDevices: devices.length,
        totalPlays: users.reduce((s, u) => s + u.playCount, 0),
        totalSearches: users.reduce((s, u) => s + u.searchCount, 0),
      },
    });
  } catch (error) {
    console.error('用户活动总览失败:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '获取失败' },
      { status: 500 },
    );
  }
}
