#!/usr/bin/env bash
# 閫夋嫨铔嬬硶搴?路 涓€閿儴缃茶剼鏈紙Ubuntu锛?# 鐢ㄦ硶锛歜ash deploy/setup.sh
set -euo pipefail

APP_DIR="/opt/xuanze"
REPO="https://github.com/Ticool1/xuanze.git"
NODE_MAJOR="22"
PORT="${PORT:-3000}"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[璀﹀憡] %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m[閿欒] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] && die "璇蜂笉瑕佺敤 root 鐩存帴杩愯锛岀敤 ubuntu 鐢ㄦ埛閰嶅悎 sudo"

# ---------- 1. Node.js ----------
log "妫€鏌?Node.js"
if command -v node >/dev/null 2>&1; then
  NODE_VER="$(node -v | sed 's/v//' | cut -d. -f1)"
  echo "宸插畨瑁?Node $(node -v)"
  if [ "$NODE_VER" -lt 22 ]; then
    warn "Node 鐗堟湰浣庝簬 22锛岄渶瑕佸崌绾э紙鏈」鐩緷璧栧唴缃?node:sqlite锛?
    NEED_NODE=1
  else
    NEED_NODE=0
  fi
else
  echo "鏈畨瑁?Node.js"
  NEED_NODE=1
fi

if [ "$NEED_NODE" = "1" ]; then
  log "瀹夎 Node.js ${NODE_MAJOR}.x"
  sudo apt-get update -y
  sudo apt-get install -y curl ca-certificates git
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
fi

command -v git >/dev/null 2>&1 || sudo apt-get install -y git
node -e "require('node:sqlite')" 2>/dev/null || die "褰撳墠 Node 涓嶆敮鎸?node:sqlite锛岃鍗囩骇鍒?22.5+"
echo "Node $(node -v) 灏辩华"

# ---------- 2. 鎷変唬鐮?----------
log "鎷夊彇浠ｇ爜鍒?${APP_DIR}"
sudo mkdir -p "$APP_DIR"
sudo chown -R "$USER":"$USER" "$APP_DIR"

if [ -d "$APP_DIR/.git" ]; then
  cd "$APP_DIR" && git pull --ff-only
else
  git clone "$REPO" "$APP_DIR"
  cd "$APP_DIR"
fi

# ---------- 3. 閰嶇疆 ----------
log "鍑嗗閰嶇疆鏂囦欢"
if [ ! -f .env ]; then
  cp .env.example .env
  SECRET="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40)"
  ADMIN_PWD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 14)"
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=${SECRET}|" .env
  sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=${ADMIN_PWD}|" .env
  PUBIP="$(curl -s --max-time 5 https://api.ipify.org || echo '')"
  if [ -n "$PUBIP" ]; then
    sed -i "s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=http://${PUBIP}|" .env
  fi
  echo
  echo "=========================================="
  echo " 宸茬敓鎴?.env锛岃璁颁笅鍚庡彴瀵嗙爜锛?
  echo "   ADMIN_PASSWORD = ${ADMIN_PWD}"
  echo "   PUBLIC_BASE_URL = http://${PUBIP:-浣犵殑鍏綉IP}:${PORT}"
  echo "=========================================="
else
  echo ".env 宸插瓨鍦紝淇濇寔涓嶅彉"
fi

mkdir -p data

# ---------- 4. systemd ----------
log "瀹夎 systemd 鏈嶅姟"
sudo mkdir -p /var/log/xuanze
sudo chown -R "$USER":"$USER" /var/log/xuanze

sudo cp deploy/xuanze.service /etc/systemd/system/xuanze.service
sudo sed -i "s|^User=.*|User=${USER}|" /etc/systemd/system/xuanze.service
sudo systemctl daemon-reload
sudo systemctl enable xuanze
sudo systemctl restart xuanze

sleep 2
sudo systemctl --no-pager --lines=8 status xuanze || true

# ---------- 5. 闃茬伀澧?----------
log "閰嶇疆闃茬伀澧?
if command -v ufw >/dev/null 2>&1 && sudo ufw status | grep -q "Status: active"; then
  sudo ufw allow "${PORT}/tcp" || true
else
  echo "ufw 鏈惎鐢紝璺宠繃锛堜簯鏈嶅姟鍣ㄨ鍦ㄦ帶鍒跺彴銆屽畨鍏ㄧ粍銆嶆斁琛?${PORT} 绔彛锛?
fi

# ---------- 6. 鑷 ----------
log "鍋ュ悍妫€鏌?
sleep 1
if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null; then
  echo "鉁?鏈嶅姟姝ｅ父"
else
  die "鏈嶅姟鏈搷搴旓紝鏌ョ湅鏃ュ織锛歴udo journalctl -u xuanze -n 50 --no-pager"
fi

PUBIP="$(curl -s --max-time 5 https://api.ipify.org || echo '鏈嶅姟鍣↖P')"
cat <<EOF

============================================
 閮ㄧ讲瀹屾垚
   鍓嶅彴锛歨ttp://${PUBIP}:${PORT}/
   鍚庡彴锛歨ttp://${PUBIP}:${PORT}/admin
============================================
鎻愰啋锛? 1. 浜戞湇鍔″櫒鎺у埗鍙般€屽畨鍏ㄧ粍銆嶉渶鏀捐 ${PORT} 绔彛锛屽惁鍒欏缃戣闂笉浜? 2. 浜岀淮鐮佷細鑷姩鎸囧悜 PUBLIC_BASE_URL锛屽～閿欎簡鎵嬫満鎵笉鍑猴紝鏀?.env 鍚庨噸鍚湇鍔? 3. 寤鸿鍚庣画閰?Nginx + HTTPS锛屽苟鎶?HOST 鏀逛负 127.0.0.1
============================================
EOF
