'use strict';
/**
 * 调试脚本：检查后台新建商品时，分类下拉与提交的实际值
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

(async () => {
  const port = 9600 + Math.floor(Math.random() * 300);
  const child = spawn(
    CHROME,
    ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${port}`,
      `--user-data-dir=${path.join(os.tmpdir(), 'xz-dbg-' + Date.now())}`, 'about:blank'],
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
      return r.result?.value;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

    await send('Page.navigate', { url: BASE + '/admin' });
    await sleep(1200);
    await ev(`document.getElementById('loginPassword').value='admin123';document.getElementById('loginBtn').click();`);
    await sleep(1600);

    // 新建分类
    await ev(`document.getElementById('addCatBtn').click()`);
    await sleep(400);
    await ev(`document.getElementById('catName').value='调试分类';document.getElementById('catSort').value='9';document.getElementById('catSaveBtn').click();`);
    await sleep(1600);

    const state1 = await ev(`({
      catIds: [...document.querySelectorAll('#catTbody tr')].map(tr => tr.textContent.trim()),
      filterOptions: [...document.getElementById('filterCat').options].map(o => o.value + ':' + o.textContent)
    })`);
    console.log('保存分类后：', JSON.stringify(state1, null, 1));

    await ev(`document.getElementById('filterCat').value='5'; document.getElementById('filterCat').dispatchEvent(new Event('change',{bubbles:true}));`);
    await sleep(500);

    // 打开新增商品弹窗
    await ev(`document.getElementById('addProdBtn').click()`);
    await sleep(700);

    const modal = await ev(`({
      pick: document.getElementById('prodCategory').dataset.pick,
      value: document.getElementById('prodCategory').value,
      options: [...document.getElementById('prodCategory').options].map(o => o.value + ':' + o.textContent)
    })`);
    console.log('弹窗打开后：', JSON.stringify(modal, null, 1));

    await ev(`document.getElementById('prodName').value='调试商品';document.getElementById('prodPrice').value='99';document.getElementById('prodSaveBtn').click();`);
    await sleep(1600);

    const after = await ev(`[...document.querySelectorAll('#prodTbody tr')].map(tr => tr.textContent.replace(/\\s+/g,' ').trim())`);
    console.log('保存后商品列表：', JSON.stringify(after, null, 1));

    // 直接查接口
    const api = await (await fetch(BASE + '/api/menu')).text();
    console.log('前台菜单：', api.slice(0, 600));

    ws.close();
  } finally {
    child.kill();
  }
})();
