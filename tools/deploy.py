#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
通过 SSH（密码认证）在服务器上执行部署命令。
用法：
  python tools/deploy.py check
  python tools/deploy.py deploy
  python tools/deploy.py exec "任意命令"
"""
import sys
import time

import paramiko

HOST = "154.8.201.41"
USER = "ubuntu"
PASSWORD = "zhanglixin1203."
PORT = 22


def connect():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        hostname=HOST,
        port=PORT,
        username=USER,
        password=PASSWORD,
        timeout=25,
        banner_timeout=30,
        auth_timeout=30,
        look_for_keys=False,
        allow_agent=False,
    )
    return client


def run(client, cmd, timeout=600, silent=False):
    """执行命令，实时输出"""
    if not silent:
        print(f"\n\033[1;36m$ {cmd}\033[0m")
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout, get_pty=True)
    out_chunks = []
    err_chunks = []

    # get_pty=True 时输出合并到 stdout
    for line in iter(stdout.readline, ""):
        out_chunks.append(line)
        if not silent:
            sys.stdout.write(line)
            sys.stdout.flush()

    # 等待退出
    exit_status = stdout.channel.recv_exit_status()
    return exit_status, "".join(out_chunks)


def sudo_run(client, cmd, timeout=900):
    """用 sudo -S 并通过 stdin 传密码"""
    full = f"echo '{PASSWORD}' | sudo -S -p '' bash -lc {shquote(cmd)}"
    return run(client, full, timeout=timeout)


def shquote(s):
    return "'" + s.replace("'", "'\"'\"'") + "'"


def cmd_check(client):
    print("=" * 60)
    print("服务器环境检查")
    print("=" * 60)
    run(client, "uname -a; echo '---'; cat /etc/os-release | head -3")
    run(client, "whoami; id")
    run(client, "free -m | head -3")
    run(client, "df -h / | tail -2")
    run(client, "node -v 2>/dev/null || echo 'Node 未安装'")
    run(client, "git --version 2>/dev/null || echo 'git 未安装'")
    run(client, "curl -s --max-time 8 https://api.ipify.org || echo '无法获取公网IP'")
    run(client, "echo '--- 已占用端口 ---'; ss -tlnp 2>/dev/null | head -20 || netstat -tln 2>/dev/null | head -20")


def cmd_deploy(client):
    print("=" * 60)
    print("开始部署")
    print("=" * 60)

    # 1) 检查/安装 Node
    code, out = run(client, "node -v 2>/dev/null || echo NONE", silent=True)
    node_ver = out.strip().replace("\r", "")
    print(f"[1] 当前 Node: {node_ver}")

    need_node = True
    if node_ver.startswith("v"):
        try:
            major = int(node_ver[1:].split(".")[0])
            minor = int(node_ver[1:].split(".")[1])
            if major > 22 or (major == 22 and minor >= 5):
                need_node = False
        except Exception:
            pass

    if need_node:
        print("[2] 安装 Node.js 22.x ...")
        sudo_run(client, "apt-get update -y")
        sudo_run(client, "apt-get install -y curl ca-certificates git")
        sudo_run(
            client,
            "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs",
            timeout=900,
        )
    else:
        print("[2] Node 版本满足要求，跳过安装")

    run(client, "node -v; npm -v 2>/dev/null || true")
    code, out = run(client, "node -e \"require('node:sqlite')\" && echo SQLITE_OK || echo SQLITE_FAIL", silent=True)
    if "SQLITE_OK" not in out:
        print("❌ 当前 Node 不支持 node:sqlite，部署中止")
        return False
    print("    node:sqlite 可用 ✅")

    # 3) 拉代码
    print("[3] 拉取代码")
    sudo_run(client, "mkdir -p /opt/xuanze && chown -R ubuntu:ubuntu /opt/xuanze")
    code, out = run(client, "test -d /opt/xuanze/.git && echo HAS_GIT || echo NO_GIT", silent=True)
    if "HAS_GIT" in out:
        run(client, "cd /opt/xuanze && git fetch --all && git reset --hard origin/main")
    else:
        run(client, "git clone https://github.com/Ticool1/xuanze.git /opt/xuanze")
    run(client, "ls -la /opt/xuanze")

    # 4) 配置 .env
    print("[4] 配置 .env")
    code, out = run(client, "test -f /opt/xuanze/.env && echo HAS_ENV || echo NO_ENV", silent=True)
    if "NO_ENV" in out:
        run(
            client,
            "cd /opt/xuanze && cp .env.example .env && "
            "SECRET=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40) && "
            "ADMINPWD=$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 14) && "
            "PUBIP=$(curl -s --max-time 6 https://api.ipify.org || echo '154.8.201.41') && "
            "sed -i \"s|^SESSION_SECRET=.*|SESSION_SECRET=$SECRET|\" .env && "
            "sed -i \"s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$ADMINPWD|\" .env && "
            "sed -i \"s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=http://$PUBIP:3000|\" .env && "
            "echo '=== 生成的后台密码 ===' && grep -E 'ADMIN_PASSWORD|PUBLIC_BASE_URL' .env",
        )
    else:
        print("    .env 已存在，保留")
        run(client, "cd /opt/xuanze && grep -E 'ADMIN_PASSWORD|PUBLIC_BASE_URL|COS_ENABLED' .env")

    # 5) systemd
    print("[5] 安装 systemd 服务")
    sudo_run(client, "mkdir -p /var/log/xuanze && chown -R ubuntu:ubuntu /var/log/xuanze")
    sudo_run(client, "cp /opt/xuanze/deploy/xuanze.service /etc/systemd/system/xuanze.service")
    sudo_run(client, "sed -i 's|^User=.*|User=ubuntu|' /etc/systemd/system/xuanze.service")
    sudo_run(client, "systemctl daemon-reload")
    sudo_run(client, "systemctl enable xuanze")
    sudo_run(client, "systemctl restart xuanze")
    time.sleep(3)
    run(client, "systemctl --no-pager --lines=15 status xuanze || true")

    # 6) 防火墙
    print("[6] 配置防火墙")
    sudo_run(client, "ufw status | head -3 || echo 'ufw 未启用'")
    sudo_run(client, "ufw allow 3000/tcp 2>/dev/null || true")
    run(client, "ss -tlnp 2>/dev/null | grep 3000 || echo '3000 端口未监听'")

    # 7) 健康检查
    print("[7] 健康检查")
    time.sleep(2)
    run(client, "curl -s --max-time 8 http://127.0.0.1:3000/api/health || echo 'HEALTH FAIL'")
    run(client, "curl -s --max-time 8 http://127.0.0.1:3000/api/shop || echo 'SHOP FAIL'")

    return True


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "check"
    client = connect()
    try:
        if action == "check":
            cmd_check(client)
        elif action == "deploy":
            ok = cmd_deploy(client)
            sys.exit(0 if ok else 1)
        elif action == "exec":
            cmd = sys.argv[2]
            code, out = run(client, cmd)
            print(f"\n[exit {code}]")
        else:
            print(f"未知命令: {action}")
            sys.exit(2)
    finally:
        client.close()


if __name__ == "__main__":
    main()
