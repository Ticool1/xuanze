#!/usr/bin/env bash
# 鍦ㄦ湇鍔″櫒涓婃墽琛岀殑淇鑴氭湰锛氭洿鏂颁唬鐮?+ 淇 service 骞堕噸鍚?set -uo pipefail

APP=/opt/xuanze
SVC=/etc/systemd/system/xuanze.service
PWD_SUDO="zhanglixin1203."

echo "== 1. 鏇存柊浠ｇ爜 =="
cd "$APP" || exit 1
git fetch --all --quiet
git reset --hard origin/main
git log --oneline -2

echo
echo "== 2. 鍐欏叆 service锛堝幓鎺夋矙绠遍檺鍒讹級 =="
cat > /tmp/xuanze.service <<'EOF'
[Unit]
Description=xuanze cake shop
After=network.target

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/opt/xuanze
ExecStart=/usr/bin/node server/app.js
Restart=always
RestartSec=3
StandardOutput=append:/var/log/xuanze/app.log
StandardError=append:/var/log/xuanze/error.log
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

echo "$PWD_SUDO" | sudo -S -p '' cp /tmp/xuanze.service "$SVC"
echo "$PWD_SUDO" | sudo -S -p '' mkdir -p /var/log/xuanze
echo "$PWD_SUDO" | sudo -S -p '' chown -R ubuntu:ubuntu /var/log/xuanze
echo "$PWD_SUDO" | sudo -S -p '' systemctl daemon-reload
echo "$PWD_SUDO" | sudo -S -p '' systemctl enable xuanze >/dev/null 2>&1
echo "$PWD_SUDO" | sudo -S -p '' systemctl restart xuanze

echo
echo "== 3. 鐘舵€?=="
sleep 3
systemctl --no-pager status xuanze | head -14

echo
echo "== 4. 绔彛涓庡仴搴锋鏌?=="
ss -tln | grep -q ':3000' && echo "3000 宸茬洃鍚? || echo "3000 鏈洃鍚?
curl -s --max-time 8 http://127.0.0.1:3000/api/health || echo "HEALTH FAIL"
echo
curl -s --max-time 8 http://127.0.0.1:3000/api/shop || echo "SHOP FAIL"
echo
echo "== 5. 鏈€杩戞棩蹇?=="
tail -20 /var/log/xuanze/error.log 2>/dev/null || echo "(鏃犻敊璇棩蹇?"
tail -10 /var/log/xuanze/app.log 2>/dev/null || echo "(鏃犺緭鍑烘棩蹇?"
