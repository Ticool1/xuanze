'use strict';
/**
 * 零依赖二维码生成器（字节模式 / 纠错等级 M / 版本 1-10 / 掩码自动择优）
 *
 * 数据表来源：ISO/IEC 18004 及 thonky.com QR Code Tutorial
 *  - 每个版本 M 级的「数据码字数 / 每块纠错码字数 / 分块数」
 *  - 生成多项式用 GF(256) 反推，不硬编码
 *
 * 输出：SVG 字符串（前端直接插入 DOM 即可）
 */

// ---------- GF(256) 运算表 ----------
const GF_EXP = new Array(512);
const GF_LOG = new Array(256);
(function buildGfTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** 生成 degree 次生成多项式（最高次项系数固定为 1，返回值不含最高次项） */
function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly; // 长度 degree+1，poly[0] === 1
}

/** 对 data 计算 ecLen 个纠错码字 */
function rsRemainder(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const res = new Array(ecLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.shift();
    res.push(0);
    for (let i = 0; i < ecLen; i++) res[i] ^= gfMul(gen[i + 1], factor);
  }
  return res;
}

// ---------- M 级（版本 1-10）码字布局 ----------
// [数据码字总数, 每块纠错码字数, 块数]
const EC_M = {
  1: [16, 10, 1],
  2: [28, 16, 1],
  3: [44, 26, 1],
  4: [64, 18, 2],
  5: [86, 24, 2],
  6: [108, 16, 4],
  7: [124, 18, 4],
  8: [154, 22, 4],
  9: [182, 22, 5],
  10: [216, 26, 5]
};

// 各版本剩余比特数（用于计算总模块数，校验用）
const TOTAL_CODEWORDS = { 1: 26, 2: 44, 3: 70, 4: 100, 5: 134, 6: 172, 7: 196, 8: 242, 9: 292, 10: 346 };

// 对齐图形中心位置（M 级、版本 1-10）
const ALIGN_POSITIONS = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50]
};

// 格式信息：纠错等级编码 M = 0b00
const FORMAT_EC_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

// 版本信息（版本 7 及以上需要）
const VERSION_INFO = {
  7: 0x07c94,
  8: 0x085bc,
  9: 0x09a99,
  10: 0x0a4d3
};

function maxBytesFor(version) {
  const [dataCodewords] = EC_M[version];
  // 模式指示符 4 bit + 字符计数（版本<=9 为 8 bit，>=10 为 16 bit）
  const countBits = version <= 9 ? 8 : 16;
  return Math.floor((dataCodewords * 8 - 4 - countBits) / 8);
}

class QrCode {
  constructor(text) {
    this.text = text == null ? '' : String(text);
    this.bytes = Buffer.from(this.text, 'utf8');

    let version = 0;
    for (let v = 1; v <= 10; v++) {
      if (this.bytes.length <= maxBytesFor(v)) {
        version = v;
        break;
      }
    }
    if (!version) {
      throw new Error(`内容过长，无法生成二维码（当前 ${this.bytes.length} 字节，最多 213 字节）`);
    }

    this.version = version;
    this.size = version * 4 + 17;

    // 校验码字表自洽
    const [dataCw, ecPerBlock, blocks] = EC_M[version];
    if (dataCw + ecPerBlock * blocks !== TOTAL_CODEWORDS[version]) {
      throw new Error(`内部错误：版本 ${version} 码字表不自洽`);
    }

    this.build();
  }

  // ------- 构建矩阵 -------
  build() {
    const size = this.size;
    this.modules = Array.from({ length: size }, () => new Array(size).fill(false));
    this.reserved = Array.from({ length: size }, () => new Array(size).fill(false));

    this.placeFunctionPatterns();
    const codewords = this.buildCodewords();
    this.placeData(codewords);

    // 掩码择优
    let best = null;
    for (let mask = 0; mask < 8; mask++) {
      const m = this.modules.map((row) => row.slice());
      this.applyMask(m, mask);
      this.placeFormatAndVersion(m, mask);
      const score = penalty(m);
      if (!best || score < best.score) best = { mask, matrix: m, score };
    }
    this.mask = best.mask;
    this.modules = best.matrix;
    this.penaltyScore = best.score;
  }

  placeFunctionPatterns() {
    const size = this.size;
    const set = (x, y, v) => {
      this.modules[y][x] = v;
      this.reserved[y][x] = true;
    };

    // 三个定位图形（含分隔符）
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          const ax = Math.abs(dx);
          const ay = Math.abs(dy);
          const dark = ax <= 3 && ay <= 3 && (ax === 3 || ay === 3 || (ax <= 1 && ay <= 1));
          set(x, y, dark);
        }
      }
    };
    finder(3, 3);
    finder(size - 4, 3);
    finder(3, size - 4);

    // 时序图形
    for (let i = 8; i < size - 8; i++) {
      set(i, 6, i % 2 === 0);
      set(6, i, i % 2 === 0);
    }

    // 对齐图形
    const positions = ALIGN_POSITIONS[this.version] || [];
    for (const cy of positions) {
      for (const cx of positions) {
        // 与定位图形重叠的跳过
        if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const ring = Math.max(Math.abs(dx), Math.abs(dy));
            set(cx + dx, cy + dy, ring !== 1);
          }
        }
      }
    }

    // 预留格式信息区域
    for (let i = 0; i <= 8; i++) {
      if (!this.reserved[8][i]) set(i, 8, false);
      if (!this.reserved[i][8]) set(8, i, false);
    }
    for (let i = 0; i < 8; i++) {
      if (!this.reserved[8][size - 1 - i]) set(size - 1 - i, 8, false);
      if (!this.reserved[size - 1 - i][8]) set(8, size - 1 - i, false);
    }
    // 暗模块
    set(8, size - 8, true);

    // 版本信息区域（版本 >= 7）
    if (this.version >= 7) {
      for (let i = 0; i < 6; i++) {
        for (let j = 0; j < 3; j++) {
          set(size - 11 + j, i, false);
          set(i, size - 11 + j, false);
        }
      }
    }
  }

  buildCodewords() {
    const [dataCw, ecPerBlock, blocks] = EC_M[this.version];
    const capacityBits = dataCw * 8;

    const bits = [];
    const push = (value, len) => {
      for (let i = len - 1; i >= 0; i--) bits.push(((value >> i) & 1) === 1);
    };

    // 模式指示符：字节模式 0100
    push(0b0100, 4);
    // 字符计数
    push(this.bytes.length, this.version <= 9 ? 8 : 16);
    // 数据
    for (const b of this.bytes) push(b, 8);

    // 终止符
    const termLen = Math.min(4, capacityBits - bits.length);
    push(0, termLen);
    // 补齐到字节
    while (bits.length % 8 !== 0) bits.push(false);

    // 填充字节 0xEC / 0x11
    const pads = [0xec, 0x11];
    let p = 0;
    while (bits.length < capacityBits) {
      push(pads[p++ % 2], 8);
    }

    const dataBytes = [];
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i + j] ? 1 : 0);
      dataBytes.push(byte);
    }

    // 分块（M 级：块大小差 1，块数少的前面块较短）
    const blockLens = [];
    const totalCw = dataCw;
    const baseLen = Math.floor(totalCw / blocks);
    const extra = totalCw % blocks;
    for (let i = 0; i < blocks; i++) blockLens.push(baseLen + (i < blocks - extra ? 0 : 0) + (i >= blocks - extra ? 1 : 0));

    const dataBlocks = [];
    const ecBlocks = [];
    let offset = 0;
    for (let i = 0; i < blocks; i++) {
      const chunk = dataBytes.slice(offset, offset + blockLens[i]);
      offset += blockLens[i];
      dataBlocks.push(chunk);
      ecBlocks.push(rsRemainder(chunk, ecPerBlock));
    }

    // 交错
    const out = [];
    const maxLen = Math.max(...dataBlocks.map((b) => b.length));
    for (let i = 0; i < maxLen; i++) {
      for (const b of dataBlocks) {
        if (i < b.length) out.push(b[i]);
      }
    }
    for (let i = 0; i < ecPerBlock; i++) {
      for (const b of ecBlocks) out.push(b[i]);
    }
    return out;
  }

  placeData(codewords) {
    const size = this.size;
    const totalBits = codewords.length * 8;
    let bitIndex = 0;
    let upward = true;

    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // 跳过第 6 列（纵向时序）
      const rows = upward
        ? Array.from({ length: size }, (_, i) => size - 1 - i)
        : Array.from({ length: size }, (_, i) => i);

      for (const y of rows) {
        for (let c = 0; c < 2; c++) {
          const x = right - c;
          if (this.reserved[y][x]) continue;
          let bit = false;
          if (bitIndex < totalBits) {
            const byte = codewords[bitIndex >> 3];
            bit = ((byte >> (7 - (bitIndex & 7))) & 1) === 1;
          }
          this.modules[y][x] = bit;
          bitIndex++;
        }
      }
      upward = !upward;
    }

    // 冻结功能图形位置，供掩码阶段判断
    this.functionMask = this.reserved.map((row) => row.slice());
  }

  applyMask(m, mask) {
    const size = this.size;
    // 掩码只作用于数据区（非功能图形）；此处用原始 reserved 判断
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (this.isFunctionModule(x, y)) continue;
        let invert = false;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: break;
        }
        if (invert) m[y][x] = !m[y][x];
      }
    }
  }

  /** 判断是否为功能图形模块（定位/时序/对齐/格式/版本/暗模块） */
  isFunctionModule(x, y) {
    return this.functionMask ? this.functionMask[y][x] : false;
  }

  placeFormatAndVersion(m, mask) {
    const size = this.size;

    // ---- 格式信息：5 bit（2 bit 纠错等级 + 3 bit 掩码）+ 10 bit BCH，异或 0x5412 ----
    const ecBits = FORMAT_EC_BITS.M; // 0b00
    const data = (ecBits << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = ((rem << 1) ^ ((rem >> 9) * 0x537)) & 0x3ff;
    const formatBits = ((data << 10) | rem) ^ 0x5412;

    // QR 规范中格式信息按 bit14→bit0 的顺序依次放置，即「先放最高位」
    const bitAt = (idx) => ((formatBits >> (14 - idx)) & 1) === 1;

    // ---- 左上角：沿第 8 行（左→右，跳过第 6 列时序）----
    // 顺序：col 0..5 -> bit0..bit5；col 7 -> bit6；col 8 -> bit7
    for (let i = 0; i <= 5; i++) m[8][i] = bitAt(i);
    m[8][7] = bitAt(6);
    m[8][8] = bitAt(7);
    // ---- 左上角：沿第 8 列（上→下）----
    // order: row7 -> bit8; row5..row0 -> bit9..bit14
    m[7][8] = bitAt(8);
    for (let i = 9; i <= 14; i++) m[14 - i][8] = bitAt(i);

    // ---- 右上角：沿第 8 行（右→左）bit14..bit8 ----
    for (let i = 8; i <= 14; i++) m[8][size - 15 + i] = bitAt(i);
    // ---- 左下角：沿第 8 列（下→上）bit7..bit0 ----
    for (let i = 0; i <= 7; i++) m[size - 1 - i][8] = bitAt(i);
    // 左下角的第 8 行第 (size-8) 位是暗模块，单独占位，不写格式位

    // ---- 版本信息（版本 >= 7）：18 bit ----
    if (this.version >= 7) {
      const vInfo = VERSION_INFO[this.version];
      if (vInfo == null) throw new Error(`缺少版本 ${this.version} 的版本信息表`);
      for (let i = 0; i < 18; i++) {
        const v = ((vInfo >> i) & 1) === 1;
        const a = Math.floor(i / 3);
        const b = i % 3;
        m[size - 11 + b][a] = v;
        m[a][size - 11 + b] = v;
      }
    }
  }

  toSvg(scale = 8, margin = 4) {
    const n = this.size;
    const total = (n + margin * 2) * scale;
    let path = '';
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (!this.modules[y][x]) continue;
        path += `M${(x + margin) * scale} ${(y + margin) * scale}h${scale}v${scale}h-${scale}z`;
      }
    }
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${total}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">` +
      `<rect width="100%" height="100%" fill="#ffffff"/>` +
      `<path d="${path}" fill="#000000"/>` +
      `</svg>`
    );
  }
}

/** 掩码罚分（ISO 18004 规则 1/2/4） */
function penalty(m) {
  const n = m.length;
  let score = 0;

  const runScore = (run) => (run >= 5 ? 3 + (run - 5) : 0);

  // 规则 1：行/列连续同色
  for (let y = 0; y < n; y++) {
    let run = 1;
    for (let x = 1; x < n; x++) {
      if (m[y][x] === m[y][x - 1]) run++;
      else {
        score += runScore(run);
        run = 1;
      }
    }
    score += runScore(run);
  }
  for (let x = 0; x < n; x++) {
    let run = 1;
    for (let y = 1; y < n; y++) {
      if (m[y][x] === m[y - 1][x]) run++;
      else {
        score += runScore(run);
        run = 1;
      }
    }
    score += runScore(run);
  }

  // 规则 2：2x2 同色块
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const v = m[y][x];
      if (v === m[y][x + 1] && v === m[y + 1][x] && v === m[y + 1][x + 1]) score += 3;
    }
  }

  // 规则 4：暗模块比例
  let dark = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) dark++;
  const percent = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

module.exports = { QrCode, EC_M, maxBytesFor, rsRemainder, rsGenerator };
