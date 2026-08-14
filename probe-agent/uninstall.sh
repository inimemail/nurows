#!/usr/bin/env bash
set -euo pipefail

SERVICE="nurossh-probe.service"
INSTALL_DIR="/opt/nurossh-probe"
CONFIG_DIR="/etc/nurossh-probe"

if command -v systemctl >/dev/null 2>&1; then
  systemctl disable --now "$SERVICE" 2>/dev/null || true
fi
rm -f /etc/systemd/system/nurossh-probe.service
rm -rf "$INSTALL_DIR" "$CONFIG_DIR"
if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload
  if systemctl is-active --quiet "$SERVICE"; then
    echo "探针卸载失败：服务仍在运行" >&2
    systemctl --no-pager --full status "$SERVICE" >&2 || true
    exit 1
  fi
fi
if [[ -e "$INSTALL_DIR" || -e "$CONFIG_DIR" || -e /etc/systemd/system/$SERVICE ]]; then
  echo "探针卸载失败：残留文件未清理" >&2
  exit 1
fi
echo "探针卸载完成：服务、程序和配置已删除。"
