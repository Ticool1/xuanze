'use strict';
/**
 * 端到端自测脚本（Headless Chrome + CDP）
 * 用法：node tools/e2e.js [baseUrl]
 * 依赖：本机安装 Chrome/Edge，无需 npm 依赖
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const BASE = process.argv[2] || 'http://127.0.0.1:3111';
// 后台密码：可通过第 3 个参数或环境变量 ADMIN_PASSWORD 指定
const ADMIN_PWD = process.argv[3] || process.env.ADMIN_PASSWORD || 'admin123';
const OUT = path.join(__dirname, '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!chromePath) throw new Error('找不到 Chrome/Edge 可执行文件');

  const userDir = path.join(os.tmpdir(), 'xz-e2e-' + Date.now());
  const port = 9300 + Math.floor(Math.random() * 300);

  const child = spawn(
    chromePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDir}`,
      '--window-size=430,932',
      'about:blank'
    ],
    { stdio: 'ignore', detached: false }
  );

  try {
    // 等待 CDP 就绪
    let target = null;
    for (let i = 0; i < 60; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((t) => t.type === 'page');
        if (target) break;
      } catch (_) { /* not ready */ }
      await sleep(200);
    }
    if (!target) throw new Error('CDP 启动失败');

    const WS = target.webSocketDebuggerUrl;
    const ws = new WebSocket(WS);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });

    let msgId = 0;
    const pending = new Map();
    const events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        events.push(msg);
      }
    });

    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++msgId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Console.enable');

    const evaluate = async (expr, opts = {}) => {
      const r = await send('Runtime.evaluate', {
        expression: expr,
        awaitPromise: true,
        returnByValue: true,
        ...opts
      });
      if (r.exceptionDetails) {
        throw new Error('页面脚本异常：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      }
      return r.result?.value;
    };

    const goto = async (url) => {
      await send('Page.navigate', { url });
      await sleep(1200);
    };

    const shot = async (name) => {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
      return name;
    };

    const setViewport = (w, h) => send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: 1, mobile: w < 700
    });

    const results = [];
    const check = (name, ok, extra = '') => {
      results.push({ name, ok, extra });
      console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
    };

    // ===== 1. 前台首页 =====
    await setViewport(430, 932);
    await goto(BASE + '/');
    await sleep(900);

    const front = await evaluate(`(() => ({
      shopName: document.getElementById('shopName')?.textContent,
      phone: document.getElementById('shopPhone')?.textContent,
      logo: document.getElementById('logoMark')?.textContent,
      cats: [...document.querySelectorAll('.cat-item')].map(e => e.textContent.trim()),
      cards: document.querySelectorAll('.product-card').length,
      cartTotal: document.getElementById('cartTotal')?.textContent,
      checkoutDisabled: document.getElementById('checkoutBtn')?.disabled
    }))()`);

    check('前台显示店铺名', front.shopName.includes('选择蛋糕店'), front.shopName);
    check('前台显示手机号', front.phone === '13504418782', front.phone);
    check('左上角有 LOGO', !!front.logo, 'LOGO 字：' + front.logo);
    check('左侧分类栏有分类', front.cats.length >= 4, front.cats.join(' / '));
    check('右侧展示商品卡片', front.cards > 0, front.cards + ' 个');
    check('空购物车时结算按钮禁用', front.checkoutDisabled === true);
    check('底部购物车金额为 0', front.cartTotal === '¥0.00', front.cartTotal);
    await shot('e2e-01-front.png');

    // 购物车条比例 80/20
    const ratio = await evaluate(`(() => {
      const bar = document.querySelector('.cart-bar').getBoundingClientRect().width;
      const left = document.querySelector('.cart-left').getBoundingClientRect().width;
      const right = document.querySelector('.checkout-btn').getBoundingClientRect().width;
      return { pctLeft: Math.round(left / bar * 100), pctRight: Math.round(right / bar * 100) };
    })()`);
    check('购物车条 左80% / 右20%', ratio.pctLeft === 80 && ratio.pctRight === 20, `${ratio.pctLeft}% / ${ratio.pctRight}%`);

    // ===== 2. 切换分类 + 加入购物车 =====
    await evaluate(`document.querySelectorAll('.cat-item')[1].click()`);
    await sleep(400);
    const cat2 = await evaluate(`document.querySelector('.cat-title').textContent.trim()`);
    check('点击分类可切换商品', cat2.length > 0, cat2);

    await evaluate(`document.querySelectorAll('.cat-item')[0].click()`);
    await sleep(300);

    await evaluate(`document.querySelector('.add-btn').click()`);
    await sleep(250);
    await evaluate(`document.querySelectorAll('.product-card')[1].querySelector('.add-btn').click()`);
    await sleep(250);
    await evaluate(`document.querySelectorAll('.product-card')[0].querySelector('.add-btn').click()`);
    await sleep(300);

    const cart = await evaluate(`(() => ({
      total: document.getElementById('cartTotal').textContent,
      count: document.getElementById('cartCount').textContent,
      badge: document.getElementById('cartBadge').textContent,
      disabled: document.getElementById('checkoutBtn').disabled,
      stored: JSON.parse(localStorage.getItem('xz_cart_v1') || '{}')
    }))()`);
    check('加购后金额正确累计', cart.total !== '¥0.00', cart.total);
    check('加购后显示件数', cart.count.includes('已选 3 件'), cart.count);
    check('加购角标显示 3', cart.badge === '3', cart.badge);
    check('加购后结算按钮可点击', cart.disabled === false);
    check('购物车持久化到 localStorage', Object.keys(cart.stored).length > 0, JSON.stringify(cart.stored));
    await shot('e2e-02-cart-added.png');

    // 打开购物车抽屉
    await evaluate(`document.getElementById('cartLeft').click()`);
    await sleep(450);
    const drawer = await evaluate(`(() => ({
      open: document.getElementById('cartDrawer').classList.contains('show'),
      lines: document.querySelectorAll('.cart-line').length
    }))()`);
    check('点击购物车展开明细抽屉', drawer.open === true, drawer.lines + ' 行');
    await shot('e2e-03-drawer.png');

    // 减少一件
    await evaluate(`document.querySelector('[data-minus]').click()`);
    await sleep(300);
    const afterMinus = await evaluate(`document.getElementById('cartCount').textContent`);
    check('抽屉内可增减数量', afterMinus.includes('已选 2 件'), afterMinus);
    await evaluate(`document.getElementById('drawerMask').click()`);
    await sleep(300);

    // ===== 3. 结算页 =====
    await evaluate(`location.href = '/checkout'`);
    await sleep(1600);

    const checkout = await evaluate(`(() => ({
      items: document.querySelectorAll('.order-item').length,
      total: document.getElementById('totalAmount').textContent,
      submitDisabled: document.getElementById('submitBtn').disabled,
      addressVisible: !document.getElementById('fieldAddress').classList.contains('hidden'),
      timeLabel: document.getElementById('timeLabel').textContent,
      visitorFilled: document.getElementById('inputName').value ? 'prefilled-or-empty' : 'empty'
    }))()`);
    check('结算页显示已选商品', checkout.items > 0, checkout.items + ' 件');
    check('结算页显示合计金额', checkout.total !== '¥0.00', checkout.total);
    check('默认配送 → 显示收货地址', checkout.addressVisible === true);
    check('默认标签为「期望送达时间」', checkout.timeLabel === '期望送达时间', checkout.timeLabel);
    check('信息未填时提交按钮禁用', checkout.submitDisabled === true);
    await shot('e2e-04-checkout.png');

    // 切换自取
    await evaluate(`document.querySelector('[data-mode="pickup"]').click()`);
    await sleep(300);
    const pickup = await evaluate(`(() => ({
      addressVisible: !document.getElementById('fieldAddress').classList.contains('hidden'),
      timeLabel: document.getElementById('timeLabel').textContent
    }))()`);
    check('选择自取后隐藏收货地址', pickup.addressVisible === false);
    check('自取时标签变「预计提取时间」', pickup.timeLabel === '预计提取时间', pickup.timeLabel);
    await shot('e2e-05-checkout-pickup.png');

    // 切回配送并填表
    await evaluate(`document.querySelector('[data-mode="delivery"]').click()`);
    await sleep(250);

    await evaluate(`(() => {
      const set = (id, val) => {
        const el = document.getElementById(id);
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set('inputName', '赵女士');
      set('inputPhone', '13712345678');
      set('inputAddress', '辽宁省沈阳市和平区太原街 88 号 3 单元 502');
      set('inputTime', '明天 15:00 前送达');
      set('inputRemark', '少甜');
    })()`);
    await sleep(400);

    const filled = await evaluate(`document.getElementById('submitBtn').disabled`);
    check('信息填写完整后提交按钮可点击', filled === false);
    await shot('e2e-06-checkout-filled.png');

    // 提交
    await evaluate(`document.getElementById('submitBtn').click()`);
    await sleep(1800);

    const success = await evaluate(`(() => ({
      visible: !document.getElementById('successView').classList.contains('hidden'),
      orderNo: document.getElementById('successOrderNo').textContent,
      cartCleared: localStorage.getItem('xz_cart_v1')
    }))()`);
    check('提交后进入成功页', success.visible === true);
    check('成功页显示订单号', /^XZ\d{16,}$/.test(success.orderNo || ''), success.orderNo);
    check('提交后清空本地购物车', !success.cartCleared || success.cartCleared === '{}', String(success.cartCleared));
    await shot('e2e-07-success.png');

    // 刷新前台，购物车应为空
    await goto(BASE + '/');
    await sleep(900);
    const afterOrderFront = await evaluate(`document.getElementById('cartTotal').textContent`);
    check('下单后回到前台购物车归零', afterOrderFront === '¥0.00', afterOrderFront);

    // 再次进入结算页：姓名/手机号自动回填
    await evaluate(`location.href = '/checkout'`);
    await sleep(1500);
    const prefill = await evaluate(`(() => ({
      name: document.getElementById('inputName').value,
      phone: document.getElementById('inputPhone').value
    }))()`);
    check('同一访客下次自动回填姓名', prefill.name === '赵女士', prefill.name || '(空)');
    check('同一访客下次自动回填手机号', prefill.phone === '13712345678', prefill.phone || '(空)');

    // ===== 4. 后台 =====
    await setViewport(1440, 1000);
    await goto(BASE + '/admin');
    await sleep(900);

    // 登录
    await evaluate(`(() => {
      document.getElementById('loginPassword').value = ${JSON.stringify(ADMIN_PWD)};
      document.getElementById('loginBtn').click();
    })()`);
    await sleep(1500);

    const admin = await evaluate(`(() => ({
      loggedIn: !document.getElementById('adminView').classList.contains('hidden'),
      catRows: document.querySelectorAll('#catTbody tr').length,
      prodRows: document.querySelectorAll('#prodTbody tr').length,
      hasOpenFront: !!document.getElementById('openFrontBtn'),
      hasQrBtn: !!document.getElementById('qrBtn')
    }))()`);
    check('后台密码登录成功', admin.loggedIn === true);
    check('后台显示分类列表', admin.catRows > 0, admin.catRows + ' 行');
    check('后台显示商品列表', admin.prodRows > 0, admin.prodRows + ' 行');
    check('后台有「打开前台」入口', admin.hasOpenFront === true);
    check('后台入口旁有二维码按钮', admin.hasQrBtn === true);
    await shot('e2e-08-admin-products.png');

    // 二维码弹层
    await evaluate(`document.getElementById('qrBtn').click()`);
    await sleep(1200);
    const qr = await evaluate(`(() => ({
      open: document.getElementById('qrModal').classList.contains('show'),
      hasSvg: !!document.querySelector('#qrCanvas svg'),
      url: document.getElementById('qrUrl').textContent
    }))()`);
    check('点击二维码按钮展开弹层', qr.open === true);
    check('二维码已渲染（SVG）', qr.hasSvg === true);
    check('二维码内容为前台地址', /^https?:\/\//.test(qr.url), qr.url);
    await shot('e2e-09-qr.png');
    await evaluate(`document.querySelector('[data-close="qrModal"]').click()`);
    await sleep(300);

    // 新建分类
    await evaluate(`document.getElementById('addCatBtn').click()`);
    await sleep(400);
    await evaluate(`(() => {
      document.getElementById('catName').value = '节日礼盒';
      document.getElementById('catSort').value = '5';
      document.getElementById('catSaveBtn').click();
    })()`);
    await sleep(1200);
    const catCreated = await evaluate(`[...document.querySelectorAll('#catTbody tr')].some(tr => tr.textContent.includes('节日礼盒'))`);
    check('后台可新增分类', catCreated === true);

    // 新建商品（带图片）——先把筛选切到刚创建的分类，这样新商品会落在该分类
    await evaluate(`(() => {
      const sel = document.getElementById('filterCat');
      const opt = [...sel.options].find(o => o.textContent.includes('节日礼盒'));
      if (opt) {
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()`);
    await sleep(600);

    await evaluate(`document.getElementById('addProdBtn').click()`);
    await sleep(700);
    const pickedCat = await evaluate(`(() => {
      const sel = document.getElementById('prodCategory');
      return {
        pick: sel.dataset.pick,
        value: sel.value,
        label: sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : ''
      };
    })()`);
    check('新增商品默认选中当前筛选分类', pickedCat.label === '节日礼盒', pickedCat.label || pickedCat.value);
    const imgDataUrl = await evaluate(`(() => {
      const c = document.createElement('canvas');
      c.width = 200; c.height = 200;
      const g = c.getContext('2d');
      const grad = g.createLinearGradient(0, 0, 200, 200);
      grad.addColorStop(0, '#ffd6e0');
      grad.addColorStop(1, '#d96b6b');
      g.fillStyle = grad;
      g.fillRect(0, 0, 200, 200);
      g.fillStyle = '#fff';
      g.font = 'bold 34px sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('🎂', 100, 100);
      return c.toDataURL('image/png');
    })()`);

    await evaluate(`(() => {
      const set = (id, val) => {
        const el = document.getElementById(id);
        el.value = val;
      };
      set('prodName', '中秋月饼礼盒 8枚装');
      set('prodPrice', '188');
      set('prodSort', '0');
      set('prodDescr', '蛋黄莲蓉，精美礼盒');
    })()`);
    // 通过文件 input 传图片
    await evaluate(`(() => {
      const dataUrl = ${JSON.stringify(imgDataUrl)};
      const bin = atob(dataUrl.split(',')[1]);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const file = new File([arr], 'cake.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.getElementById('prodImageFile');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(600);
    const previewOk = await evaluate(`!!document.getElementById('prodImagePreview').style.backgroundImage`);
    check('商品图片可选择并预览', previewOk === true);
    await shot('e2e-10-admin-prod-modal.png');

    await evaluate(`document.getElementById('prodSaveBtn').click()`);
    await sleep(1600);
    const prodCreated = await evaluate(`[...document.querySelectorAll('#prodTbody tr')].some(tr => tr.textContent.includes('中秋月饼礼盒'))`);
    check('后台可新增商品（含图片）', prodCreated === true);

    // 前台应能看到新商品
    await setViewport(430, 932);
    await goto(BASE + '/');
    await sleep(1200);
    const newProdOnFront = await evaluate(`(() => {
      const names = [...document.querySelectorAll('.product-name')].map(e => e.textContent);
      const cats = [...document.querySelectorAll('.cat-item')].map(e => e.textContent.trim());
      return { names, hasCat: cats.some(c => c.includes('节日礼盒')) };
    })()`);
    // 新分类可能不在首个分类里，切换过去看
    const catHasNew = newProdOnFront.hasCat;

    if (catHasNew) {
      await evaluate(`(() => {
        const el = [...document.querySelectorAll('.cat-item')].find(e => e.textContent.includes('节日礼盒'));
        if (el) el.click();
      })()`);
      // 等待分类渲染完成（商品标题切换为该分类）
      for (let i = 0; i < 20; i++) {
        const title = await evaluate(`document.querySelector('.cat-title')?.textContent.trim() || ''`);
        if (title === '节日礼盒') break;
        await sleep(200);
      }
      await sleep(500);
    }
    const newNames = await evaluate(`[...document.querySelectorAll('.product-name')].map(e => e.textContent)`);
    check('后台新增的分类在前台可见', catHasNew === true);
    check('后台新增的商品在前台可见', newNames.some((n) => n.includes('中秋月饼礼盒')), newNames.join(' | '));
    await shot('e2e-11-front-new-product.png');

    // 前台新商品图应从 /uploads 正确加载
    const imgOk = await evaluate(`(() => {
      const el = [...document.querySelectorAll('.product-card')].find(c => c.textContent.includes('中秋月饼礼盒'));
      if (!el) return false;
      const thumb = el.querySelector('.product-thumb');
      return thumb.style.backgroundImage.includes('/uploads/');
    })()`);
    check('商品图片通过 /uploads 加载', imgOk === true);

    // 图片真实可访问（不是 404 占位）
    const imgUrl = await evaluate(`(() => {
      const el = [...document.querySelectorAll('.product-card')].find(c => c.textContent.includes('中秋月饼礼盒'));
      const bg = el && el.querySelector('.product-thumb').style.backgroundImage;
      const m = bg && bg.match(/url\\("?(.+?)"?\\)/);
      return m ? m[1] : '';
    })()`);
    if (imgUrl) {
      const abs = new URL(imgUrl, BASE).href;
      const resp = await fetch(abs);
      check('图片真实可访问且为图片类型', resp.ok && (resp.headers.get('content-type') || '').startsWith('image/'),
        `${resp.status} ${resp.headers.get('content-type')} ${imgUrl}`);
    }

    // ===== 5. 订单管理 =====
    await setViewport(1440, 1000);
    await goto(BASE + '/admin');
    await sleep(1000);
    await evaluate(`document.querySelector('[data-view="orders"]').click()`);
    await sleep(1300);

    const ordersView = await evaluate(`(() => ({
      rows: document.querySelectorAll('#orderTbody tr').length,
      text: document.getElementById('orderTbody').textContent,
      hasDoneBtn: document.querySelector('#orderTbody [data-to="done"]') !== null,
      hasCancelBtn: document.querySelector('#orderTbody [data-to="cancelled"]') !== null
    }))()`);
    check('订单管理显示订单', ordersView.rows > 0, ordersView.rows + ' 行');
    check('订单显示称呼', ordersView.text.includes('赵女士'));
    check('订单显示手机号', ordersView.text.includes('13712345678'));
    check('订单显示交货方式', ordersView.text.includes('配送'));
    check('订单显示预计时间', ordersView.text.includes('明天 15:00'));
    check('有「完成」操作按钮', ordersView.hasDoneBtn === true);
    check('有「取消」操作按钮', ordersView.hasCancelBtn === true);
    await shot('e2e-12-admin-orders.png');

    // 标记完成 → 收益统计变化
    await evaluate(`document.querySelector('#orderTbody [data-to="done"]').click()`);
    await sleep(1500);
    const doneState = await evaluate(`document.getElementById('orderTbody').textContent.includes('已完成')`);
    check('点击「完成」后订单状态变为已完成', doneState === true);

    // ===== 6. 访客日志 + 收益汇总 =====
    await evaluate(`document.querySelector('[data-view="logs"]').click()`);
    await sleep(1600);

    const logsView = await evaluate(`(() => ({
      cards: document.querySelectorAll('#statCards .stat-card').length,
      cardText: document.getElementById('statCards').textContent,
      rows: document.querySelectorAll('#logTbody tr').length,
      logText: document.getElementById('logTbody').textContent
    }))()`);
    check('访客日志页有汇总卡片', logsView.cards >= 5, logsView.cards + ' 张');
    check('汇总含「累计收益」', logsView.cardText.includes('累计收益'));
    check('汇总含「今天」', logsView.cardText.includes('今天'));
    check('汇总含「最近 7 天」', logsView.cardText.includes('最近 7 天'));
    check('汇总含「最近 30 天」', logsView.cardText.includes('最近 30 天'));
    check('访客日志有记录', logsView.rows > 0, logsView.rows + ' 行');
    check('日志记录浏览事件', logsView.logText.includes('浏览'));
    check('日志记录下单事件', logsView.logText.includes('下单'));
    check('日志含唯一访客标识', /[a-f0-9]{12}/.test(logsView.logText));
    await shot('e2e-13-admin-logs.png');

    // 收益汇总应大于 0（刚才完成的订单）
    const earn = await evaluate(`(() => {
      const cards = [...document.querySelectorAll('#statCards .stat-card')];
      const acc = cards.find(c => c.textContent.includes('累计收益'));
      return acc ? acc.querySelector('.value').textContent : '';
    })()`);
    check('累计收益已统计到已完成订单', /¥\d/.test(earn) && !earn.startsWith('¥0.00'), earn);

    // ===== 7. 访客唯一标识 & 自动填充跨会话 =====
    const vid1 = await evaluate(`document.cookie.match(/xz_vid=([^;]+)/)?.[1] || ''`);
    check('访客 cookie 存在唯一标识', vid1.length >= 16, vid1);

    // 汇总
    const failed = results.filter((r) => !r.ok);
    console.log('');
    console.log(`总计 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`);
    if (failed.length) {
      console.log('失败项：');
      for (const f of failed) console.log('  - ' + f.name + (f.extra ? ' (' + f.extra + ')' : ''));
    }

    ws.close();
    process.exitCode = failed.length ? 1 : 0;
  } finally {
    try {
      child.kill();
    } catch (_) { /* ignore */ }
  }
}

main().catch((err) => {
  console.error('E2E 运行失败：', err);
  process.exitCode = 1;
});
