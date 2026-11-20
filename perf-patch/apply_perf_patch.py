#!/usr/bin/env python3
"""播放性能优化补丁：并发池测速 + 缩短超时 + 去掉人为延迟。

用精确文本替换而非整文件覆盖，避免与官方后续源码改动冲突。
幂等：已打过则跳过。用法: python3 apply_perf_patch.py <源码根目录>
"""
import sys
import os

SRC = sys.argv[1] if len(sys.argv) > 1 else '.'
PLAY = os.path.join(SRC, 'src/app/play/PlayPageClient.tsx')
UTILS = os.path.join(SRC, 'src/lib/utils.ts')

MARK = '[PERF-PATCH]'


def read(p):
    with open(p, 'r', encoding='utf-8') as f:
        return f.read()


def write(p, s):
    with open(p, 'w', encoding='utf-8') as f:
        f.write(s)


def apply(path, old, new, label):
    s = read(path)
    if MARK in s and new in s:
        print(f'  [skip] {label}（已应用）')
        return
    if old not in s:
        print(f'  [FAIL] {label}：找不到锚点', file=sys.stderr)
        sys.exit(1)
    s = s.replace(old, new, 1)
    write(path, s)
    print(f'  [ok] {label}')


# ---------- 1) 两批串行 -> 并发池（上限5，allSettled） ----------
OLD_POOL = """    // 将播放源均分为两批，并发测速各批，避免一次性过多请求
    const batchSize = Math.ceil(sources.length / 2);
    const allResults: Array<{
      source: SearchResult;
      testResult: { quality: string; loadSpeed: string; pingTime: number };
    } | null> = [];

    for (let start = 0; start < sources.length; start += batchSize) {
      const batchSources = sources.slice(start, start + batchSize);
      const batchResults = await Promise.all(
        batchSources.map(async (source) => {
          try {
            // 检查是否有第一集的播放地址
            if (!source.episodes || source.episodes.length === 0) {
              console.warn(`播放源 ${source.source_name} 没有可用的播放地址`);
              return null;
            }

            const episodeUrl =
              source.episodes.length > 1
                ? source.episodes[1]
                : source.episodes[0];
            const testResult = await getVideoResolutionFromM3u8(episodeUrl);

            return {
              source,
              testResult,
            };
          } catch (error) {
            return null;
          }
        }),
      );
      allResults.push(...batchResults);
    }
"""

NEW_POOL = """    // [PERF-PATCH] 并发池测速：同时最多 5 个源，完成一个补一个。
    // 相比"均分两批串行"耗时近乎减半；上限 5 避免瞬时请求过多冲击采集站/浏览器。
    // 用 allSettled 保证单个源异常不影响其余源；结果按原索引写回，保持与 sources 顺序一致。
    const MAX_CONCURRENCY = 5;
    const allResults: Array<{
      source: SearchResult;
      testResult: { quality: string; loadSpeed: string; pingTime: number };
    } | null> = new Array(sources.length).fill(null);

    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(MAX_CONCURRENCY, sources.length) },
      async () => {
        while (true) {
          const idx = nextIndex++;
          if (idx >= sources.length) break;
          const source = sources[idx];
          try {
            if (!source.episodes || source.episodes.length === 0) {
              console.warn(`播放源 ${source.source_name} 没有可用的播放地址`);
              continue;
            }
            const episodeUrl =
              source.episodes.length > 1
                ? source.episodes[1]
                : source.episodes[0];
            const testResult = await getVideoResolutionFromM3u8(episodeUrl);
            allResults[idx] = { source, testResult };
          } catch (error) {
            allResults[idx] = null;
          }
        }
      },
    );
    await Promise.allSettled(workers);
"""

# ---------- 2) 去掉结尾 1000ms 人为延迟 ----------
OLD_DELAY = """      // 短暂延迟让用户看到完成状态
      setTimeout(() => {
        setLoading(false);
      }, 1000);
"""
NEW_DELAY = """      // [PERF-PATCH] 去掉原来 1 秒人为延迟：状态已是 ready，直接放行播放
      setLoading(false);
"""

# ---------- 3) 测速超时 4000 -> 2500，且超时用已采集信息返回而非丢弃源 ----------
OLD_TIMEOUT = """      // 设置超时处理
      const timeout = setTimeout(() => {
        hls.destroy();
        video.remove();
        reject(new Error('Timeout loading video metadata'));
      }, 4000);
"""
NEW_TIMEOUT = """      // [PERF-PATCH] 超时 4000→2500ms；到时用已采集到的信息直接返回，
      // 不再 reject 丢弃该源（原来慢源既干等 4 秒又白丢，拖长优选等待）
      const timeout = setTimeout(() => {
        clearTimeout(timeout);
        const width = video.videoWidth;
        const quality =
          width >= 3840 ? '4K'
            : width >= 2560 ? '2K'
              : width >= 1920 ? '1080p'
                : width >= 1280 ? '720p'
                  : width >= 854 ? '480p'
                    : 'SD';
        try { hls.destroy(); } catch { /* ignore */ }
        try { video.remove(); } catch { /* ignore */ }
        resolve({
          quality: width > 0 ? quality : '未知',
          loadSpeed: actualLoadSpeed,
          pingTime: Math.round(pingTime),
        });
      }, 2500);
"""

print('[perf] 应用播放性能优化补丁')
for path in (PLAY, UTILS):
    if not os.path.isfile(path):
        print(f'[FAIL] 找不到文件: {path}', file=sys.stderr)
        sys.exit(1)

apply(PLAY, OLD_POOL, NEW_POOL, '并发池测速（两批串行→上限5并发）')
apply(PLAY, OLD_DELAY, NEW_DELAY, '去掉结尾 1s 人为延迟')
apply(UTILS, OLD_TIMEOUT, NEW_TIMEOUT, '测速超时 4s→2.5s 且超时返回而非丢弃')

# 校验
p = read(PLAY)
u = read(UTILS)
assert 'MAX_CONCURRENCY = 5' in p and 'Promise.allSettled(workers)' in p, '并发池校验失败'
assert 'setLoading(false);' in p, 'loading 校验失败'
assert '}, 2500);' in u and 'quality: width > 0 ? quality' in u, '超时校验失败'
print('[perf] 校验通过：并发池 + 去延迟 + 缩短超时 全部就位')
