'use strict';
/**
 * 腾讯云 COS 上传（零依赖实现，只用 Node 内置模块）
 *
 * 使用 COS 的「请求签名」直传，不引入 cos-nodejs-sdk-v5。
 * 未配置 COS 时自动降级为本地 /uploads/*.png 存储。
 *
 * 环境变量：
 *   COS_ENABLED=true
 *   COS_SECRET_ID / COS_SECRET_KEY
 *   COS_BUCKET（形如 mybucket-1250000000）
 *   COS_REGION（ap-beijing / ap-shanghai / ap-guangzhou …）
 *   COS_DOMAIN（可选，自定义 CDN 域名）
 */

const crypto = require('node:crypto');

function config() {
  return {
    enabled: String(process.env.COS_ENABLED || '').toLowerCase() === 'true',
    secretId: process.env.COS_SECRET_ID || '',
    secretKey: process.env.COS_SECRET_KEY || '',
    bucket: process.env.COS_BUCKET || '',
    region: process.env.COS_REGION || '',
    domain: (process.env.COS_DOMAIN || '').replace(/\/+$/, '')
  };
}

function isEnabled() {
  const c = config();
  return Boolean(c.enabled && c.secretId && c.secretKey && c.bucket && c.region);
}

function hostOf(c) {
  return `${c.bucket}.cos.${c.region}.myqcloud.com`;
}

/** COS 请求签名（q-sign-algorithm=sha1） */
function sign({ secretId, secretKey }, method, uriPath, query = {}, headers = {}, expireSec = 600) {
  const now = Math.floor(Date.now() / 1000);
  const keyTime = `${now};${now + expireSec}`;

  const sortedQuery = Object.keys(query)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(query[k])}`)
    .join('&');

  const sortedHeaders = Object.keys(headers)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  const headerList = sortedHeaders.map((k) => k.toLowerCase()).join(';');
  const headerStr = sortedHeaders
    .map((k) => `${k.toLowerCase()}=${encodeURIComponent(headers[k])}`)
    .join('&');

  const httpHeaders = `${method.toLowerCase()}\n${uriPath}\n${sortedQuery}\n${headerStr}\n`;

  const stringToSign = `sha1\n${keyTime}\n${sha1(httpHeaders)}\n`;

  const signKey = hmacSha1(secretKey, keyTime);
  const signature = hmacSha1(signKey, stringToSign);

  return {
    url: `https://${uriPath}?${sortedQuery}`,
    authorization:
      `q-sign-algorithm=sha1&q-ak=${secretId}&q-sign-time=${keyTime}` +
      `&q-key-time=${keyTime}&q-header-list=${headerList}&q-url-param-list=` +
      Object.keys(query).sort().map((k) => k.toLowerCase()).join(';') +
      `&q-signature=${signature}`
  };
}

function sha1(str) {
  return crypto.createHash('sha1').update(str, 'utf8').digest('hex');
}

function hmacSha1(key, str) {
  return crypto.createHmac('sha1', key).update(str, 'utf8').digest('hex');
}

/**
 * 上传 Buffer 到 COS，返回可访问 URL；失败返回 null（调用方降级到本地）
 */
async function upload(buffer, filename, contentType) {
  if (!isEnabled()) return null;
  const c = config();
  const host = hostOf(c);
  const key = `images/${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${filename}`;
  const uriPath = `/${key}`;

  const headers = { host };
  const { authorization } = sign(
    c,
    'put',
    uriPath,
    {},
    headers
  );

  try {
    const res = await fetch(`https://${host}${uriPath}`, {
      method: 'PUT',
      headers: {
        Authorization: authorization,
        'Content-Type': contentType || 'application/octet-stream',
        'Content-Length': String(buffer.length),
        Host: host
      },
      body: buffer
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('[cos] 上传失败', res.status, text.slice(0, 300));
      return null;
    }
    const base = c.domain || `https://${host}`;
    return `${base}${uriPath}`;
  } catch (err) {
    console.error('[cos] 上传异常:', err.message);
    return null;
  }
}

module.exports = { isEnabled, upload, config };
