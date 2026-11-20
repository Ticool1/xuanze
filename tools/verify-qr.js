'use strict';
/**
 * 二维码可解码性验证：用 Chrome 内置 BarcodeDetector 扫描服务器生成的二维码 SVG
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const BASE = process.argv[2] || 'http://127.0.0.1:3111';
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find((p) => fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CASES = [
  'https://example.com/',
  'http://127.0.0.1:3111/',
  'https://shop.example.com/?v=0123456789abcdef',
  'https://t.cn/xuanze-demo-2026',
  'https://dianpu.example.cn/order/qrcode/abc-123-def-456-ghi-789',
  // 边界：极短 / 各版本切换点 / 中文 / 特殊字符
  'a',
  'http://1.1.1.1/',
  'https://a.cn/1',
  'https://x.com/?v=0123456789012345678', // 更长
  'https://x.com/?v=0123456789012345678901234567890',
  'https://x.com/?v=0123456789012345678901234567890123456789012345678',
  'https://xuanze.example.cn/?shop=1&table=2&lang=zh',
  '中文参数：选择蛋糕店',
  'https://x.com/?q=中文测试&a=1'
];

(async () => {
  const port = 9700 + Math.floor(Math.random() * 200);
  const child = spawn(
    CHROME,
    ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${port}`,
      `--user-data-dir=${path.join(os.tmpdir(), 'xz-qr-' + Date.now())}`, 'about:blank'],
    { stdio: 'ignore' }
  );

  let ok = 0;
  let fail = 0;

  try {
    let target = null;
    for (let i = 0; i < 60; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((t) => t.type === 'page');
        if (target) break;
      } catch (_) { /* wait */ }
      await sleep(200);
    }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res) => ws.addEventListener('open', res, { once: true }));

    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m.result);
        pending.delete(m.id);
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        const n = ++id;
        pending.set(n, resolve);
        ws.send(JSON.stringify({ id: n, method, params }));
      });
    const ev = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r && r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      }
      return r && r.result ? r.result.value : undefined;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 800, height: 800, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: BASE + '/' });
    await sleep(1200);

    // 注入 jsQR 解码器（本地 vendor 文件，避免联网依赖）
    const jsqrPath = path.join(__dirname, 'vendor', 'jsQR.js');
    if (!fs.existsSync(jsqrPath)) {
      console.log('缺少 tools/vendor/jsQR.js，跳过解码验证');
      ws.close();
      return;
    }
    const jsqr = fs.readFileSync(jsqrPath, 'utf8');
    await ev(jsqr + '\n;window.__jsQR = jsQR;');
    const loaded = await ev(`typeof window.__jsQR === 'function'`);
    console.log('jsQR 注入：', loaded ? 'OK' : '失败');

    for (const text of CASES) {
      // 服务端生成
      const res = await fetch(`${BASE}/api/qrcode?text=${encodeURIComponent(text)}`);
      const svg = await res.text();
      // 通过 Base64 传给页面，避免任何转义/模板插值问题
      const b64 = Buffer.from(svg, 'utf8').toString('base64');

      const result = await ev(`(async () => {
        const b64 = ${JSON.stringify(b64)};
        const svg = new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
        const blob = new Blob([svg], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.src = url;
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
        const size = 600;
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const g = canvas.getContext('2d');
        g.fillStyle = '#fff';
        g.fillRect(0, 0, size, size);
        g.imageSmoothingEnabled = false;
        g.drawImage(img, 0, 0, size, size);
        const data = g.getImageData(0, 0, size, size);
        const code = window.__jsQR(data.data, size, size, { inversionAttempts: 'attemptBoth' });
        URL.revokeObjectURL(url);
        return code ? code.data : null;
      })()`);

      const pass = result === text;
      console.log(`${pass ? '✅' : '❌'} ${JSON.stringify(text)} -> ${JSON.stringify(result)}`);
      if (pass) ok++; else fail++;
    }

    console.log(`\n解码验证：通过 ${ok} 项，失败 ${fail} 项`);
    ws.close();
    process.exitCode = fail ? 1 : 0;
  } finally {
    child.kill();
  }
})();
