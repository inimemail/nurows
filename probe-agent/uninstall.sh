#!/usr/bin/env bash
set -euo pipefail
systemctl disable --now nurossh-probe.service 2>/dev/null || true
rm -f /etc/systemd/system/nurossh-probe.service
rm -rf /opt/nurossh-probe /etc/nurossh-probe
systemctl daemon-reload
