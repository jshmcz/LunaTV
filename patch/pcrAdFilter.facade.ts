/**
 * pcrAdFilter 门面（自动升级脚本注入）
 *
 * 透传原厂全部导出，仅把两个可插拔实现替换为增强版：
 *   - filterAdsByPcr  -> 启发式优先 + PCR 回退（enhancedAdFilter）
 *   - browserPcrProbe -> 跨集缓存 + AES-CBC 一次解密 + 2048B 探测（optimizedProbe）
 * 原厂实现完整保留在 ./pcrAdFilterOrig。PlayPageClient 无需任何改动。
 */
export * from './pcrAdFilterOrig';
export { filterAdsEnhanced as filterAdsByPcr } from './enhancedAdFilter';
export { cachedProbe as browserPcrProbe } from './optimizedProbe';
