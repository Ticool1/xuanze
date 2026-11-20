'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(ROOT, 'public');

for (const dir of [DATA_DIR, UPLOAD_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

function hasFlag(name) {
  return process.argv.includes(name);
}

// ---------------- 数据库 ----------------
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(path.join(DATA_DIR, 'shop.db'));

try {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 3000');
  db.exec('PRAGMA foreign_keys = ON');
} catch (_) {
  /* ignore */
}

db.exec(`
CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  price       REAL    NOT NULL DEFAULT 0,
  image       TEXT    NOT NULL DEFAULT '',
  descr       TEXT    NOT NULL DEFAULT '',
  status      INTEGER NOT NULL DEFAULT 1,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  visitor_id TEXT    NOT NULL UNIQUE,
  name       TEXT    NOT NULL DEFAULT '',
  phone      TEXT    NOT NULL DEFAULT '',
  updated_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no     TEXT    NOT NULL UNIQUE,
  visitor_id   TEXT    NOT NULL DEFAULT '',
  name         TEXT    NOT NULL,
  phone        TEXT    NOT NULL,
  mode         TEXT    NOT NULL DEFAULT 'delivery',
  address      TEXT    NOT NULL DEFAULT '',
  expect_time  TEXT    NOT NULL DEFAULT '',
  amount       REAL    NOT NULL DEFAULT 0,
  count        INTEGER NOT NULL DEFAULT 0,
  items        TEXT    NOT NULL DEFAULT '[]',
  status       TEXT    NOT NULL DEFAULT 'pending',
  remark       TEXT    NOT NULL DEFAULT '',
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS visitor_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  visitor_id TEXT    NOT NULL,
  event      TEXT    NOT NULL,
  path       TEXT    NOT NULL DEFAULT '',
  referer    TEXT    NOT NULL DEFAULT '',
  ua         TEXT    NOT NULL DEFAULT '',
  ip         TEXT    NOT NULL DEFAULT '',
  extra      TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_visitor_logs_vid  ON visitor_logs(visitor_id);
CREATE INDEX IF NOT EXISTS idx_visitor_logs_time ON visitor_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_time       ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_products_cat      ON products(category_id);
`);

// ---------------- 时间工具（统一北京时间） ----------------
const TZ = 'Asia/Shanghai';

function nowIso() {
  return new Date().toISOString();
}

const fmt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
});

function beijingParts(date = new Date()) {
  const parts = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  return parts;
}

function todayStartIso() {
  const p = beijingParts();
  return new Date(`${p.year}-${p.month}-${p.day}T00:00:00+08:00`).toISOString();
}

function daysAgoIso(days) {
  const p = beijingParts();
  const base = new Date(`${p.year}-${p.month}-${p.day}T00:00:00+08:00`);
  base.setDate(base.getDate() - days);
  return base.toISOString();
}

// ---------------- 工具 ----------------
function randId(len = 16) {
  return crypto.randomBytes(len).toString('hex').slice(0, len);
}

function orderNo() {
  const p = beijingParts();
  const stamp = `${p.year}${p.month}${p.day}${p.hour}${p.minute}${p.second}`;
  return `XZ${stamp}${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
}

function guestSvg(size = 400) {
  const s = size;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}">` +
      `<rect width="100%" height="100%" fill="#f3f5f9"/>` +
      `<text x="50%" y="50%" font-size="${Math.round(s / 8)}" fill="#b9c2d0" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif">暂无图片</text>` +
      `</svg>`
  );
}

// 二维码生成器已抽到 ./qrcode.js（表数据经过规范校验，可被扫码器真实解码）
const { QrCode } = require('./qrcode');

module.exports = {
  db,
  nowIso,
  beijingParts,
  todayStartIso,
  daysAgoIso,
  randId,
  orderNo,
  guestSvg,
  QrCode,
  ROOT,
  DATA_DIR,
  UPLOAD_DIR,
  PUBLIC_DIR,
  hasFlag,
  fs,
  path
};
