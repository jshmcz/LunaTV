'use client';
/**
 * 站长增强：站长面板（用户活动 + 终端 + 在线升级）
 * 作为 admin 页的新 Tab 挂载，仅站长可见可用（后端二次校验）。
 */

import {
  Activity,
  AlertTriangle,
  ArrowUpCircle,
  Clock,
  Download,
  Laptop,
  Monitor,
  RefreshCw,
  Search,
  Smartphone,
  Tv,
  Users,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { styles } from '@/app/admin/components/UIComponents';

const ONLINE_WINDOW = 60 * 1000;

interface DeviceInfo {
  deviceId: string;
  deviceName: string;
  username: string;
  firstSeen: number;
  lastSeen: number;
  loginCount: number;
}
interface SessionInfo {
  sid: string;
  username: string;
  role: string;
  deviceId: string;
  deviceName: string;
  loginAt: number;
  lastActive: number;
  ip: string;
  ua: string;
}
interface KickLog {
  at: number;
  username: string;
  kickedDevice: string;
  kickerDevice: string;
  kickerIp: string;
}
interface UserRow {
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
  devices: DeviceInfo[];
}
interface OverviewData {
  ok: boolean;
  generatedAt: number;
  users: UserRow[];
  sessions: SessionInfo[];
  devices: DeviceInfo[];
  kicks: KickLog[];
  summary: {
    totalUsers: number;
    onlineUsers: number;
    totalSessions: number;
    totalDevices: number;
    totalPlays: number;
    totalSearches: number;
  };
}
interface UpgradeInfo {
  ok: boolean;
  currentVersion: string;
  latestVersion: string | null;
  hasUpdate: boolean;
  webhookConfigured: boolean;
  message: string;
}

function fmtTime(ts: number | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString('zh-CN', { hour12: false });
}
function fmtAgo(ts: number): string {
  if (!ts || ts <= 0) return '—';
  const diff = Date.now() - ts;
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 3600 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}
function roleLabel(role: string): string {
  return role === 'owner' ? '站长' : role === 'admin' ? '管理员' : '用户';
}
function deviceIcon(name: string) {
  if (/iOS|iPhone|iPad/i.test(name)) return <Smartphone size={15} />;
  if (/Android/i.test(name)) return <Smartphone size={15} />;
  if (/电视|TV|盒子/i.test(name)) return <Tv size={15} />;
  if (/Windows|macOS|Linux/i.test(name)) return <Monitor size={15} />;
  return <Laptop size={15} />;
}

function StatCard({
  icon,
  label,
  value,
  color,
}: {
  icon: ReactNode;
  label: string;
  value: number | string;
  color: string;
}) {
  return (
    <div className='p-4 bg-gray-100/50 dark:bg-gray-800/30 border border-gray-200/60 dark:border-white/5 rounded-2xl flex items-center gap-3'>
      <div className={`p-2.5 rounded-xl ${color}`}>{icon}</div>
      <div>
        <div className='text-2xl font-bold text-gray-900 dark:text-white leading-none'>
          {value}
        </div>
        <div className='text-xs text-gray-500 dark:text-gray-400 mt-1'>
          {label}
        </div>
      </div>
    </div>
  );
}

export default function OwnerSection() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [upgrade, setUpgrade] = useState<UpgradeInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const [upgradeMsg, setUpgradeMsg] = useState<string | null>(null);
  const [tab, setTab] = useState<'users' | 'sessions' | 'devices' | 'kicks'>(
    'users',
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch('/api/admin/owner/overview', {
        cache: 'no-store',
      });
      const json = await resp.json();
      if (!resp.ok || !json.ok) throw new Error(json.error || '加载失败');
      setData(json as OverviewData);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  const checkUpgrade = useCallback(async () => {
    try {
      const resp = await fetch('/api/admin/upgrade', { cache: 'no-store' });
      const json = await resp.json();
      setUpgrade(json);
    } catch (e) {
      setUpgrade({
        ok: false,
        currentVersion: '',
        latestVersion: null,
        hasUpdate: false,
        webhookConfigured: false,
        message: e instanceof Error ? e.message : '检测失败',
      });
    }
  }, []);

  useEffect(() => {
    load();
    checkUpgrade();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, []);

  const doUpgrade = async () => {
    if (!upgrade?.latestVersion) return;
    if (
      !window.confirm(
        `确认升级到 v${upgrade.latestVersion}？\n升级期间服务会短暂重启，请确保在 1-3 分钟后刷新页面。`,
      )
    ) {
      return;
    }
    setUpgrading(true);
    setUpgradeMsg(null);
    try {
      const resp = await fetch('/api/admin/upgrade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: upgrade.latestVersion }),
      });
      const json = await resp.json();
      if (!resp.ok || !json.ok) throw new Error(json.error || '升级失败');
      setUpgradeMsg(json.message);
    } catch (e) {
      setUpgradeMsg(e instanceof Error ? `升级失败：${e.message}` : '升级失败');
    } finally {
      setUpgrading(false);
    }
  };

  if (loading && !data) {
    return (
      <div className='p-8 text-center text-gray-500 dark:text-gray-400'>
        正在加载站点数据…
      </div>
    );
  }
  if (error && !data) {
    return (
      <div className='p-6'>
        <div className='p-4 rounded-xl bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400'>
          {error}
        </div>
      </div>
    );
  }
  if (!data) return null;

  const s = data.summary;

  return (
    <div className='space-y-8'>
      {/* 概览卡片 */}
      <div className='grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3'>
        <StatCard
          icon={<Users size={18} />}
          label='总用户数'
          value={s.totalUsers}
          color='bg-blue-500/10 text-blue-500'
        />
        <StatCard
          icon={<Wifi size={18} />}
          label='在线用户'
          value={s.onlineUsers}
          color='bg-green-500/10 text-green-500'
        />
        <StatCard
          icon={<Activity size={18} />}
          label='活跃会话'
          value={s.totalSessions}
          color='bg-purple-500/10 text-purple-500'
        />
        <StatCard
          icon={<Laptop size={18} />}
          label='识别终端'
          value={s.totalDevices}
          color='bg-orange-500/10 text-orange-500'
        />
        <StatCard
          icon={<Monitor size={18} />}
          label='播放记录'
          value={s.totalPlays}
          color='bg-cyan-500/10 text-cyan-500'
        />
        <StatCard
          icon={<Search size={18} />}
          label='搜索记录'
          value={s.totalSearches}
          color='bg-pink-500/10 text-pink-500'
        />
      </div>

      {/* 在线升级 */}
      <div className='p-5 bg-linear-to-r from-yellow-50 to-orange-50 dark:from-yellow-900/10 dark:to-orange-900/10 border border-yellow-200/60 dark:border-yellow-700/30 rounded-2xl'>
        <div className='flex items-center gap-2 mb-3'>
          <ArrowUpCircle className='text-orange-500' size={20} />
          <h3 className='font-semibold text-gray-900 dark:text-white'>
            在线升级
          </h3>
          <span className='text-xs px-2 py-0.5 rounded-full bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300'>
            当前 v{upgrade?.currentVersion || '—'}
          </span>
        </div>
        {upgrade && (
          <div className='flex flex-wrap items-center gap-3'>
            <span
              className={`text-sm ${
                upgrade.hasUpdate
                  ? 'text-orange-600 dark:text-orange-400 font-medium'
                  : 'text-gray-600 dark:text-gray-300'
              }`}
            >
              {upgrade.message}
            </span>
            <button
              onClick={checkUpgrade}
              disabled={loading}
              className={`${styles.secondary} inline-flex items-center gap-1.5`}
            >
              <RefreshCw size={14} /> 重新检测
            </button>
            {upgrade.hasUpdate && upgrade.webhookConfigured && (
              <button
                onClick={doUpgrade}
                disabled={upgrading}
                className={`${
                  upgrading ? styles.disabled : styles.primary
                } inline-flex items-center gap-1.5`}
              >
                <Download size={14} />
                {upgrading ? '提交中…' : `升级到 v${upgrade.latestVersion}`}
              </button>
            )}
            {upgrade.hasUpdate && !upgrade.webhookConfigured && (
              <span className='text-xs text-red-500 flex items-center gap-1'>
                <AlertTriangle size={14} /> 未配置升级 webhook，请先在 compose 中配置
              </span>
            )}
          </div>
        )}
        {upgradeMsg && (
          <div className='mt-3 text-sm p-3 rounded-lg bg-white/70 dark:bg-gray-800/60 text-gray-700 dark:text-gray-200'>
            {upgradeMsg}
          </div>
        )}
      </div>

      {/* 子标签 */}
      <div className='flex gap-2 flex-wrap'>
        {(
          [
            ['users', '用户活动'],
            ['sessions', `活跃会话 (${data.sessions.length})`],
            ['devices', `终端列表 (${data.devices.length})`],
            ['kicks', `互踢痕迹 (${data.kicks.length})`],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
              tab === id
                ? 'bg-primary-600 text-white shadow'
                : 'bg-gray-200/60 dark:bg-gray-700/50 text-gray-600 dark:text-gray-300 hover:bg-gray-300/60 dark:hover:bg-gray-700'
            }`}
          >
            {label}
          </button>
        ))}
        <button
          onClick={load}
          disabled={loading}
          className='ml-auto px-3 py-2 rounded-xl text-sm bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 inline-flex items-center gap-1.5'
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> 刷新
        </button>
      </div>

      {/* 用户活动表 */}
      {tab === 'users' && (
        <div className='overflow-x-auto rounded-2xl border border-gray-200/60 dark:border-white/5'>
          <table className='w-full text-sm'>
            <thead className='bg-gray-100/70 dark:bg-gray-800/40 text-gray-600 dark:text-gray-300'>
              <tr>
                <th className='text-left px-4 py-3 font-medium'>用户</th>
                <th className='text-left px-4 py-3 font-medium'>角色/状态</th>
                <th className='text-center px-4 py-3 font-medium'>在线</th>
                <th className='text-center px-4 py-3 font-medium'>活跃终端</th>
                <th className='text-center px-4 py-3 font-medium'>累计终端</th>
                <th className='text-center px-4 py-3 font-medium'>播放</th>
                <th className='text-center px-4 py-3 font-medium'>最近播放</th>
                <th className='text-center px-4 py-3 font-medium'>搜索</th>
              </tr>
            </thead>
            <tbody className='divide-y divide-gray-100 dark:divide-white/5'>
              {data.users.map((u) => (
                <tr
                  key={u.username}
                  className='hover:bg-gray-50/60 dark:hover:bg-white/5'
                >
                  <td className='px-4 py-3 font-medium text-gray-900 dark:text-white'>
                    {u.username}
                  </td>
                  <td className='px-4 py-3 text-gray-500 dark:text-gray-400'>
                    <span className='px-2 py-0.5 rounded-full bg-gray-200/70 dark:bg-gray-700 text-xs'>
                      {roleLabel(u.role)}
                    </span>
                    {u.banned && (
                      <span className='ml-1 px-2 py-0.5 rounded-full bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 text-xs'>
                        已封禁
                      </span>
                    )}
                  </td>
                  <td className='px-4 py-3 text-center'>
                    {u.online ? (
                      <Wifi className='inline text-green-500' size={16} />
                    ) : (
                      <WifiOff className='inline text-gray-400' size={16} />
                    )}
                  </td>
                  <td className='px-4 py-3 text-center font-semibold text-primary-600 dark:text-primary-400'>
                    {u.activeSessions}
                  </td>
                  <td className='px-4 py-3 text-center text-gray-700 dark:text-gray-300'>
                    {u.deviceCount}
                  </td>
                  <td className='px-4 py-3 text-center text-gray-700 dark:text-gray-300'>
                    {u.playCount}
                  </td>
                  <td className='px-4 py-3 text-center text-xs text-gray-500 dark:text-gray-400'>
                    {fmtAgo(u.lastPlayAt || 0)}
                  </td>
                  <td className='px-4 py-3 text-center text-gray-700 dark:text-gray-300'>
                    {u.searchCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 活跃会话 */}
      {tab === 'sessions' && (
        <div className='overflow-x-auto rounded-2xl border border-gray-200/60 dark:border-white/5'>
          <table className='w-full text-sm'>
            <thead className='bg-gray-100/70 dark:bg-gray-800/40 text-gray-600 dark:text-gray-300'>
              <tr>
                <th className='text-left px-4 py-3 font-medium'>用户</th>
                <th className='text-left px-4 py-3 font-medium'>设备</th>
                <th className='text-left px-4 py-3 font-medium'>IP</th>
                <th className='text-left px-4 py-3 font-medium'>登录时间</th>
                <th className='text-left px-4 py-3 font-medium'>最后活跃</th>
                <th className='text-center px-4 py-3 font-medium'>状态</th>
              </tr>
            </thead>
            <tbody className='divide-y divide-gray-100 dark:divide-white/5'>
              {data.sessions.map((sess) => {
                const online =
                  data.generatedAt - sess.lastActive < ONLINE_WINDOW;
                return (
                  <tr
                    key={sess.sid}
                    className='hover:bg-gray-50/60 dark:hover:bg-white/5'
                  >
                    <td className='px-4 py-3 font-medium text-gray-900 dark:text-white'>
                      {sess.username}
                      <span className='ml-1 text-xs text-gray-400'>
                        ({roleLabel(sess.role)})
                      </span>
                    </td>
                    <td className='px-4 py-3 text-gray-600 dark:text-gray-300'>
                      <span className='inline-flex items-center gap-1.5'>
                        {deviceIcon(sess.deviceName)} {sess.deviceName}
                      </span>
                    </td>
                    <td className='px-4 py-3 font-mono text-xs text-gray-500 dark:text-gray-400'>
                      {sess.ip || '—'}
                    </td>
                    <td className='px-4 py-3 text-xs text-gray-500 dark:text-gray-400'>
                      {fmtTime(sess.loginAt)}
                    </td>
                    <td className='px-4 py-3 text-xs text-gray-500 dark:text-gray-400'>
                      {fmtAgo(sess.lastActive)}
                    </td>
                    <td className='px-4 py-3 text-center'>
                      <span
                        className={`px-2 py-0.5 rounded-full text-xs ${
                          online
                            ? 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400'
                            : 'bg-gray-200 dark:bg-gray-700 text-gray-500'
                        }`}
                      >
                        {online ? '在线' : '离线'}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {data.sessions.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className='px-4 py-8 text-center text-gray-400'
                  >
                    暂无活跃会话
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* 终端列表 */}
      {tab === 'devices' && (
        <div className='overflow-x-auto rounded-2xl border border-gray-200/60 dark:border-white/5'>
          <table className='w-full text-sm'>
            <thead className='bg-gray-100/70 dark:bg-gray-800/40 text-gray-600 dark:text-gray-300'>
              <tr>
                <th className='text-left px-4 py-3 font-medium'>设备</th>
                <th className='text-left px-4 py-3 font-medium'>所属用户</th>
                <th className='text-center px-4 py-3 font-medium'>登录次数</th>
                <th className='text-left px-4 py-3 font-medium'>首次出现</th>
                <th className='text-left px-4 py-3 font-medium'>最近出现</th>
              </tr>
            </thead>
            <tbody className='divide-y divide-gray-100 dark:divide-white/5'>
              {data.devices.map((dev) => (
                <tr
                  key={dev.deviceId}
                  className='hover:bg-gray-50/60 dark:hover:bg-white/5'
                >
                  <td className='px-4 py-3 text-gray-800 dark:text-gray-200'>
                    <span className='inline-flex items-center gap-1.5'>
                      {deviceIcon(dev.deviceName)} {dev.deviceName}
                    </span>
                    <div className='text-xs font-mono text-gray-400 mt-0.5'>
                      {dev.deviceId.slice(0, 12)}…
                    </div>
                  </td>
                  <td className='px-4 py-3 font-medium text-gray-900 dark:text-white'>
                    {dev.username}
                  </td>
                  <td className='px-4 py-3 text-center text-gray-700 dark:text-gray-300'>
                    {dev.loginCount}
                  </td>
                  <td className='px-4 py-3 text-xs text-gray-500 dark:text-gray-400'>
                    {fmtTime(dev.firstSeen)}
                  </td>
                  <td className='px-4 py-3 text-xs text-gray-500 dark:text-gray-400'>
                    {fmtAgo(dev.lastSeen)}
                  </td>
                </tr>
              ))}
              {data.devices.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className='px-4 py-8 text-center text-gray-400'
                  >
                    暂无终端记录（用户重新登录后开始识别）
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* 互踢痕迹 */}
      {tab === 'kicks' && (
        <div className='overflow-x-auto rounded-2xl border border-gray-200/60 dark:border-white/5'>
          <table className='w-full text-sm'>
            <thead className='bg-gray-100/70 dark:bg-gray-800/40 text-gray-600 dark:text-gray-300'>
              <tr>
                <th className='text-left px-4 py-3 font-medium'>时间</th>
                <th className='text-left px-4 py-3 font-medium'>用户</th>
                <th className='text-left px-4 py-3 font-medium'>被顶下线的设备</th>
                <th className='text-left px-4 py-3 font-medium'>新登录设备</th>
                <th className='text-left px-4 py-3 font-medium'>来源 IP</th>
              </tr>
            </thead>
            <tbody className='divide-y divide-gray-100 dark:divide-white/5'>
              {data.kicks.map((k, i) => (
                <tr
                  key={`${k.at}-${i}`}
                  className='hover:bg-gray-50/60 dark:hover:bg-white/5'
                >
                  <td className='px-4 py-3 text-xs text-gray-500 dark:text-gray-400'>
                    {fmtTime(k.at)}
                  </td>
                  <td className='px-4 py-3 font-medium text-gray-900 dark:text-white'>
                    {k.username}
                  </td>
                  <td className='px-4 py-3 text-gray-500 dark:text-gray-400'>
                    {k.kickedDevice}
                  </td>
                  <td className='px-4 py-3 text-gray-800 dark:text-gray-200'>
                    {k.kickerDevice}
                  </td>
                  <td className='px-4 py-3 font-mono text-xs text-gray-500 dark:text-gray-400'>
                    {k.kickerIp || '—'}
                  </td>
                </tr>
              ))}
              {data.kicks.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className='px-4 py-8 text-center text-gray-400'
                  >
                    暂无互踢记录
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className='text-xs text-gray-400 flex items-center gap-1.5'>
        <Clock size={13} /> 数据更新于 {fmtTime(data.generatedAt)}
        <span className='ml-2'>
          互踢模式：同一账号仅保留一个 Web 会话；TVBox/API 接入不受影响。
        </span>
      </div>
    </div>
  );
}
