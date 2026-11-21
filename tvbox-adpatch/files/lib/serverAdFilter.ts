/**
 * TVBox 代理链路 · 服务端去广告过滤器
 *
 * 与网页播放同款：直接复用四层文本启发式（stripAdGroups），零网络请求、零外部依赖，
 * 因此不需要 ad_rules 规则订阅也能过滤"与正片同构、时钟连续"的中插广告
 * （典型如澳门赌场类，正片 bf.modujx11.com / 广告 bf.modujx15.com）。
 *
 * 设计取舍：
 *   - 服务端不跑 PCR。PCR 依赖浏览器 hls.js 对 TS 分片做 AES 解密后读时钟断裂，
 *     放到服务端要额外 fetch 几十个分片 + 解密，代价高且 TVBox 场景没有 UI 需要它；
 *     启发式对"域名/时长/URL 特征"的中插广告已足够，且是我们实测能抓住赌场广告的那一层。
 *   - 本模块只处理单个 media playlist（不含 #EXT-X-STREAM-INF 的 master playlist）。
 *     master 的递归代理由调用方 /api/proxy/ad 原有逻辑负责。
 *   - 保留原文里的 #EXT-X-KEY / #EXT-X-MAP 行（调用方会把它们改写成本地代理，解密上下文不能丢）。
 */

import { stripAdGroups } from './heuristicAdFilter';

export interface ServerAdFilterResult {
  main: string;
  /** 是否真的删掉了广告分片 */
  removed: boolean;
  adCount: number;
  adBreaks: number;
}

const hasMaster = (text: string) => text.includes('#EXT-X-STREAM-INF');

const unchanged = (text: string): ServerAdFilterResult => ({
  main: text,
  removed: false,
  adCount: 0,
  adBreaks: 0,
});

/** 统计两个文本之间被删掉的分片行与广告段数（分片 = 非 # 开头非空行） */
function diffReport(orig: string, filtered: string) {
  const seg = (l: string) => l.trim() !== '' && !l.trim().startsWith('#');
  const before = orig.split(/\r\n|\n|\r/);
  const afterSet = new Set(filtered.split(/\r\n|\n|\r/).map((l) => l.trim()));
  let adCount = 0;
  let adBreaks = 0;
  let inBreak = false;
  for (const line of before) {
    if (!seg(line)) continue;
    if (afterSet.has(line.trim())) {
      inBreak = false;
    } else {
      adCount += 1;
      if (!inBreak) {
        adBreaks += 1;
        inBreak = true;
      }
    }
  }
  return { adCount, adBreaks };
}

/**
 * 服务端广告过滤入口。
 *
 * @param content  media playlist 原文（KEY 可能已被改写成代理 URL，不影响判定）
 * @param _baseUrl m3u8 的最终 URL，保留签名以便将来扩展（当前启发式不需要）
 */
export function filterAdsServerSide(
  content: string,
  _baseUrl?: string,
): ServerAdFilterResult {
  if (!content || hasMaster(content)) return unchanged(content);

  // 四层启发式：异域域名组 → URL 特征 → 两长夹一短 → 片头短段
  const main = stripAdGroups(content);
  if (main === content) return unchanged(content);

  const { adCount, adBreaks } = diffReport(content, main);
  if (adCount === 0) return unchanged(content);

  return {
    main,
    removed: true,
    adCount,
    adBreaks: Math.max(adBreaks, 1),
  };
}
