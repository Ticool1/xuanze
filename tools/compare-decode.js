'use strict';
/**
 * 对照解码测试：
 *  A. 用参考库 qrcode-generator 生成二维码 → jsQR 解码（验证测试环境是否正常）
 *  B. 用我的实现生成二维码 → jsQR 解码
 * 两者对比，能确定问题在我的实现还是测试方法。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find((p) => fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 参考库
const refSrc = fs.readFileSync(path.join(__dirname, 'vendor', 'qrcode-generator.js'), 'utf8');
const sandbox = { module: { exports: {} }, exports: {}, console };
sandbox.module.exports = sandbox.exports;
vm.createContext(sandbox);
vm.runInContext(refSrc, sandbox);
const qrcodeRef = sandbox.module.exports;

const { QrCode } = require('../server/qrcode');

const TEXT = 'https://t.cn/xuanze-demo-2026';

// 生成参考 SVG
function refSvg(text) {
  const qr = qrcodeRef(0, 'M'); // 0 = 自动版本
  qr.addData(text, 'Byte');
  qr.make();
  return qr.createSvgTag({ cellSize: 8, margin: 4 });
}

(async () => {
  const port = 9800 + Math.floor(Math.random() * 150);
  const child = spawn(
    CHROME,
    ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${port}`,
      `--user-data-dir=${path.join(os.tmpdir(), 'xz-qr2-' + Date.now())}`, 'about:blank'],
    { stdio: 'ignore' }
  );

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
      if (r && r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r && r.result ? r.result.value : undefined;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: 'about:blank' });
    await sleep(600);

    // 注入 jsQR
    const jsqr = fs.readFileSync(path.join(__dirname, 'vendor', 'jsQR.js'), 'utf8');
    await ev(jsqr + '\n;window.__jsQR = jsQR;');
    const loaded = await ev(`typeof window.__jsQR === 'function'`);
    console.log('jsQR 注入成功：', loaded);

    async function decode(svg, label) {
      const result = await ev(`(async () => {
        const svg = ${JSON.stringify(svg)};
        const blob = new Blob([svg], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.src = url;
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
        const size = 600;
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const g = canvas.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, size, size);
        g.imageSmoothingEnabled = false;
        g.drawImage(img, 0, 0, size, size);
        const data = g.getImageData(0, 0, size, size);
        const code = window.__jsQR(data.data, size, size, { inversionAttempts: 'attemptBoth' });
        URL.revokeObjectURL(url);
        return code ? code.data : null;
      })()`);
      console.log(`  ${result === TEXT ? '✅' : '❌'} ${label}: ${JSON.stringify(result)}`);
      return result === TEXT;
    }

    const refS = refSvg(TEXT);
    const myS = new QrCode(TEXT).toSvg(8, 4);

    console.log('\nA. 参考库生成的二维码：');
    const a = await decode(refS, 'qrcode-generator');

    console.log('\nB. 我的实现生成的二维码：');
    const b = await decode(myS, 'server/qrcode.js');

    console.log(`\n结论：参考库=${a ? '可解码' : '不可解码'}，我的实现=${b ? '可解码' : '不可解码'}`);
    if (!a) console.log('⚠️ 参考库也无法解码 → 测试环境/解码器调用有问题，不能据此判断我的实现');
    else if (!b) console.log('⚠️ 参考库可以解码但我的不行 → 我的实现有真实缺陷');

    ws.close();
  } finally {
    child.kill();
  }
})();
