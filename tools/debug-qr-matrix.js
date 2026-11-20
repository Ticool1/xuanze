'use strict';
/**
 * 定位二维码矩阵错误：
 * 1) 校验功能图形（定位/时序/对齐/暗模块）是否与参考一致
 * 2) 把「数据区」按 Z 字形读回，还原成码字，检查是否等于 buildCodewords 的结果
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { QrCode } = require('../server/qrcode');

const refSrc = fs.readFileSync(path.join(__dirname, 'vendor', 'qrcode-generator.js'), 'utf8');
const sandbox = { module: { exports: {} }, exports: {}, console };
sandbox.module.exports = sandbox.exports;
vm.createContext(sandbox);
vm.runInContext(refSrc, sandbox);
const qrcodeRef = sandbox.module.exports;

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

const text = process.argv[2] || 'hi';
const mine = new QrCode(text);
const ref = refMatrix(text, mine.version, 'M');
const n = mine.size;

console.log(`文本 ${JSON.stringify(text)} v${mine.version} mask${mine.mask} size ${n}`);

// ---- 1. 功能图形差异 ----
console.log('\n[1] 功能图形差异（我 vs 参考）：');
let funcDiff = 0;
for (let y = 0; y < n; y++) {
  for (let x = 0; x < n; x++) {
    if (!mine.functionMask[y][x]) continue;
    if (mine.modules[y][x] !== ref.matrix[y][x]) {
      funcDiff++;
      if (funcDiff <= 20) console.log(`    功能模块 (${x},${y}) 我=${mine.modules[y][x] ? '#' : '.'} 参考=${ref.matrix[y][x] ? '#' : '.'}`);
    }
  }
}
console.log(`    功能模块差异总数：${funcDiff}`);

// ---- 2. 数据区回读 ----
/**
 * 按 QR 规范的 Z 字形顺序读回数据位，然后按掩码逆变换还原真实位
 */
function readDataBits(matrix, funcMask, size, mask) {
  const bits = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const rows = upward
      ? Array.from({ length: size }, (_, i) => size - 1 - i)
      : Array.from({ length: size }, (_, i) => i);
    for (const y of rows) {
      for (let c = 0; c < 2; c++) {
        const x = right - c;
        if (funcMask[y][x]) continue;
        let v = matrix[y][x];
        // 逆掩码
        let inv = false;
        switch (mask) {
          case 0: inv = (x + y) % 2 === 0; break;
          case 1: inv = y % 2 === 0; break;
          case 2: inv = x % 3 === 0; break;
          case 3: inv = (x + y) % 3 === 0; break;
          case 4: inv = (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0; break;
          case 5: inv = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: inv = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          case 7: inv = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: break;
        }
        if (inv) v = !v;
        bits.push(v);
      }
    }
    upward = !upward;
  }
  return bits;
}

const myBits = readDataBits(mine.modules, mine.functionMask, n, mine.mask);
const refBits = readDataBits(ref.matrix, mine.functionMask, n, mine.mask);

function bitsToBytes(bits) {
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i + j] ? 1 : 0);
    out.push(b);
  }
  return out;
}

const myBytes = bitsToBytes(myBits);
const refBytes = bitsToBytes(refBits);

console.log('\n[2] 从矩阵回读的数据码字：');
console.log('    我  ：', myBytes.slice(0, 20).map((b) => b.toString(16).padStart(2, '0')).join(' '));
console.log('    参考：', refBytes.slice(0, 20).map((b) => b.toString(16).padStart(2, '0')).join(' '));

const expect = mine.__codewords || [];
console.log('\n[3] buildCodewords 生成的码字：');
console.log('    我  ：', expect.slice(0, 20).map((b) => b.toString(16).padStart(2, '0')).join(' '));

let mismatch = 0;
for (let i = 0; i < Math.min(myBytes.length, expect.length); i++) {
  if (myBytes[i] !== expect[i]) mismatch++;
}
console.log(`\n[4] 回读 vs 生成 的码字不一致数量：${mismatch} / ${expect.length}`);

// 数据区模块总数是否够放所有码字
const totalDataModules = mine.functionMask.flat().filter((v) => !v).length;
const [d, e, b] = require('../server/qrcode').EC_M[mine.version];
console.log(`[5] 可用数据模块数：${totalDataModules}，码字总比特：${(d + e * b) * 8}`);
