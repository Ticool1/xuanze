'use strict';
// 清理测试数据（脚本内联在 -e 里容易被转义影响，这里单独成文件）
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('data/shop.db');
db.exec('PRAGMA foreign_keys=ON');

const badPattern = '%?%';
db.prepare('DELETE FROM products WHERE name LIKE ?').run(badPattern);
db.prepare('DELETE FROM products WHERE name = ?').run('测试蛋糕');
db.prepare('DELETE FROM categories WHERE name LIKE ?').run(badPattern);
db.prepare('DELETE FROM categories WHERE name = ?').run('测试分类');
db.prepare('DELETE FROM orders WHERE name LIKE ?').run(badPattern);
db.prepare('DELETE FROM orders WHERE name = ?').run('???');
db.prepare('DELETE FROM customers WHERE name LIKE ?').run(badPattern);
db.prepare('DELETE FROM visitor_logs WHERE extra LIKE ?').run('%测试%');

console.log('products:', db.prepare('SELECT COUNT(*) c FROM products').get().c);
console.log('categories:', db.prepare('SELECT COUNT(*) c FROM categories').get().c);
console.log('orders:', db.prepare('SELECT COUNT(*) c FROM orders').get().c);
