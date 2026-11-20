'use strict';
/**
 * 二维码实现对照测试：把我的实现与成熟开源实现 qrcode-generator 的输出逐位比对。
 * 用法：node tools/compare-qr.js
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { QrCode } = require('../server/qrcode');

// 加载参考实现（UMD，在 vm 里跑，导出到 module.exports）
const refSrc = fs.readFileSync(path.join(__dirname, 'vendor', 'qrcode-generator.js'), 'utf8');
const sandbox = { module: { exports: {} }, exports: {}, console };
sandbox.module.exports = sandbox.exports;
vm.createContext(sandbox);
vm.runInContext(refSrc, sandbox);
const qrcodeRef = sandbox.module.exports;

const CASES = [
  'hi',
  'https://example.com/',
  'http://127.0.0.1:3111/',
  'https://t.cn/xuanze-demo-2026',
  'https://shop.example.com/?v=0123456789abcdef',
  'https://dianpu.example.cn/order/qrcode/abc-123-def-456-ghi-789'
];

function refMatrix(text, typeNumber, ecLevel) {
  const qr = qrcodeRef(typeNumber, ecLevel);
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const out = [];
  for (let y = 0; y < n; y++) {
    const row = [];
    for (let x = 0; x < n; x++) row.push(qr.isDark(y, x));
    out.push(row);
  }
  return { matrix: out, size: n };
}

/** 从矩阵读取格式信息，得到参考库实际使用的掩码 */
function readMask(matrix, size) {
  const seq = [];
  for (let i = 0; i <= 5; i++) seq.push(matrix[8][i] ? 1 : 0);
  seq.push(matrix[8][7] ? 1 : 0);
  seq.push(matrix[8][8] ? 1 : 0);
  seq.push(matrix[7][8] ? 1 : 0);
  for (let i = 9; i <= 14; i++) seq.push(matrix[14 - i][8] ? 1 : 0);
  const fmt = seq.reduce((a, b) => (a << 1) | b, 0);
  const unmasked = fmt ^ 0x5412;
  return { mask: unmasked & 0b111, ec: (unmasked >> 3) & 0b11 };
}

let pass = 0;
let fail = 0;

for (const text of CASES) {
  const mine = new QrCode(text);
  const ref = refMatrix(text, mine.version, 'M');
  const refFmt = readMask(ref.matrix, ref.size);
  const sizeOk = mine.size === ref.size;

  let diff = 0;
  let diffInData = 0;
  if (sizeOk) {
    for (let y = 0; y < mine.size; y++) {
      for (let x = 0; x < mine.size; x++) {
        if (mine.modules[y][x] !== ref.matrix[y][x]) {
          diff++;
          if (!mine.functionMask[y][x]) diffInData++;
        }
      }
    }
  }

  const ok = sizeOk && diff === 0;
  if (ok) pass++;
  else fail++;
  console.log(
    `${ok ? '✅' : '❌'} ${JSON.stringify(text).padEnd(56)} v${mine.version} ` +
      `我:mask${mine.mask} 参考:mask${refFmt.mask} ` +
      (sizeOk ? `差异 ${diff}（数据区 ${diffInData}）` : `尺寸 ${mine.size} vs ${ref.size}`)
  );

  if (!ok && diff > 0 && process.env.SHOW_DIFF) {
    console.log('  功能图形差异明细：');
    let shown = 0;
    for (let y = 0; y < mine.size && shown < 24; y++) {
      for (let x = 0; x < mine.size && shown < 24; x++) {
        if (!mine.functionMask[y][x]) continue;
        if (mine.modules[y][x] !== ref.matrix[y][x]) {
          console.log(`    (${x},${y}) 我=${mine.modules[y][x] ? '#' : '.'} 参考=${ref.matrix[y][x] ? '#' : '.'}`);
          shown++;
        }
      }
    }
  }
}

console.log(`\n对照结果：完全一致 ${pass} 项，不一致 ${fail} 项`);
process.exitCode = fail ? 1 : 0;
