/**
 * PCR 分片探测器 · 性能优化版
 *
 * 用来原样替换 PlayPageClient 里对 browserPcrProbe 的引用，签名完全一致：
 *   (url, key, log?) => Promise<number>
 *
 * 相比 LabTV 5.1.8 原版的 browserPcrProbe，做了三处优化：
 *
 *  1) 跨集 PCR 结果缓存 —— 原版缓存只在单次 filterAdsByPcr 内有效，
 *     同一分片 URL 跨集/跨次播放会重复 fetch。这里用模块级 Map 复用。
 *     注意：只缓存成功读到的 PCR；UNKNOWN 不缓存，避免把临时网络失败固化。
 *
 *  2) AES-128-CBC 一次性解密 —— 原版用 AES-ECB 逐块 decrypt 再手动
 *     XOR，一个 4KB 分片要串行 await 256 次。WebCrypto 原生支持
 *     AES-CBC 多块一次解密，等价且只需 1 次 await。加密流探测提速明显。
 *
 *  3) 探测字节数 4096 → 2048 —— TS 的 PCR 在包头，MIN_PACKETS=8 只要求
 *     8 个包（1504 字节），2048 足够且少传一半数据；仍用普通 GET + 读够
 *     即 cancel（不设 Range，避免跨域预检），行为与原版一致。
 *
 * 复用原厂的 firstPcr / UNKNOWN / HlsKey，不用改 pcrAdFilter.ts。
 */

import { firstPcr, UNKNOWN, type HlsKey } from './pcrAdFilterOrig';

const PROBE_BYTES = 2048;
const PCR_CACHE_MAX = 3000;

/** url -> PCR 秒值（原厂单位 ticks，这里存的是 firstPcr 原值） */
const pcrCache = new Map<string, number>();

function cacheSet(url: string, pcr: number): void {
  if (pcr === UNKNOWN) return; // 失败不缓存
  if (pcrCache.size >= PCR_CACHE_MAX) {
    // Map 保序：淘汰最早插入的 1/4
    let n = Math.floor(PCR_CACHE_MAX / 4);
    for (const k of pcrCache.keys()) {
      pcrCache.delete(k);
      if (--n <= 0) break;
    }
  }
  pcrCache.set(url, pcr);
}

/** 读响应体的前 max 字节后立刻 cancel，避免整片下载 */
async function readUpTo(res: Response, max: number): Promise<Uint8Array> {
  const body = res.body as ReadableStream<Uint8Array> | null;
  if (!body || !body.getReader) {
    const ab = await res.arrayBuffer();
    return new Uint8Array(ab).subarray(0, max);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  try {
    while (got < max) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        got += value.length;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
  const out = new Uint8Array(Math.min(got, max));
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.length, max - off);
    out.set(c.subarray(0, take), off);
    off += take;
    if (off >= max) break;
  }
  return out;
}

/** AES-128-CBC 一次解密整块（对齐到 16 字节），等价原版逐块 ECB+XOR */
async function aesCbcDecrypt(
  data: Uint8Array<ArrayBuffer>,
  key: Uint8Array<ArrayBuffer>,
  iv: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return data;
  const blockBytes = 16;
  const aligned = data.length - (data.length % blockBytes);
  if (aligned <= 0) return data;
  const cryptoKey = await subtle.importKey(
    'raw',
    key,
    { name: 'AES-CBC' },
    false,
    ['decrypt'],
  );
  const plain = await subtle.decrypt(
    { name: 'AES-CBC', iv },
    cryptoKey,
    data.subarray(0, aligned),
  );
  return new Uint8Array(plain);
}

/**
 * 性能优化版 PCR 探测。签名与原 browserPcrProbe 完全一致。
 */
export async function cachedProbe(
  url: string,
  key: HlsKey | null,
  log: (msg: string) => void = () => {},
): Promise<number> {
  const cached = pcrCache.get(url);
  if (cached !== undefined) {
    log(`probe cache hit ${url.length > 48 ? url.slice(0, 48) + '…' : url}`);
    return cached;
  }

  try {
    const res = await fetch(url);
    if (!res.ok && res.status !== 206) {
      log(`probe ${res.status}`);
      return UNKNOWN;
    }
    const buf = await readUpTo(res, PROBE_BYTES);
    if (buf.length < 188 * 8) {
      log(`probe short ${buf.length}B`);
      return UNKNOWN;
    }

    let pcr: number;
    if (key && key.method.toUpperCase() === 'AES-128' && key.uri) {
      try {
        const kres = await fetch(key.uri);
        if (!kres.ok) {
          log(`key ${kres.status}`);
          return UNKNOWN;
        }
        const kbuf = new Uint8Array(await kres.arrayBuffer());
        const iv = key.iv ? new Uint8Array(key.iv) : new Uint8Array(16);
        const plain = await aesCbcDecrypt(
          new Uint8Array(buf),
          kbuf.slice(0, 16),
          iv,
        );
        pcr = firstPcr(plain, plain.length);
      } catch (e) {
        log(`key fail: ${String(e)}`);
        return UNKNOWN;
      }
    } else {
      pcr = firstPcr(buf, buf.length);
    }

    if (pcr !== UNKNOWN) cacheSet(url, pcr);
    return pcr;
  } catch (e) {
    log(`probe fail: ${String(e)}`);
    return UNKNOWN;
  }
}

/** 手动清空探测缓存（换源/清缓存时可选调用） */
export function clearPcrProbeCache(): void {
  pcrCache.clear();
}
