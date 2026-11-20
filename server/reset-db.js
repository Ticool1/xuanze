'use strict';
// 重置数据库到干净的示例数据状态（用于开发自测）
const fs = require('node:fs');
const path = require('node:path');

const dataDir = path.join(__dirname, '..', 'data');
for (const f of ['shop.db', 'shop.db-wal', 'shop.db-shm']) {
  const p = path.join(dataDir, f);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
const uploads = path.join(dataDir, 'uploads');
if (fs.existsSync(uploads)) {
  for (const f of fs.readdirSync(uploads)) fs.unlinkSync(path.join(uploads, f));
}
console.log('已清空数据库和上传目录，重启服务后会重新写入示例数据。');
