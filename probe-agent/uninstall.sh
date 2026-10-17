#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE="nurossh-probe.service"
INSTALL_DIR="/opt/nurossh-probe"
CONFIG_DIR="/etc/nurossh-probe"
SERVICE_FILE="/etc/systemd/system/nurossh-probe.service"

COLOR_RESET='' COLOR_TITLE='' COLOR_INFO='' COLOR_OK='' COLOR_ERROR=''
if [[ -t 1 && "${TERM:-dumb}" != dumb && -z "${NO_COLOR:-}" ]]; then
  COLOR_RESET=$'\033[0m' COLOR_TITLE=$'\033[1m' COLOR_INFO=$'\033[36m' COLOR_OK=$'\033[32m' COLOR_ERROR=$'\033[31m'
fi
STEP='检查运行环境'
info() { printf '%s  %s%s\n' "$COLOR_INFO" "$*" "$COLOR_RESET"; }
fail() { printf '\n%s  ✗ %s%s\n\n' "$COLOR_ERROR" "$*" "$COLOR_RESET" >&2; exit 1; }
trap 'fail "探针卸载未完成：${STEP}失败，请查看上方错误信息。"' ERR
require_root() {
  [[ "${EUID:-$(id -u)}" -eq 0 ]] || fail '请使用 root 权限运行，或在命令前加 sudo。'
}

main() {
require_root
printf '\n%s  NuroSSH 探针 · 卸载%s\n  ──────────────────────────────\n\n' "$COLOR_TITLE" "$COLOR_RESET"
STEP='停止探针服务'
info '[1/3] 停止服务并取消开机自启'
if command -v systemctl >/dev/null 2>&1; then
  systemctl disable --now "$SERVICE" 2>/dev/null || true
  if systemctl is-active --quiet "$SERVICE"; then
    fail '探针卸载失败：服务仍在运行，未删除程序和配置。请停止服务后重试。'
  fi
fi
STEP='清理探针文件'
info '[2/3] 删除程序、配置与服务文件'
rm -f "$SERVICE_FILE"
rm -rf "$INSTALL_DIR" "$CONFIG_DIR"
STEP='检查卸载结果'
info '[3/3] 刷新服务并检查清理结果'
if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload
  if systemctl is-active --quiet "$SERVICE"; then
    systemctl --no-pager --full status "$SERVICE" >&2 || true
    fail '探针卸载失败：服务仍在运行，请检查服务状态。'
  fi
fi
if [[ -e "$INSTALL_DIR" || -e "$CONFIG_DIR" || -e "$SERVICE_FILE" ]]; then
  fail '探针卸载失败：仍有残留文件，请检查目录权限后重试。'
fi
printf '\n%s  ✓ 探针卸载成功%s\n\n' "$COLOR_OK" "$COLOR_RESET"
printf '  已移除  探针服务、开机自启、程序和本机配置\n  已保留  面板中的探针记录与历史数据，可在面板中另行删除\n\n'
}

main "$@"
