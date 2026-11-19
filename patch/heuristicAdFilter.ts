/**
 * 文本层三层广告启发式过滤
 *
 * 移植自 LibreSpark/LibreTV 的 src/lib/m3u8.ts（stripAdGroups 及其辅助函数）。
 * MIT/AGPL 项目原样移植，仅做模块化与类型整理，判定逻辑与阈值完全保留。
 *
 * 为什么要在 LabTV 的 PCR 之外再加这一层：
 *   - PCR 方案靠 "TS 分片时钟断裂" 识别广告，对 "与正片同构、时钟连续" 的
 *     中插广告（典型如澳门赌场类）会漏判；
 *   - 本模块只看 m3u8 文本特征（URL 路径 / 段时长 / 段位置），零网络请求、
 *     零探测延迟，恰好覆盖 PCR 的盲区；
 *   - 三者按可靠度串联：URL 特征 > 两长夹一短时长 > 片头短段。
 *
 * 本文件是纯函数模块，不依赖 hls.js / React，可直接放进 src/lib/ 使用。
 */

/** 片头广告段判定上限（秒 / 分片数） */
const LEAD_AD_MAX_SECONDS = 90;
const LEAD_AD_MAX_SEGMENTS = 20;

/** 广告分片 URL 特征：adjump=ad jump，暴风等采集云把中插广告放在这类路径里 */
const AD_URL_PATTERN = /adjump|advert|\/ads?\//i;

/** 中插广告时长阈值：段 <= 30s，且前后邻段都 >= 120s（两长夹一短） */
const INTERSTITIAL_MAX_SECONDS = 30;
const INTERSTITIAL_NEIGHBOR_MIN_SECONDS = 120;

const LINE_BREAK = /\r\n|\n|\r/;
const ENDLIST = '#EXT-X-ENDLIST';

const isDisc = (l: string) => l.trim() === '#EXT-X-DISCONTINUITY';
const isSegment = (l: string) => {
  const t = l.trim();
  return t !== '' && !t.startsWith('#');
};

function looksLikeAdUrl(line: string): boolean {
  return AD_URL_PATTERN.test(line.trim());
}

interface AdGroupScan {
  start: number;
  end: number;
  /** 组前 DISCONTINUITY 行下标（首组为 -1） */
  discLine: number;
  seconds: number;
  count: number;
}

/** 按 DISCONTINUITY 把播放列表切成组 */
function scanGroups(lines: string[]): AdGroupScan[] {
  const discIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) if (isDisc(lines[i])) discIdx.push(i);

  const groups: AdGroupScan[] = [];
  const bounds = [0, ...discIdx, lines.length];
  for (let k = 0; k < bounds.length - 1; k++) {
    const start = k === 0 ? 0 : bounds[k] + 1;
    const end = bounds[k + 1];
    let seconds = 0;
    let count = 0;
    for (let i = start; i < end; i++) {
      const m = lines[i].trim().match(/^#EXTINF:([\d.]+)/);
      if (m) seconds += parseFloat(m[1]) || 0;
      else if (isSegment(lines[i])) count += 1;
    }
    groups.push({ start, end, discLine: k === 0 ? -1 : bounds[k], seconds, count });
  }
  return groups;
}

/**
 * 第 1 层：按 URL 特征剔除任意位置的 DISCONTINUITY 广告段（片头/中插均覆盖）。
 * 保守判定：段内全部分片都命中广告 URL 特征才整段剔除，混入一个正片分片就放过。
 */
function stripMarkedAdGroups(m3u8Content: string): string {
  if (!m3u8Content) return '';
  const lines = m3u8Content.split(LINE_BREAK);
  const drop = new Array<boolean>(lines.length).fill(false);
  let i = 0;
  while (i < lines.length) {
    if (!isDisc(lines[i])) {
      i += 1;
      continue;
    }
    let j = i + 1;
    let count = 0;
    let allAd = true;
    while (j < lines.length && !isDisc(lines[j])) {
      if (isSegment(lines[j])) {
        count += 1;
        if (!looksLikeAdUrl(lines[j])) allAd = false;
      }
      j += 1;
    }
    if (count > 0 && allAd) {
      drop[i] = true;
      for (let k = i + 1; k < j; k++) {
        const t = lines[k].trim();
        if (t.startsWith('#EXT-X-KEY') || t.startsWith('#EXT-X-MAP')) continue;
        drop[k] = true;
      }
    }
    i = j;
  }
  if (!drop.some(Boolean)) return m3u8Content;
  return lines.filter((_, idx) => !drop[idx]).join('\n');
}

/**
 * 第 2 层：剔除 "长正片段之间的超短插入段"（URL 无特征的纯时长型中插广告）。
 * 判定：段时长 <= 30s，且前后邻段时长都 >= 120s；基于原始分组一次性评估，不级联。
 * 首组交给第 3 层处理，本函数只看 k >= 1 的组。
 */
function stripInterstitialAdGroups(m3u8Content: string): string {
  if (!m3u8Content) return '';
  const lines = m3u8Content.split(LINE_BREAK);
  const groups = scanGroups(lines);
  const drop = new Array<boolean>(lines.length).fill(false);
  for (let k = 1; k < groups.length; k++) {
    const g = groups[k];
    const prev = groups[k - 1];
    const next = groups[k + 1];
    if (g.count === 0 || g.discLine < 0) continue;
    if (g.seconds <= 0 || g.seconds > INTERSTITIAL_MAX_SECONDS) continue;
    if (!prev || prev.seconds < INTERSTITIAL_NEIGHBOR_MIN_SECONDS) continue;
    if (!next || next.seconds < INTERSTITIAL_NEIGHBOR_MIN_SECONDS) continue;
    drop[g.discLine] = true;
    for (let i = g.start; i < g.end; i++) {
      const t = lines[i].trim();
      if (t.startsWith('#EXT-X-KEY') || t.startsWith('#EXT-X-MAP')) continue;
      drop[i] = true;
    }
  }
  if (!drop.some(Boolean)) return m3u8Content;
  return lines.filter((_, idx) => !drop[idx]).join('\n');
}

/**
 * 第 3 层：剔除 m3u8 片头插入的广告段（整段移除分片，不删 DISCONTINUITY 标记）。
 * 保守判定（全部满足才剔除）：
 *   0. 多分组封装下片头组与其余组同构时跳过（避免误杀正常分块）；
 *   1. 首个分片之前存在 DISCONTINUITY；
 *   2. 该段以下一个 DISCONTINUITY 结束，且其后仍有分段；
 *   3. 段时长 <= 90s 且分片数 <= 20。
 */
function stripLeadAdGroup(m3u8Content: string): string {
  if (!m3u8Content) return '';
  const lines = m3u8Content.split(LINE_BREAK);
  const discIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) if (isDisc(lines[i])) discIdx.push(i);

  if (discIdx.length >= 4) {
    const groupSize = (from: number, to: number) => {
      let seg = 0;
      for (let k = from; k < to; k++) if (isSegment(lines[k])) seg += 1;
      return seg;
    };
    const leadSize = groupSize(discIdx[0] + 1, discIdx[1]);
    const others: number[] = [];
    for (let g = 1; g < discIdx.length; g++) {
      others.push(groupSize(discIdx[g] + 1, g + 1 < discIdx.length ? discIdx[g + 1] : lines.length));
    }
    const sorted = [...others].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const typical = Math.abs(leadSize - median) <= Math.max(3, median * 0.5);
    if (typical) return m3u8Content;
  }

  const firstDisc = discIdx[0];
  if (firstDisc === undefined) return m3u8Content;
  if (lines.slice(0, firstDisc).some(isSegment)) return m3u8Content;

  const nextDisc = discIdx.slice(1).find((i) => i > firstDisc);
  if (nextDisc === undefined) return m3u8Content;

  let seconds = 0;
  let count = 0;
  for (let i = firstDisc + 1; i < nextDisc; i++) {
    const m = lines[i].trim().match(/^#EXTINF:([\d.]+)/);
    if (m) seconds += parseFloat(m[1]) || 0;
    else if (isSegment(lines[i])) count += 1;
  }
  if (count === 0 || count > LEAD_AD_MAX_SEGMENTS) return m3u8Content;
  if (seconds <= 0 || seconds > LEAD_AD_MAX_SECONDS) return m3u8Content;

  const kept = lines.filter((l, i) => {
    if (i < firstDisc || i >= nextDisc) return true;
    const t = l.trim();
    return t.startsWith('#EXT-X-KEY') || t.startsWith('#EXT-X-MAP');
  });
  const out: string[] = [];
  let seenSegment = false;
  for (const l of kept) {
    if (!seenSegment && isDisc(l)) continue;
    if (isSegment(l)) seenSegment = true;
    out.push(l);
  }
  return out.join('\n');
}

/** 主域占比下限：低于此值说明是多 CDN 均衡的正规流，不启用异域判定 */
const MAIN_DOMAIN_MIN_RATIO = 0.7;
/** 广告域名分片占比上限：超过此值怕误判，放弃（广告应是极少数） */
const FOREIGN_MAX_RATIO = 0.25;
/** 判定异域广告至少需要的主域分组数，避免短列表误伤 */
const MIN_MAIN_GROUPS = 5;

/** 从分片 URL 取 host（不含端口差异：去掉 :port 统一比较） */
function hostOf(url: string): string {
  const m = url.trim().match(/^https?:\/\/([^/]+)/i);
  if (!m) return '';
  return m[1].replace(/:\d+$/, '').toLowerCase();
}

/**
 * 第 4 层（本增强新增，最可靠）：剔除「独立域名承载」的广告组。
 *
 * 实测证据（魔都资源 mdzy / play.modujx11.com）：
 *   正片分片 100% 来自 bf.modujx11.com（占 96.6%），
 *   中插赌场广告 100% 来自 bf.modujx15.com（占 3.4%，每集 27-45 片），
 *   且广告分片总是独占一个 DISCONTINUITY 分组、从不与正片分片混在同组。
 *   URL 里没有 adjump/advert 关键词，时长也与正片同构（2s/片），
 *   所以原三层启发式与 PCR 时钟检测全部漏判——只有域名是可靠特征。
 *
 * 判定（全部满足才删某组，保守防误伤）：
 *   1. 全列表存在唯一主域，占比 >= 70%（多 CDN 均衡流 rarely 这么集中）；
 *   2. 异域分片总占比 <= 25%（广告是极少数）；
 *   3. 主域分组数 >= 5（列表足够长）；
 *   4. 某 DISCONTINUITY 组内 0 个主域分片（纯异域组）→ 判为广告，整组删除。
 * 保留 #EXT-X-KEY / #EXT-X-MAP 行以免破坏解密上下文。
 */
function stripForeignDomainAdGroups(m3u8Content: string): string {
  if (!m3u8Content) return '';
  const lines = m3u8Content.split(LINE_BREAK);

  // 按 DISCONTINUITY 切组，记录每组的分片行下标与 host
  const groups: Array<{ segIdx: number[]; hosts: string[] }> = [];
  let cur: { segIdx: number[]; hosts: string[] } = { segIdx: [], hosts: [] };
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (isDisc(lines[i])) {
      groups.push(cur);
      cur = { segIdx: [], hosts: [] };
    } else if (isSegment(lines[i])) {
      cur.segIdx.push(i);
      cur.hosts.push(hostOf(t));
    }
  }
  groups.push(cur);

  const hostCount = new Map<string, number>();
  let total = 0;
  for (const g of groups) {
    for (const h of g.hosts) {
      if (!h) continue;
      total += 1;
      hostCount.set(h, (hostCount.get(h) || 0) + 1);
    }
  }
  if (total < MIN_SEGMENTS_FOR_FOREIGN) return m3u8Content;

  let mainHost = '';
  let mainCount = 0;
  for (const [h, n] of hostCount) {
    if (n > mainCount) {
      mainCount = n;
      mainHost = h;
    }
  }
  if (!mainHost || mainCount / total < MAIN_DOMAIN_MIN_RATIO) return m3u8Content;
  if ((total - mainCount) / total > FOREIGN_MAX_RATIO) return m3u8Content;

  const mainGroups = groups.filter(
    (g) => g.hosts.length > 0 && g.hosts.some((h) => h === mainHost),
  );
  if (mainGroups.length < MIN_MAIN_GROUPS) return m3u8Content;

  // 删除纯异域组：组内分片全部非主域（含 host 为空的相对分片则放过，避免误伤）
  const drop = new Array<boolean>(lines.length).fill(false);
  let dropped = 0;
  for (const g of groups) {
    if (g.segIdx.length === 0) continue;
    if (g.hosts.some((h) => h === mainHost || h === '')) continue;
    // 该组所有分片都是同一个异域 host 才删，进一步降低误伤
    const first = g.hosts[0];
    if (!g.hosts.every((h) => h === first)) continue;
    for (const idx of g.segIdx) {
      drop[idx] = true;
      // 连带删除紧邻的 EXTINF
      if (idx - 1 >= 0 && lines[idx - 1].trim().startsWith('#EXTINF')) drop[idx - 1] = true;
      dropped += 1;
    }
  }
  if (dropped === 0) return m3u8Content;
  return lines.filter((_, i) => !drop[i]).join('\n');
}

/** 异域检测要求的最小分片数（太短的列表不启用） */
const MIN_SEGMENTS_FOR_FOREIGN = 60;

/** 清除首个分片之前的 DISCONTINUITY：其前无媒体内容，标记无语义 */
function stripLeadingDisc(content: string): string {
  const lines = content.split(LINE_BREAK);
  const firstSeg = lines.findIndex((l) => {
    const t = l.trim();
    return t !== '' && !t.startsWith('#');
  });
  if (firstSeg <= 0) return content;
  const kept = lines.filter((l, i) => !(i < firstSeg && l.trim() === '#EXT-X-DISCONTINUITY'));
  return kept.length === lines.length ? content : kept.join('\n');
}

/**
 * 广告过滤总入口（纯文本，零网络请求）。
 * 按可靠度由内到外依次执行：
 *   异域域名组（最可靠，实测赌场广告） → URL 特征 → 时长夹击 → 片头短段 → 清理首尾标记。
 */
export function stripAdGroups(m3u8Content: string): string {
  if (!m3u8Content) return '';
  const noForeign = stripForeignDomainAdGroups(m3u8Content);
  return stripLeadingDisc(
    stripLeadAdGroup(stripInterstitialAdGroups(stripMarkedAdGroups(noForeign))),
  );
}

export interface HeuristicResult {
  main: string;
  /** 被移除广告分片拼成的可核对 m3u8（绝对地址），无命中时为空 */
  ads: string;
  /** 被移除的分片数 */
  adCount: number;
  /** 被移除的广告段（break）数 */
  adBreaks: number;
  /** 被移除分片的绝对 URL，供后端缓存复用 */
  adUrls: string[];
  removed: boolean;
}

function resolveUrl(baseUrl: string, url: string): string {
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return url;
  }
}

const noChange = (text: string): HeuristicResult => ({
  main: text,
  ads: '',
  adCount: 0,
  adBreaks: 0,
  adUrls: [],
  removed: false,
});

/**
 * 带报告版的过滤入口。
 *
 * 在 stripAdGroups 的基础上，用双指针把过滤结果映射回原文行，从而定位
 * "哪些行被删了"，产出 adUrls / adBreaks / ads，供 LabTV 的 UI 提示与
 * 后端缓存（applyAdUrls）复用。判定逻辑与 stripAdGroups 完全一致。
 */
export function stripAdGroupsWithReport(m3u8Content: string, baseUrl: string): HeuristicResult {
  if (!m3u8Content) return noChange('');
  const main = stripAdGroups(m3u8Content);
  if (main === m3u8Content) return noChange(m3u8Content);

  const origLines = m3u8Content.split(LINE_BREAK);
  const mainLines = main.split(LINE_BREAK);

  // main 是原文行的保序子序列，双指针标记哪些原文行被保留
  const removedIdx: number[] = [];
  let j = 0;
  for (let i = 0; i < origLines.length; i++) {
    if (j < mainLines.length && origLines[i] === mainLines[j]) {
      j++;
    } else {
      removedIdx.push(i);
    }
  }
  if (removedIdx.length === 0) return noChange(m3u8Content);

  const removedSet = new Set(removedIdx);
  const adUrls: string[] = [];
  const adLines: string[] = ['#EXTM3U'];

  // 统计广告分片被分成了几段：删除的分片之间若隔着保留分片，则算新的一段
  let adBreaks = 0;
  let lastAdSegIdx = -2;
  for (const idx of removedIdx) {
    const t = origLines[idx].trim();
    if (!isSegment(origLines[idx])) {
      // 保留标签行（KEY/MAP 等）在广告 m3u8 里也留着，避免解密失效
      if (t.startsWith('#EXT-X-KEY') || t.startsWith('#EXT-X-MAP')) adLines.push(origLines[idx]);
      continue;
    }
    // 相邻删除分片之间若出现保留分片，视为新广告段
    let hasKeptSegmentBetween = false;
    if (lastAdSegIdx >= 0) {
      for (let k = lastAdSegIdx + 1; k < idx; k++) {
        if (isSegment(origLines[k]) && !removedSet.has(k)) {
          hasKeptSegmentBetween = true;
          break;
        }
      }
    }
    if (lastAdSegIdx < 0 || hasKeptSegmentBetween) adBreaks += 1;
    lastAdSegIdx = idx;

    adUrls.push(resolveUrl(baseUrl, t));
    // 带上紧邻的 EXTINF（若有）便于独立播放核对
    if (idx - 1 >= 0 && origLines[idx - 1].trim().startsWith('#EXTINF')) {
      adLines.push(origLines[idx - 1]);
    }
    adLines.push(origLines[idx]);
  }
  adLines.push(ENDLIST);

  // 只有真的删掉了广告「分片」才算命中。
  // 若 stripAdGroups 仅清掉了片头那个无语义的 DISCONTINUITY 标记（多分组
  // 同构封装场景，分片一个没少），这里必须返回未命中——否则组合器会误判
  // 为"启发式已处理"而跳过 PCR，把本该由 PCR 处理的情况漏掉。
  if (adUrls.length === 0) return noChange(m3u8Content);

  return {
    main,
    ads: adLines.join('\n'),
    adCount: adUrls.length,
    adBreaks: Math.max(adBreaks, 1),
    adUrls,
    removed: true,
  };
}
