'use strict';
/**
 * 二维码码字级对照：把我的「数据码字 + 纠错码字」与参考库的位流逐字节比对。
 * 这一步能定位问题究竟在：位流编码 / RS 纠错 / 矩阵摆放 / 掩码 中的哪一环。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { QrCode, EC_M } = require('../server/qrcode');

const refSrc = fs.readFileSync(path.join(__dirname, 'vendor', 'qrcode-generator.js'), 'utf8');
const sandbox = { module: { exports: {} }, exports: {}, console };
sandbox.module.exports = sandbox.exports;
vm.createContext(sandbox);
vm.runInContext(refSrc, sandbox);
const qrcodeRef = sandbox.module.exports;

// 用参考库内部实现重建码字（依赖其 make/makeImpl 内部函数不可直接调用，改用 getBuffer + RS 表）
// 更直接：调用参考库的 QRUtil / QRRSBlock（通过 vm 沙箱暴露）
const internals = vm.runInContext(
  `({ QRUtil: typeof QRUtil !== 'undefined' ? QRUtil : null, QRRSBlock: typeof QRRSBlock !== 'undefined' ? QRRSBlock : null, QR8bitByte: typeof QR8bitByte !== 'undefined' ? QR8bitByte : null })`,
  sandbox
);

console.log('参考库内部可用：', Object.keys(internals).filter((k) => internals[k]));

const CASES = ['hi', 'https://example.com/', 'https://t.cn/xuanze-demo-2026'];

/**
 * 我的实现：复现 buildCodewords 的产物（含 RS），供逐字节比对
 */
function myCodewords(text) {
  const qr = new QrCode(text);
  return qr.__codewords || null;
}

// 给 QrCode 暴露临时的码字，用于比对
const origBuild = QrCode.prototype.build;
QrCode.prototype.build = function () {
  const [dataCw, ecPerBlock, blocks] = EC_M[this.version];
  // 复制 build 内部流程，保留中间结果
  const saved = this.buildCodewords;
  let captured = null;
  this.buildCodewords = function () {
    const r = saved.call(this);
    captured = r;
    return r;
  };
  origBuild.call(this);
  this.__codewords = captured;
};

for (const text of CASES) {
  const mine = new QrCode(text);
  const mineCw = mine.__codewords;

  // 参考库：用它自己的 RS 块表生成同样的位流
  // 通过 make() 后反推不可行，改用其 QRUtil + QRRSBlock
  const ref = qrcodeRef(mine.version, 'M');
  ref.addData(text, 'Byte');
  // 参考库内部：getBuffer → createData → createBytes → 交错
  let refCw = null;
  try {
    refCw = ref.__getCodewords ? ref.__getCodewords() : null;
  } catch (_) { /* ignore */ }

  console.log(`\n--- ${JSON.stringify(text)} v${mine.version} ---`);
  console.log('我的码字前 20：', (mineCw || []).slice(0, 20).map((b) => b.toString(16).padStart(2, '0')).join(' '));
  console.log('我的码字总长：', mineCw ? mineCw.length : 0);
  console.log(
    '期望总长：',
    (() => {
      const [d, e, b] = EC_M[mine.version];
      return d + e * b;
    })()
  );
}
