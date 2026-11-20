'use strict';
// 清理线上测试数据
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/opt/xuanze/data/shop.db');
db.exec('PRAGMA foreign_keys=ON');

const count = () => ({
  orders: db.prepare('SELECT COUNT(*) c FROM orders').get().c,
  products: db.prepare('SELECT COUNT(*) c FROM products').get().c,
  categories: db.prepare('SELECT COUNT(*) c FROM categories').get().c,
  logs: db.prepare('SELECT COUNT(*) c FROM visitor_logs').get().c,
  customers: db.prepare('SELECT COUNT(*) c FROM customers').get().c,
});

console.log('清理前:', JSON.stringify(count()));

const testNames = ['赵女士', '王先生', '李女士', '张女士', '测试'];
for (const name of testNames) {
  db.prepare('DELETE FROM orders WHERE name = ?').run(name);
  db.prepare('DELETE FROM customers WHERE name = ?').run(name);
}
db.prepare('DELETE FROM orders WHERE remark = ?').run('示例订单，可删除');

db.prepare('DELETE FROM products WHERE name LIKE ?').run('%月饼%');
db.prepare('DELETE FROM products WHERE name = ?').run('调试商品');
db.prepare('DELETE FROM products WHERE name = ?').run('测试蛋糕');
for (const n of ['节日礼盒', '调试分类', '测试分类']) {
  db.prepare('DELETE FROM categories WHERE name = ?').run(n);
}

db.prepare('DELETE FROM visitor_logs').run();

console.log('清理后:', JSON.stringify(count()));
console.log('');
console.log('剩余分类:');
for (const r of db.prepare('SELECT id, name FROM categories ORDER BY sort').all()) {
  console.log('  ' + r.id + '. ' + r.name);
}
console.log('');
console.log('剩余商品:');
for (const r of db.prepare('SELECT id, name, price, status FROM products ORDER BY category_id, sort').all()) {
  console.log('  ' + r.id + '. ' + r.name + '  ¥' + r.price + '  ' + (r.status ? '上架' : '下架'));
}
