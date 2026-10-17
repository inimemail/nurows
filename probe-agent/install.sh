#!/usr/bin/env bash
set -Eeuo pipefail

COLOR_RESET='' COLOR_TITLE='' COLOR_INFO='' COLOR_OK='' COLOR_ERROR=''
if [[ -t 1 && "${TERM:-dumb}" != dumb && -z "${NO_COLOR:-}" ]]; then
  COLOR_RESET=$'\033[0m' COLOR_TITLE=$'\033[1m' COLOR_INFO=$'\033[36m' COLOR_OK=$'\033[32m' COLOR_ERROR=$'\033[31m'
fi
STEP='检查运行环境'
ACTION='安装'
info() { printf '%s  %s%s\n' "$COLOR_INFO" "$*" "$COLOR_RESET"; }
fail() { printf '\n%s  ✗ %s%s\n\n' "$COLOR_ERROR" "$*" "$COLOR_RESET" >&2; exit 1; }
trap 'fail "探针${ACTION}未完成：${STEP}失败，请查看上方错误信息。"' ERR

require_root() {
  [[ "${EUID:-$(id -u)}" -eq 0 ]] || fail '请使用 root 权限运行，或在命令前加 sudo。'
}

install_dependencies() {
  local missing=()
  command -v python3 >/dev/null 2>&1 || missing+=(python3)
  command -v curl >/dev/null 2>&1 || missing+=(curl)
  command -v ping >/dev/null 2>&1 || missing+=(ping)
  if ((${#missing[@]} == 0)); then
    return 0
  fi
  info "正在自动安装缺少的依赖：${missing[*]}"
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y python3 curl ca-certificates iputils-ping
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y python3 curl ca-certificates iputils
  elif command -v yum >/dev/null 2>&1; then
    yum install -y python3 curl ca-certificates iputils
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache python3 curl ca-certificates iputils
  elif command -v zypper >/dev/null 2>&1; then
    zypper --non-interactive install python3 curl ca-certificates iputils
  else
    fail "缺少依赖：${missing[*]}，未找到支持的包管理器，请手动安装后重试。"
  fi
  command -v python3 >/dev/null 2>&1 || fail 'Python 3 安装失败，请检查包管理器输出。'
  command -v curl >/dev/null 2>&1 || fail 'curl 安装失败，请检查包管理器输出。'
  command -v ping >/dev/null 2>&1 || fail 'ping 安装失败，请检查包管理器输出。'
}

main() {
require_root
INSTALL_DIR="/opt/nurossh-probe"
CONFIG_DIR="/etc/nurossh-probe"
SERVICE_FILE="/etc/systemd/system/nurossh-probe.service"
if [[ -f "$INSTALL_DIR/nurossh_probe.py" || -f "$CONFIG_DIR/config.json" || -f "$SERVICE_FILE" ]]; then
  ACTION='升级'
fi
printf '\n%s  NuroSSH 探针 · %s%s\n  ──────────────────────────────\n\n' "$COLOR_TITLE" "$ACTION" "$COLOR_RESET"

SERVER_URL="${1:-}"
PROBE_ID="${2:-}"
[[ -n "$SERVER_URL" && -n "$PROBE_ID" ]] || fail '缺少面板地址或探针 ID，请从面板重新复制完整命令。'
command -v systemctl >/dev/null 2>&1 || fail '此探针需要 systemd 服务管理器，当前系统未找到 systemctl。'

case "$SERVER_URL" in
  https://*) ;;
  http://localhost*|http://127.0.0.1*|http://[::1]* )
    ;;
  *)
    if [[ "${ALLOW_INSECURE_HTTP:-0}" != "1" ]]; then
      fail '面板地址必须使用 HTTPS；仅可信内网可设置 ALLOW_INSECURE_HTTP=1。'
    fi
    ;;
esac
if [[ -n "${3:-}" ]]; then
  REGISTER_TOKEN="$3"
else
  read -r -s -p "  请输入注册令牌（输入不回显）：" REGISTER_TOKEN < /dev/tty
  printf '\n'
fi
if [[ -z "$REGISTER_TOKEN" ]]; then
  fail '注册令牌不能为空，请从面板重新复制完整命令。'
fi
STEP='检查并安装依赖'
info '[1/4] 检查运行环境与依赖'
install_dependencies

STEP='下载探针程序'
info '[2/4] 下载最新探针程序'
install -d -m 0755 "$INSTALL_DIR"
install -d -m 0700 "$CONFIG_DIR"
curl -fsSL "$SERVER_URL/probe/agent.py" -o "$INSTALL_DIR/nurossh_probe.py"
chmod 0755 "$INSTALL_DIR/nurossh_probe.py"
STEP='保存配置'
info '[3/4] 保存配置与系统服务'
printf '{"server":"%s","probeId":"%s","token":"%s","maxConcurrency":100}\n' "$SERVER_URL" "$PROBE_ID" "$REGISTER_TOKEN" > "$CONFIG_DIR/config.json"
unset REGISTER_TOKEN
chmod 0600 "$CONFIG_DIR/config.json"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=NuroSSH Probe Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 $INSTALL_DIR/nurossh_probe.py
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
ReadWritePaths=$CONFIG_DIR

[Install]
WantedBy=multi-user.target
EOF
STEP='启动并检查服务'
info '[4/4] 启动服务并检查运行状态'
systemctl daemon-reload
systemctl enable --quiet nurossh-probe.service >/dev/null
systemctl restart nurossh-probe.service
sleep 2
if ! systemctl is-active --quiet nurossh-probe.service; then
  printf '\n  服务未能正常启动，以下是诊断信息：\n' >&2
  systemctl --no-pager --full status nurossh-probe.service >&2 || true
  journalctl -u nurossh-probe.service -n 30 --no-pager >&2 || true
  fail "探针${ACTION}失败：服务未能正常启动。"
fi
printf '\n%s  ✓ 探针%s成功%s\n\n' "$COLOR_OK" "$ACTION" "$COLOR_RESET"
printf '  服务状态  已启动 · 已设置开机自启\n  面板状态  请在探针列表确认上线，注册与心跳由服务继续完成\n\n'
printf '  查看状态  systemctl status nurossh-probe --no-pager\n  查看日志  journalctl -u nurossh-probe -n 30 --no-pager\n\n'
}

main "$@"
