'use strict';

// 极简 .env 加载（零依赖），必须在读取 process.env 之前执行
(function loadEnv() {
  const fs0 = require('node:fs');
  const path0 = require('node:path');
  const envPath = path0.join(__dirname, '..', '.env');
  if (!fs0.existsSync(envPath)) return;
  const lines = fs0.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq === -1) continue;
    const key = s.slice(0, eq).trim();
    let val = s.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
})();

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const cfg = require('./db');
const cos = require('./cos');

const {
  db,
  nowIso,
  todayStartIso,
  daysAgoIso,
  randId,
  orderNo,
  guestSvg,
  QrCode,
  UPLOAD_DIR,
  PUBLIC_DIR
} = cfg;

// ---------------- 配置 ----------------
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const SESSION_SECRET = process.env.SESSION_SECRET || randId(32);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const MAX_BODY = 25 * 1024 * 1024; // 25MB（含 base64 图片）

// ---------------- 小工具 ----------------
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, ...extra });
  res.end(text);
}

function getCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return '';
}

function setCookie(res, name, value, maxAgeSec, httpOnly = false) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', `Max-Age=${maxAgeSec}`];
  if (httpOnly) parts.push('HttpOnly');
  parts.push('SameSite=Lax');
  const prev = res.getHeader('Set-Cookie');
  const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  list.push(parts.join('; '));
  res.setHeader('Set-Cookie', list);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, '请求格式错误（JSON 解析失败）');
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function trim(v, max = 500) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

function toMoneyText(n) {
  return (Math.round(Number(n) * 100) / 100).toFixed(2);
}

// ---------------- 管理员会话 ----------------
function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  if (sig.length !== expect.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function requireAdmin(req) {
  const token = getCookie(req, 'xz_admin');
  const payload = verifyToken(token);
  if (!payload) throw new HttpError(401, '未登录或登录已过期');
  return payload;
}

// ---------------- 访客标识 ----------------
function visitorIdFrom(req) {
  return trim(getCookie(req, 'xz_vid'), 64).replace(/[^a-zA-Z0-9]/g, '');
}

function ensureVisitor(req, res) {
  let vid = visitorIdFrom(req);
  if (vid.length < 16) {
    vid = randId(24);
    setCookie(res, 'xz_vid', vid, 60 * 60 * 24 * 365, false);
  }
  return vid;
}

function logVisit(req, vid, event, pathName, extra = '') {
  try {
    db.prepare(
      `INSERT INTO visitor_logs (visitor_id, event, path, referer, ua, ip, extra, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      vid,
      event,
      trim(pathName, 200),
      trim(req.headers.referer || '', 300),
      trim(req.headers['user-agent'] || '', 300),
      clientIp(req),
      typeof extra === 'string' ? extra : JSON.stringify(extra),
      nowIso()
    );
  } catch (e) {
    console.error('[log] 写入访客日志失败:', e.message);
  }
}

// ---------------- 数据查询封装 ----------------
const q = {
  categories() {
    return db.prepare('SELECT id, name, sort, created_at FROM categories ORDER BY sort ASC, id ASC').all();
  },
  // 前台：只取上架商品
  menu() {
    const cats = db
      .prepare('SELECT id, name FROM categories ORDER BY sort ASC, id ASC')
      .all();
    const prods = db
      .prepare(
        `SELECT id, category_id, name, price, image, descr
           FROM products WHERE status = 1
          ORDER BY sort ASC, id ASC`
      )
      .all();
    const grouped = new Map(cats.map((c) => [c.id, { ...c, products: [] }]));
    for (const p of prods) {
      if (grouped.has(p.category_id)) grouped.get(p.category_id).products.push(p);
    }
    return { categories: [...grouped.values()] };
  },
  // 后台：全部商品
  allProducts() {
    return db
      .prepare('SELECT * FROM products ORDER BY sort ASC, id ASC')
      .all();
  },
  customerByVisitor(vid) {
    return db
      .prepare('SELECT visitor_id, name, phone FROM customers WHERE visitor_id = ?')
      .get(vid);
  },
  recentOrdersByVisitor(vid) {
    return db
      .prepare(
        `SELECT id, order_no, name, phone, mode, address, expect_time, amount, count, status, created_at
           FROM orders WHERE visitor_id = ? ORDER BY id DESC LIMIT 20`
      )
      .all(vid);
  }
};

function orderList({ status = '', limit = 200, offset = 0 } = {}) {
  const where = [];
  const args = [];
  if (status && ['pending', 'done', 'cancelled'].includes(status)) {
    where.push('status = ?');
    args.push(status);
  }
  const sql =
    `SELECT * FROM orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''}` +
    ' ORDER BY id DESC LIMIT ? OFFSET ?';
  return db.prepare(sql).all(...args, limit, offset);
}

function stats() {
  const paid = `status = 'done'`;
  const sumFor = (startIso) => {
    const row = db
      .prepare(`SELECT COUNT(*) AS cnt, COALESCE(SUM(amount), 0) AS amt FROM orders WHERE ${paid} AND created_at >= ?`)
      .get(startIso);
    return { count: row.cnt || 0, amount: Math.round((row.amt || 0) * 100) / 100 };
  };
  const all = db
    .prepare(`SELECT COUNT(*) AS cnt, COALESCE(SUM(amount), 0) AS amt FROM orders WHERE ${paid}`)
    .get();

  const pending = db.prepare(`SELECT COUNT(*) AS cnt FROM orders WHERE status = 'pending'`).get();
  const cancelled = db.prepare(`SELECT COUNT(*) AS cnt FROM orders WHERE status = 'cancelled'`).get();
  const totalOrders = db.prepare('SELECT COUNT(*) AS cnt FROM orders').get();
  const visitors = db
    .prepare(`SELECT COUNT(DISTINCT visitor_id) AS cnt FROM visitor_logs WHERE created_at >= ?`)
    .get(todayStartIso());

  return {
    total: { count: all.cnt || 0, amount: Math.round((all.amt || 0) * 100) / 100 },
    today: sumFor(todayStartIso()),
    week: sumFor(daysAgoIso(6)),
    month: sumFor(daysAgoIso(29)),
    pendingCount: pending.cnt || 0,
    cancelledCount: cancelled.cnt || 0,
    orderCount: totalOrders.cnt || 0,
    todayVisitors: visitors.cnt || 0
  };
}

// 访客日志聚合：同一访客当天多次浏览只显示一条，并附上下单次数
function visitorLogs({ limit = 300 } = {}) {
  const rows = db
    .prepare(
      `SELECT id, visitor_id, event, path, referer, ua, ip, extra, created_at
         FROM visitor_logs ORDER BY id DESC LIMIT ?`
    )
    .all(limit);

  // 每个访客的浏览/下单统计
  const perVisitor = new Map();
  for (const r of db
    .prepare(
      `SELECT visitor_id,
              COUNT(CASE WHEN event = 'view' THEN 1 END) AS views,
              COUNT(CASE WHEN event = 'order' THEN 1 END) AS orders,
              MIN(created_at) AS first_at,
              MAX(created_at) AS last_at
         FROM visitor_logs GROUP BY visitor_id`
    )
    .all()) {
    perVisitor.set(r.visitor_id, r);
  }

  return rows.map((r) => ({
    ...r,
    stat: perVisitor.get(r.visitor_id) || null
  }));
}

// ---------------- 图片上传（base64 落盘） ----------------
const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg'
};

/**
 * 保存 base64 图片：优先上传到 COS（若已配置），否则落本地 /uploads。
 * 返回可直接用于 <img src> 的地址。
 */
async function saveBase64Image(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    throw new HttpError(400, '图片格式不正确，需要 data:image/... 的 base64');
  }
  const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(dataUrl);
  if (!m) throw new HttpError(400, '图片 base64 解析失败');
  const mime = m[1].toLowerCase();
  const ext = MIME_EXT[mime];
  if (!ext) throw new HttpError(400, `不支持的图片类型：${mime}`);
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 8 * 1024 * 1024) throw new HttpError(400, '图片不能超过 8MB');

  const name = `${Date.now()}-${randId(10)}.${ext}`;

  // 优先 COS（带宽不占服务器，访问更快）
  if (cos.isEnabled()) {
    const url = await cos.upload(buf, name, mime);
    if (url) return url;
    console.warn('[upload] COS 上传失败，回退到本地存储');
  }

  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return `/uploads/${name}`;
}

// ---------------- 静态文件 ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function serveStatic(req, res, pathname) {
  const map = {
    '/': ['index.html', 'public'],
    '/index.html': ['index.html', 'public'],
    '/checkout': ['checkout.html', 'public'],
    '/admin': ['admin.html', 'public']
  };

  if (map[pathname]) {
    const [file, dir] = map[pathname];
    return sendFile(res, path.join(dir === 'public' ? PUBLIC_DIR : dir, file), 'text/html; charset=utf-8');
  }

  if (pathname.startsWith('/uploads/')) {
    const name = path.basename(pathname.slice('/uploads/'.length));
    const full = path.join(UPLOAD_DIR, name);
    if (!fs.existsSync(full)) {
      res.writeHead(404, { 'Content-Type': 'image/svg+xml' });
      return res.end(guestSvg(300));
    }
    return sendFile(res, full, MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', 60 * 60 * 24 * 30);
  }

  if (pathname.startsWith('/assets/')) {
    const rel = pathname.slice('/assets/'.length);
    if (rel.includes('..')) return sendText(res, 403, 'forbidden');
    const full = path.join(PUBLIC_DIR, 'assets', rel);
    if (!fs.existsSync(full)) return sendText(res, 404, 'not found');
    return sendFile(res, full, MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', 60 * 60);
  }

  if (pathname.startsWith('/public/')) {
    const rel = pathname.slice('/public/'.length);
    if (rel.includes('..')) return sendText(res, 403, 'forbidden');
    const full = path.join(PUBLIC_DIR, rel);
    if (!fs.existsSync(full)) return sendText(res, 404, 'not found');
    return sendFile(res, full, MIME[path.extname(full).toLowerCase()] || 'application/octet-stream');
  }

  return false;
}

function sendFile(res, full, type, cache = 0) {
  try {
    const buf = fs.readFileSync(full);
    res.writeHead(200, {
      'Content-Type': type || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': cache ? `public, max-age=${cache}` : 'no-cache'
    });
    res.end(buf);
    return true;
  } catch {
    return false;
  }
}

// ---------------- 路由 ----------------
async function handleApi(req, res, url, pathname) {
  const method = req.method.toUpperCase();
  const parts = pathname.split('/').filter(Boolean); // ['api', ...]

  // ---- 公共：健康检查 ----
  if (pathname === '/api/health' && method === 'GET') {
    return sendJson(res, 200, { ok: true, time: nowIso() });
  }

  // ---- 公共：店铺信息（店铺名/电话/Logo） ----
  if (pathname === '/api/shop' && method === 'GET') {
    return sendJson(res, 200, {
      shopName: process.env.SHOP_NAME || '选择蛋糕店',
      phone: process.env.SHOP_PHONE || '13504418782'
    });
  }

  // ---- 公共：前台菜单 ----
  if (pathname === '/api/menu' && method === 'GET') {
    return sendJson(res, 200, q.menu());
  }

  // ---- 公共：访客标识 ----
  if (pathname === '/api/visitor' && method === 'GET') {
    const vid = ensureVisitor(req, res);
    const customer = q.customerByVisitor(vid);
    return sendJson(res, 200, {
      visitorId: vid,
      customer: customer ? { name: customer.name, phone: customer.phone } : null
    });
  }

  // ---- 公共：访客事件上报 ----
  if (pathname === '/api/visit' && method === 'POST') {
    const vid = ensureVisitor(req, res);
    let body;
    try {
      body = await readJson(req);
    } catch {
      body = {};
    }
    const event = ['view', 'order_spawn', 'checkout_view', 'order'].includes(body.event) ? body.event : 'view';
    logVisit(req, vid, event, body.path || '/', body.extra || '');
    return sendJson(res, 200, { ok: true });
  }

  // ---- 公共：提交订单 ----
  if (pathname === '/api/orders' && method === 'POST') {
    const vid = ensureVisitor(req, res);
    const body = await readJson(req);

    const name = trim(body.name, 40);
    const phone = trim(body.phone, 20);
    const mode = body.mode === 'pickup' ? 'pickup' : 'delivery';
    const address = mode === 'delivery' ? trim(body.address, 200) : '';
    const expectTime = trim(body.expectTime, 60);
    const remark = trim(body.remark, 200);
    const items = Array.isArray(body.items) ? body.items : [];

    if (!name) throw new HttpError(400, '请填写怎么称呼您');
    if (!phone) throw new HttpError(400, '请填写您的手机号');
    if (!/^1[3-9]\d{9}$/.test(phone)) throw new HttpError(400, '手机号格式不正确');
    if (!expectTime) throw new HttpError(400, mode === 'delivery' ? '请填写期望送达时间' : '请填写预计提取时间');
    if (mode === 'delivery' && !address) throw new HttpError(400, '配送需要填写收货地址');
    if (!items.length) throw new HttpError(400, '购物车是空的');

    // 用数据库价格重新计价，防止前端篡改
    const detail = [];
    let amount = 0;
    let count = 0;
    for (const it of items) {
      const pid = Number(it.id);
      const num = Math.floor(Number(it.qty));
      if (!Number.isFinite(pid) || !Number.isFinite(num) || num <= 0) continue;
      const prod = db
        .prepare('SELECT id, name, price, status FROM products WHERE id = ?')
        .get(pid);
      if (!prod || prod.status !== 1) throw new HttpError(400, '有商品已下架，请刷新后重试');
      const qty = Math.min(num, 999);
      amount += prod.price * qty;
      count += qty;
      detail.push({ id: prod.id, name: prod.name, price: prod.price, qty });
    }
    if (!count) throw new HttpError(400, '购物车是空的');
    amount = Math.round(amount * 100) / 100;

    const now = nowIso();
    const no = orderNo();
    const info = db
      .prepare(
        `INSERT INTO orders
           (order_no, visitor_id, name, phone, mode, address, expect_time, amount, count, items, status, remark, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
      )
      .run(no, vid, name, phone, mode, address, expectTime, amount, count, JSON.stringify(detail), remark, now, now);

    // 记住客户信息（下次自动填充）
    db.prepare(
      `INSERT INTO customers (visitor_id, name, phone, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(visitor_id) DO UPDATE SET name = excluded.name, phone = excluded.phone, updated_at = excluded.updated_at`
    ).run(vid, name, phone, now);

    logVisit(req, vid, 'order', '/checkout', `订单 ${no} ¥${toMoneyText(amount)}`);

    return sendJson(res, 200, {
      ok: true,
      orderNo: no,
      orderId: Number(info.lastInsertRowid),
      amount,
      count
    });
  }

  // ---- 公共：二维码 SVG ----
  if (pathname === '/api/qrcode' && method === 'GET') {
    const target = url.searchParams.get('text') || '';
    if (!target) throw new HttpError(400, '缺少 text 参数');
    if (target.length > 180) throw new HttpError(400, '内容过长（最多 180 字节）');
    let svg;
    try {
      svg = new QrCode(target).toSvg(8, 4);
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Content-Length': Buffer.byteLength(svg)
    });
    return res.end(svg);
  }

  // ---- 公共：站点地址（给后台生成二维码用） ----
  if (pathname === '/api/site-url' && method === 'GET') {
    const host = req.headers.host || `127.0.0.1:${PORT}`;
    const base = PUBLIC_BASE_URL || `http://${host}`;
    return sendJson(res, 200, { base, forwardedHost: req.headers['x-forwarded-host'] || null });
  }

  // ---------------- 后台：登录 ----------------
  if (pathname === '/api/admin/login' && method === 'POST') {
    const body = await readJson(req);
    const pwd = trim(body.password, 200);
    if (!pwd || pwd !== ADMIN_PASSWORD) {
      return sendJson(res, 401, { ok: false, message: '密码错误' });
    }
    const token = signToken({ admin: true, exp: Date.now() + 1000 * 60 * 60 * 24 * 7, iat: Date.now() });
    setCookie(res, 'xz_admin', token, 60 * 60 * 24 * 7, true);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/admin/logout' && method === 'POST') {
    setCookie(res, 'xz_admin', '', 0, true);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/admin/me' && method === 'GET') {
    try {
      requireAdmin(req);
      return sendJson(res, 200, { ok: true, loggedIn: true });
    } catch {
      return sendJson(res, 200, { ok: true, loggedIn: false });
    }
  }

  // ---- 以下接口均需管理员 ----
  if (parts[1] === 'admin') {
    requireAdmin(req);
  }

  // ---- 后台：概览统计 ----
  if (pathname === '/api/admin/stats' && method === 'GET') {
    return sendJson(res, 200, stats());
  }

  // ---- 后台：分类 ----
  if (pathname === '/api/admin/categories' && method === 'GET') {
    const rows = db
      .prepare(
        `SELECT c.id, c.name, c.sort, c.created_at,
                (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS productCount
           FROM categories c ORDER BY c.sort ASC, c.id ASC`
      )
      .all();
    return sendJson(res, 200, { categories: rows });
  }

  if (pathname === '/api/admin/categories' && method === 'POST') {
    const body = await readJson(req);
    const name = trim(body.name, 40);
    if (!name) throw new HttpError(400, '分类名称不能为空');
    const sort = Number.isFinite(Number(body.sort)) ? Number(body.sort) : 0;
    const info = db
      .prepare('INSERT INTO categories (name, sort, created_at) VALUES (?, ?, ?)')
      .run(name, sort, nowIso());
    return sendJson(res, 200, { ok: true, id: Number(info.lastInsertRowid) });
  }

  if (parts[2] === 'categories' && parts[3] && method === 'PUT') {
    const id = Number(parts[3]);
    const body = await readJson(req);
    const name = trim(body.name, 40);
    if (!name) throw new HttpError(400, '分类名称不能为空');
    const sort = Number.isFinite(Number(body.sort)) ? Number(body.sort) : 0;
    db.prepare('UPDATE categories SET name = ?, sort = ? WHERE id = ?').run(name, sort, id);
    return sendJson(res, 200, { ok: true });
  }

  if (parts[2] === 'categories' && parts[3] && method === 'DELETE') {
    const id = Number(parts[3]);
    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    return sendJson(res, 200, { ok: true });
  }

  // ---- 后台：商品 ----
  if (pathname === '/api/admin/products' && method === 'GET') {
    const rows = db
      .prepare(
        `SELECT p.*, c.name AS categoryName
           FROM products p LEFT JOIN categories c ON c.id = p.category_id
          ORDER BY p.sort ASC, p.id ASC`
      )
      .all();
    return sendJson(res, 200, { products: rows });
  }

  if (pathname === '/api/admin/products' && method === 'POST') {
    const body = await readJson(req);
    const categoryId = Number(body.categoryId);
    const name = trim(body.name, 60);
    const price = Number(body.price);
    if (!Number.isFinite(categoryId)) throw new HttpError(400, '请选择分类');
    const cat = db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId);
    if (!cat) throw new HttpError(400, '分类不存在');
    if (!name) throw new HttpError(400, '商品名称不能为空');
    if (!Number.isFinite(price) || price < 0) throw new HttpError(400, '价格不正确');

    let image = trim(body.image, 500);
    if (image.startsWith('data:image/')) image = await saveBase64Image(image);

    const info = db
      .prepare(
        `INSERT INTO products (category_id, name, price, image, descr, status, sort, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        categoryId,
        name,
        Math.round(price * 100) / 100,
        image,
        trim(body.descr, 300),
        body.status === 0 || body.status === false ? 0 : 1,
        Number.isFinite(Number(body.sort)) ? Number(body.sort) : 0,
        nowIso()
      );
    return sendJson(res, 200, { ok: true, id: Number(info.lastInsertRowid) });
  }

  if (parts[2] === 'products' && parts[3] && method === 'PUT') {
    const id = Number(parts[3]);
    const body = await readJson(req);
    const row = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, '商品不存在');

    const categoryId = body.categoryId === undefined ? row.category_id : Number(body.categoryId);
    const name = body.name === undefined ? row.name : trim(body.name, 60);
    const price = body.price === undefined ? row.price : Number(body.price);
    if (!name) throw new HttpError(400, '商品名称不能为空');
    if (!Number.isFinite(price) || price < 0) throw new HttpError(400, '价格不正确');

    let image = body.image === undefined ? row.image : trim(body.image, 500);
    if (image.startsWith('data:image/')) image = await saveBase64Image(image);

    db.prepare(
      `UPDATE products SET category_id = ?, name = ?, price = ?, image = ?, descr = ?, status = ?, sort = ?
        WHERE id = ?`
    ).run(
      categoryId,
      name,
      Math.round(price * 100) / 100,
      image,
      body.descr === undefined ? row.descr : trim(body.descr, 300),
      body.status === undefined ? row.status : body.status === 0 || body.status === false ? 0 : 1,
      body.sort === undefined ? row.sort : Number(body.sort) || 0,
      id
    );
    return sendJson(res, 200, { ok: true });
  }

  if (parts[2] === 'products' && parts[3] && method === 'DELETE') {
    const id = Number(parts[3]);
    db.prepare('DELETE FROM products WHERE id = ?').run(id);
    return sendJson(res, 200, { ok: true });
  }

  // ---- 后台：单独上传图片 ----
  if (pathname === '/api/admin/upload' && method === 'POST') {
    const body = await readJson(req);
    const url = await saveBase64Image(body.dataUrl);
    return sendJson(res, 200, { ok: true, url });
  }

  // ---- 后台：订单 ----
  if (pathname === '/api/admin/orders' && method === 'GET') {
    const status = url.searchParams.get('status') || '';
    const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 1000);
    const offset = Number(url.searchParams.get('offset')) || 0;
    const rows = orderList({ status, limit, offset }).map((o) => ({
      ...o,
      items: (() => {
        try {
          return JSON.parse(o.items);
        } catch {
          return [];
        }
      })()
    }));
    return sendJson(res, 200, { orders: rows });
  }

  if (parts[2] === 'orders' && parts[3] && method === 'PUT') {
    const id = Number(parts[3]);
    const body = await readJson(req);
    const status = String(body.status || '');
    if (!['pending', 'done', 'cancelled'].includes(status)) {
      throw new HttpError(400, '状态不合法');
    }
    const row = db.prepare('SELECT id, status FROM orders WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, '订单不存在');
    db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), id);
    return sendJson(res, 200, { ok: true });
  }

  // ---- 后台：访客日志 ----
  if (pathname === '/api/admin/logs' && method === 'GET') {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 300, 2000);
    return sendJson(res, 200, { logs: visitorLogs({ limit }) });
  }

  throw new HttpError(404, '接口不存在');
}

// ---------------- 服务器 ----------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  res.setHeader('X-Content-Type-Options', 'nosniff');

  try {
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, url, pathname);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendText(res, 405, 'method not allowed');
    }
    const served = serveStatic(req, res, pathname);
    if (served === false) {
      // 未匹配的页面路径回落到前台（方便直接分享链接）
      if (!path.extname(pathname)) {
        return sendFile(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8') || sendText(res, 404, 'not found');
      }
      return sendText(res, 404, 'not found');
    }
    return;
  } catch (err) {
    if (err instanceof HttpError) {
      return sendJson(res, err.status, { ok: false, message: err.message });
    }
    console.error('[error]', err);
    return sendJson(res, 500, { ok: false, message: '服务器错误：' + (err.message || err) });
  }
});

// ---------------- 首次启动：写入示例数据 ----------------
function seedIfEmpty() {
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM categories').get().c;
  if (cnt > 0) return;

  const now = nowIso();
  const cats = [
    ['生日蛋糕', 1],
    ['甜点小食', 2],
    ['面包吐司', 3],
    ['饮品', 4]
  ];
  const insCat = db.prepare('INSERT INTO categories (name, sort, created_at) VALUES (?, ?, ?)');
  const ids = {};
  for (const [name, sort] of cats) {
    const info = insCat.run(name, sort, now);
    ids[name] = Number(info.lastInsertRowid);
  }

  const prods = [
    ['生日蛋糕', '草莓奶油生日蛋糕 6寸', 128, '新鲜草莓夹层，动物奶油，适合3-5人'],
    ['生日蛋糕', '巧克力慕斯蛋糕 8寸', 168, '比利时可可，浓郁细腻，适合6-8人'],
    ['生日蛋糕', '水果缤纷蛋糕 6寸', 138, '当季水果拼配，清爽不腻'],
    ['甜点小食', '提拉米苏（盒装）', 32, '马斯卡彭芝士，手工制作'],
    ['甜点小食', '蛋挞（4只装）', 18, '现烤酥皮，葡式风味'],
    ['甜点小食', '雪媚娘（3只装）', 26, '软糯外皮，芒果奶油馅'],
    ['面包吐司', '原味吐司 450g', 15, '低糖配方，早餐首选'],
    ['面包吐司', '全麦欧包 350g', 22, '高纤全麦，无添加'],
    ['饮品', '鲜榨橙汁 350ml', 12, '每日现榨'],
    ['饮品', '美式咖啡 中杯', 15, '现磨咖啡豆']
  ];
  const insProd = db.prepare(
    `INSERT INTO products (category_id, name, price, image, descr, status, sort, created_at)
     VALUES (?, ?, ?, '', ?, 1, ?, ?)`
  );
  prods.forEach(([cat, name, price, descr], i) => {
    insProd.run(ids[cat], name, price, descr, i, now);
  });

  // 一条示例订单，方便后台立即看到效果
  const vid = 'demo' + randId(20);
  const items = JSON.stringify([{ id: 1, name: prods[0][1], price: prods[0][2], qty: 1 }]);
  db.prepare(
    `INSERT INTO orders (order_no, visitor_id, name, phone, mode, address, expect_time, amount, count, items, status, remark, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pickup', '', '今天 18:00', ?, 1, ?, 'pending', '示例订单，可删除', ?, ?)`
  ).run(orderNo(), vid, '张女士', '13800000000', prods[0][2], items, now, now);
  db.prepare(
    `INSERT INTO visitor_logs (visitor_id, event, path, referer, ua, ip, extra, created_at)
     VALUES (?, 'view', '/', '', 'seed', '127.0.0.1', '示例访客', ?)`
  ).run(vid, now);

  console.log('[seed] 已写入示例分类/商品/示例订单');
}

seedIfEmpty();

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  🎂 选择蛋糕店 · 扫码选购系统已启动');
  console.log(`  前台：http://localhost:${PORT}/`);
  console.log(`  后台：http://localhost:${PORT}/admin   （密码：${ADMIN_PASSWORD}）`);
  if (PUBLIC_BASE_URL) console.log(`  二维码将指向：${PUBLIC_BASE_URL}/`);
  console.log('');
});

process.on('SIGINT', () => {
  console.log('\nbye');
  process.exit(0);
});
