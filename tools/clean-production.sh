#!/usr/bin/env bash
# 娓呯悊绾夸笂娴嬭瘯鏁版嵁锛氬垹闄ゆ祴璇曡鍗曘€佹祴璇曞垎绫?鍟嗗搧銆佽瀹㈡棩蹇楋紝淇濈暀绀轰緥鍟嗗搧
set -uo pipefail
APP=/opt/xuanze
cd "$APP" || exit 1

node - <<'NODE'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/opt/xuanze/data/shop.db');
db.exec('PRAGMA foreign_keys=ON');

const before = {
  orders: db.prepare('SELECT COUNT(*) c FROM orders').get().c,
  products: db.prepare('SELECT COUNT(*) c FROM products').get().c,
  categories: db.prepare('SELECT COUNT(*) c FROM categories').get().c,
  logs: db.prepare('SELECT COUNT(*) c FROM visitor_logs').get().c,
  customers: db.prepare('SELECT COUNT(*) c FROM customers').get().c,
};

// 娴嬭瘯璁㈠崟锛氳档濂冲＋ / 娴嬭瘯璁垮
for (const name of ['璧靛コ澹?, '鐜嬪厛鐢?, '鏉庡コ澹?, '寮犲コ澹?, '娴嬭瘯']) {
  db.prepare('DELETE FROM orders WHERE name = ?').run(name);
  db.prepare('DELETE FROM customers WHERE name = ?').run(name);
}
db.prepare('DELETE FROM orders WHERE remark = ?').run('绀轰緥璁㈠崟锛屽彲鍒犻櫎');

// 娴嬭瘯鍒嗙被涓庡晢鍝?db.prepare('DELETE FROM products WHERE name LIKE ?').run('%鏈堥ゼ%');
db.prepare('DELETE FROM products WHERE name = ?').run('璋冭瘯鍟嗗搧');
db.prepare('DELETE FROM products WHERE name = ?').run('娴嬭瘯铔嬬硶');
db.prepare('DELETE FROM categories WHERE name IN (?,?,?)').run('鑺傛棩绀肩洅', '璋冭瘯鍒嗙被', '娴嬭瘯鍒嗙被');

// 璁垮鏃ュ織鍏ㄦ竻锛堥兘鏄祴璇曚骇鐢熺殑锛?db.prepare('DELETE FROM visitor_logs').run();

const after = {
  orders: db.prepare('SELECT COUNT(*) c FROM orders').get().c,
  products: db.prepare('SELECT COUNT(*) c FROM products').get().c,
  categories: db.prepare('SELECT COUNT(*) c FROM categories').get().c,
  logs: db.prepare('SELECT COUNT(*) c FROM visitor_logs').get().c,
  customers: db.prepare('SELECT COUNT(*) c FROM customers').get().c,
};

console.log('娓呯悊鍓?', JSON.stringify(before));
console.log('娓呯悊鍚?', JSON.stringify(after));
console.log('');
console.log('鍓╀綑鍒嗙被:');
for (const r of db.prepare('SELECT id, name FROM categories ORDER BY sort').all()) {
  console.log(`  ${r.id}. ${r.name}`);
}
NODE

# 娓呯悊瀛ょ珛鐨勪笂浼犲浘鐗囷紙娴嬭瘯鍥剧墖锛?echo ""
echo "=== 涓婁紶鐩綍 ==="
ls -la "$APP/data/uploads" 2>/dev/null | head -20
