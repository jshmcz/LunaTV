/**
 * LabTV 去广告增强组合器
 *
 * 把 LibreTV 的文本三层启发式接到 LabTV 的 PCR 过滤之前，形成双引擎：
 *
 *   1) 先跑启发式（纯文本、零网络、<1ms）：覆盖 URL 特征 / 两长夹一短 / 片头短段；
 *      这类正是 PCR 的盲区（与正片同构、时钟连续的中插广告）。
 *      命中 → 直接采用结果，省掉 PCR 的十几到几十次分片探测。
 *   2) 启发式未命中 → 回退到原 filterAdsByPcr（独立复用流广告，PCR 的强项）。
 *
 * 用法：在 src/app/play/PlayPageClient.tsx 里，把对 filterAdsByPcr 的调用
 * 改为本文件的 filterAdsEnhanced 即可（签名完全兼容，见同目录 README）。
 *
 * 本文件依赖：
 *   - ./heuristicAdFilter （新增，随本方案一起放进去）
 *   - @/lib/pcrAdFilter   （LabTV 5.1.8 已有，不用改）
 */

import {
  stripAdGroupsWithReport,
  type HeuristicResult,
} from './heuristicAdFilter';
import {
  filterAdsByPcr,
  type HlsKey,
  type PcrFilterResult,
} from './pcrAdFilterOrig';

type Probe = (
  url: string,
  key: HlsKey | null,
  log?: (msg: string) => void,
) => Promise<number>;

/** 把启发式结果转换成 PCR 结果结构，供上层 UI / 缓存统一消费 */
function toPcrResult(h: HeuristicResult): PcrFilterResult {
  return {
    main: h.main,
    ads: h.ads,
    adCount: h.adCount,
    adBreaks: h.adBreaks,
    removed: h.removed,
    adUrls: h.adUrls,
    // 启发式是确定性的纯文本判断，结果可直接缓存；不打 skipped 标记
  };
}

/**
 * 增强版广告过滤，签名与原 filterAdsByPcr 完全一致，可直接替换。
 *
 * 策略：启发式优先 → 命中即返回 → 未命中回退 PCR。
 */
export async function filterAdsEnhanced(
  text: string,
  baseUrl: string,
  probe: Probe,
  log: (msg: string) => void = () => {},
): Promise<PcrFilterResult> {
  // master playlist / 空文本没有可过滤的分片结构，直接交给原逻辑处理
  if (!text || text.includes('#EXT-X-STREAM-INF')) {
    return filterAdsByPcr(text, baseUrl, probe, log);
  }

  // —— 第 1 引擎：文本三层启发式（零网络） ——
  const heuristic = stripAdGroupsWithReport(text, baseUrl);
  if (heuristic.removed) {
    log(
      `[AdFilter] 启发式命中：移除 ${heuristic.adBreaks} 段 / ${heuristic.adCount} 个分片，跳过 PCR 探测`,
    );
    return toPcrResult(heuristic);
  }

  // —— 第 2 引擎：启发式没抓到，回退原 PCR ——
  log('[AdFilter] 启发式未命中，回退 PCR 时钟检测');
  return filterAdsByPcr(text, baseUrl, probe, log);
}

/**
 * 可选：融合模式。启发式与 PCR 都跑，取 "删得更干净" 的结果。
 *
 * 注意：此模式会保留 PCR 的探测开销，只有在你明确需要 "宁可多删" 时才用；
 * 默认不启用。切换方式见 README。
 */
export async function filterAdsFusion(
  text: string,
  baseUrl: string,
  probe: Probe,
  log: (msg: string) => void = () => {},
): Promise<PcrFilterResult> {
  if (!text || text.includes('#EXT-X-STREAM-INF')) {
    return filterAdsByPcr(text, baseUrl, probe, log);
  }

  const heuristic = stripAdGroupsWithReport(text, baseUrl);
  const pcr = await filterAdsByPcr(text, baseUrl, probe, log);

  if (!heuristic.removed) return pcr;
  if (!pcr.removed) {
    log('[AdFilter] 融合：PCR 无命中，采用启发式结果');
    return toPcrResult(heuristic);
  }

  // 两边都命中：合并被删 URL，从启发式结果里再剔除 PCR 已删的分片行
  const mergedUrls = Array.from(new Set([...heuristic.adUrls, ...pcr.adUrls]));
  let main = pcr.main;
  // 对启发式命中而 PCR 未覆盖的 URL，逐行从 main 中移除其分片与 EXTINF
  const pcrSet = new Set(pcr.adUrls);
  const extra = heuristic.adUrls.filter((u) => !pcrSet.has(u));
  if (extra.length) {
    const extraSet = new Set(extra);
    const lines = main.split(/\r\n|\n|\r/);
    const kept = lines.filter((l) => {
      const t = l.trim();
      if (!t || t.startsWith('#')) return true;
      try {
        return !extraSet.has(new URL(t, baseUrl).href);
      } catch {
        return !extraSet.has(t);
      }
    });
    main = kept.join('\n');
  }
  log(
    `[AdFilter] 融合：启发式 ${heuristic.adCount} 片 + PCR ${pcr.adCount} 片，合计 ${mergedUrls.length} 片`,
  );
  return {
    ...pcr,
    main,
    removed: true,
    adUrls: mergedUrls,
    adCount: mergedUrls.length,
    adBreaks: heuristic.adBreaks + pcr.adBreaks,
  };
}
