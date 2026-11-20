# 选择蛋糕店 · 扫码选购系统

个人玩的小店选购系统：**后台配置商品 → 生成二维码 → 顾客扫码选购下单 → 后台订单管理 + 访客日志**。

零第三方运行时依赖，只需 Node.js ≥ 22.5（内置 `node:sqlite`）。

---

## 功能

### 前台（顾客扫码进入）
- 左上角 LOGO、店铺名「选择蛋糕店」+ 底部手机号 `17310076421`（可点击拨号）
- 左侧分类侧边栏，右侧展示当前分类商品（图片 / 名称 / 描述 / 价格）
- 每张商品卡右下角 `＋` 加入购物车，已加购显示数量
- 底部购物车条：**左侧 80%** 显示已选件数与当前总金额，点击展开明细抽屉可增减/清空；**右侧 20%** 为「去结算」
- 商品数量、金额持久化在浏览器 localStorage，刷新不丢

### 结算页
- 显示已选商品明细、数量、总金额
- 表单：**怎么称呼您**、**您的手机号**、交货方式（**配送 / 自取**）
  - 选「配送」→ 显示**收货地址（必填）**，时间字段为「**期望送达时间**」
  - 选「自取」→ 隐藏地址，时间字段变为「**预计提取时间**」
  - 备注（选填）
- **信息填完整后提交按钮才可点击**（姓名/手机号格式/地址/时间逐项校验）
- 提交成功显示订单号（不做线上支付）

### 后台（`/admin`，默认密码 `admin123`）
- **商品管理**：分类增删改、商品增删改（名称 / 图片上传 / 价格 / 描述 / 排序 / 上下架）
- **打开前台**入口 + 右侧**二维码按钮**（点击展开二维码，手机扫码即可进入前台，可复制链接 / 新窗口打开 / 下载 SVG）
- **订单管理**：订单号、称呼、手机号、交货方式、收货地址、预计时间、金额、状态；操作「**完成**」「**取消**」（可恢复待处理），点「详情」看商品明细
- **访客日志**：记录谁在什么时间**浏览**了、什么时间**下单**了，含 IP、设备、访问路径
- **收益汇总**：累计收益、**当天**、**最近 7 天**、**最近 30 天**

### 访客唯一标识与信息自动填充
- 顾客首次扫码即获得 `xz_vid` cookie（随机 24 位十六进制，有效期 1 年）
- 该标识同时写入访客日志与订单，可在后台把「浏览 → 下单」串成同一个人
- 下单时记住的姓名/手机号，下次同一访客打开结算页会**自动填入**

---

## 快速开始（本地）

```bash
# 1. 需要 Node >= 22.5
node -v

# 2. 启动（无需 npm install）
npm start
# 或
node server/app.js

# 3. 打开
# 前台：http://localhost:3000/
# 后台：http://localhost:3000/admin   （密码 admin123）
```

首次启动会自动建库 `data/shop.db` 并写入示例分类/商品/订单。

---

## 配置

复制 `.env.example` 为 `.env` 后修改：

| 变量 | 说明 | 默认 |
|---|---|---|
| `PORT` | 监听端口 | `3000` |
| `HOST` | 监听地址 | `0.0.0.0` |
| `ADMIN_PASSWORD` | 后台密码 | `admin123`（**上线必改**） |
| `SESSION_SECRET` | 会话签名密钥 | 随机（**上线请固定**） |
| `PUBLIC_BASE_URL` | 二维码指向的地址 | 空（用请求的 Host） |
| `SHOP_NAME` / `SHOP_PHONE` | 店铺名 / 电话 | 选择蛋糕店 / 17310076421 |
| `COS_*` | 腾讯云 COS（可选） | 关闭 |

### 关于 PUBLIC_BASE_URL（重要）

二维码内容就是这个地址。**如果填 `127.0.0.1/localhost`，手机扫了打不开。** 上线时填服务器公网 IP 或域名：

```bash
PUBLIC_BASE_URL=http://154.8.201.41
```

### 关于 COS 对象存储（可选）

配置后商品图片会上传到 COS，不占服务器带宽，访问更快：

```bash
COS_ENABLED=true
COS_SECRET_ID=你的SecretId
COS_SECRET_KEY=你的SecretKey
COS_BUCKET=mybucket-1250000000
COS_REGION=ap-beijing
# COS_DOMAIN=https://cdn.example.com   # 可选，自定义/CDN 域名
```

> ⚠️ 你的 COS 资源包只抵扣**标准存储容量费**，**流量、请求、数据取回另计**。图片量大时建议挂 CDN 并关注流量账单。
> COS 未配置或上传失败时会自动回退到本地 `data/uploads/`，不影响使用。

---

## 部署到服务器（Ubuntu）

```bash
# 1. 安装 Node.js 22+（用 NodeSource 源）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
node -v

# 2. 拉代码
sudo mkdir -p /opt/xuanze && sudo chown $USER:$USER /opt/xuanze
git clone https://github.com/Ticool1/xuanze.git /opt/xuanze
cd /opt/xuanze

# 3. 配置
cp .env.example .env
nano .env      # 改 ADMIN_PASSWORD / SESSION_SECRET / PUBLIC_BASE_URL

# 4. 用 systemd 常驻
sudo cp deploy/xuanze.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now xuanze
sudo systemctl status xuanze

# 5. 放行端口（腾讯云控制台「安全组」也要放行 3000）
sudo ufw allow 3000/tcp
```

访问 `http://154.8.201.41:3000/`。

一键部署脚本见 `deploy/setup.sh`。

---

## 目录结构

```
server/
  app.js           HTTP 服务 + 全部 API 路由
  db.js            SQLite 建表、时间工具、订单号
  qrcode.js        零依赖二维码生成器（字节模式/纠错 M/版本 1-10）
  cos.js           腾讯云 COS 上传（零依赖签名实现）
public/
  index.html       前台选购页
  checkout.html    结算页
  admin.html       后台管理
  assets/style.css 样式
tools/
  e2e.js           端到端测试（Headless Chrome，65 项）
  verify-qr.js     二维码真实解码验证（jsQR，14 项）
  compare-qr.js    与成熟实现逐位对照
deploy/
  xuanze.service   systemd 服务
  setup.sh         一键部署脚本
data/              运行时生成（数据库 + 上传图片，已 gitignore）
```

---

## 测试

```bash
# 起服务后（默认 3111 端口）
PORT=3111 node server/app.js

# 端到端（需本机 Chrome/Edge）
node tools/e2e.js http://127.0.0.1:3111

# 二维码真实解码验证（需先下载工具，见下）
node tools/verify-qr.js http://127.0.0.1:3111
```

二维码验证依赖两个开源库（仅测试用，运行时不依赖），下载到 `tools/vendor/`：

```bash
mkdir -p tools/vendor
curl -o tools/vendor/jsQR.js https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js
curl -o tools/vendor/qrcode-generator.js https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js
```

---

## 安全提示

1. **上线后立刻改 `ADMIN_PASSWORD` 和 `SESSION_SECRET`**，不要用默认值。
2. **把 SSH 改成密钥登录并禁用密码登录**：公网 IP + 弱密码的机器通常几天内就会被爆破。
3. 建议用 Nginx + HTTPS 反向代理到 `127.0.0.1:3000`，并把 `HOST` 改成 `127.0.0.1`。
4. `data/` 目录含订单和个人信息（姓名/手机号/地址），**已在 .gitignore 中排除，不要提交到仓库**。
5. 手机号等属于个人信息，页面上应保留必要的隐私说明。

---

## 技术说明

- **数据库**：`node:sqlite`（Node 22.5+ 内置），无需编译原生模块
- **二维码**：手写实现，只用 Node 内置 `crypto`；已用 jsQR 真实解码验证 14 项通过（含中文与各版本边界）
- **金额计算**：以数据库价格为准重新计算，前端传入的价格不参与计价，避免篡改
- **图片**：base64 上传，8MB 上限，支持 png/jpg/webp/gif/svg
