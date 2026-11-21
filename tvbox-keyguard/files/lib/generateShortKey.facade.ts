export const generateShortKey = (username: string) => {
  // [tvbox-keyguard] 加长 key：SHA256(username + 时间戳 + 随机串) 取模映射到
  // 10 位 base62（约 59 位熵），防枚举/猜测，且长度短、便于手动复制配置。
  const timestamp = Date.now().toString();
  const rand = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const hash = CryptoJS.SHA256(username + timestamp + rand);
  const hashHex = hash.toString(CryptoJS.enc.Hex);
  const chars =
    '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const big = BigInt(62);
  const max = big ** BigInt(10); // 62^10
  let num = BigInt('0x' + hashHex) % max;
  let key = '';
  for (let i = 0; i < 10; i++) {
    key = chars[Number(num % big)] + key;
    num = num / big;
  }
  return key || chars[0];
};
