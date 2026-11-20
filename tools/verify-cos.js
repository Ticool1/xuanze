'use strict';
/**
 * COS 上传验证：直接调用服务器接口上传一张测试图，检查返回的 URL 能否访问。
 * 用法：node tools/verify-cos.js http://154.8.201.41:3000 "后台密码"
 */
const BASE = process.argv[2] || 'http://127.0.0.1:3111';
const PASSWORD = process.argv[3] || process.env.ADMIN_PASSWORD || 'admin123';

function tinyPngBase64() {
  // 8x8 红色 PNG（手写最小合法 PNG，避免依赖图片库）
  const zlib = require('node:zlib');
  const w = 8;
  const h = 8;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0; // filter type
    for (let x = 0; x < w; x++) {
      raw[p++] = 0xff;
      raw[p++] = 0x6b;
      raw[p++] = 0x6b;
    }
  }
  const idat = zlib.deflateSync(raw);

  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc = (buf) => {
    let c = -1;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc(Buffer.concat([typeBuf, data])));
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const png = Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
  return 'data:image/png;base64,' + png.toString('base64');
}

(async () => {
  console.log('目标：', BASE);
  console.log('');

  // 1. 登录
  const loginRes = await fetch(BASE + '/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD })
  });
  if (!loginRes.ok) {
    console.log('❌ 后台登录失败:', loginRes.status);
    process.exit(1);
  }
  const cookie = (loginRes.headers.getSetCookie() || [])
    .map((c) => c.split(';')[0])
    .join('; ');
  console.log('✅ 后台登录成功');

  // 2. 上传图片
  const dataUrl = tinyPngBase64();
  console.log('图片大小:', Math.round(Buffer.from(dataUrl.split(',')[1], 'base64').length), 'bytes');

  const upRes = await fetch(BASE + '/api/admin/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ dataUrl })
  });
  const upJson = await upRes.json().catch(() => ({}));
  console.log('上传响应:', upRes.status, JSON.stringify(upJson));

  if (!upRes.ok || !upJson.url) {
    console.log('❌ 上传失败');
    process.exit(1);
  }

  const url = upJson.url;
  const isCos = /myqcloud\.com|^https?:\/\//.test(url) && !url.startsWith('/uploads/');
  console.log('');
  console.log(isCos ? '✅ 图片已上传到 COS' : '⚠️ 图片仍存在本地（COS 未生效，已自动回退）');
  console.log('URL:', url);

  // 3. 访问验证
  const abs = url.startsWith('http') ? url : BASE + url;
  const getRes = await fetch(abs, { method: 'GET' });
  const ct = getRes.headers.get('content-type') || '';
  const len = (await getRes.arrayBuffer()).byteLength;
  console.log('');
  console.log('访问检查:', getRes.status, ct, len + ' bytes');

  if (getRes.ok && ct.startsWith('image/') && len > 0) {
    console.log('✅ 图片可正常访问');
  } else if (getRes.status === 403) {
    console.log('❌ 403 Forbidden —— 存储桶是「私有读写」，需要改成「公有读私有写」');
  } else {
    console.log('❌ 图片无法访问:', getRes.status);
  }
})();
