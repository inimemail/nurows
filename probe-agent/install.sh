#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "run this installer as root" >&2
  exit 1
fi

install_dependencies() {
  local missing=()
  command -v python3 >/dev/null 2>&1 || missing+=(python3)
  command -v curl >/dev/null 2>&1 || missing+=(curl)
  command -v ping >/dev/null 2>&1 || missing+=(ping)
  if ((${#missing[@]} == 0)); then
    return 0
  fi
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
    echo "missing probe dependencies: ${missing[*]}" >&2
    exit 1
  fi
  command -v python3 >/dev/null 2>&1 || { echo "python3 installation failed" >&2; exit 1; }
  command -v curl >/dev/null 2>&1 || { echo "curl installation failed" >&2; exit 1; }
  command -v ping >/dev/null 2>&1 || { echo "ping installation failed" >&2; exit 1; }
}

install_dependencies

command -v systemctl >/dev/null 2>&1 || { echo "systemd/systemctl is required for the probe service" >&2; exit 1; }

SERVER_URL="${1:?missing server url}"
PROBE_ID="${2:?missing probe id}"
case "$SERVER_URL" in
  https://*) ;;
  http://localhost*|http://127.0.0.1*|http://[::1]* )
    ;;
  *)
    if [[ "${ALLOW_INSECURE_HTTP:-0}" != "1" ]]; then
      echo "server url must use https (set ALLOW_INSECURE_HTTP=1 only for a trusted private network)" >&2
      exit 1
    fi
    ;;
esac
if [[ -n "${3:-}" ]]; then
  REGISTER_TOKEN="$3"
else
  read -r -s -p "Registration token: " REGISTER_TOKEN < /dev/tty
  printf '\n'
fi
if [[ -z "$REGISTER_TOKEN" ]]; then
  echo "registration token is required" >&2
  exit 1
fi
INSTALL_DIR="/opt/nurossh-probe"
CONFIG_DIR="/etc/nurossh-probe"

install -d -m 0755 "$INSTALL_DIR"
install -d -m 0700 "$CONFIG_DIR"
curl -fsSL "$SERVER_URL/probe/agent.py" -o "$INSTALL_DIR/nurossh_probe.py"
chmod 0755 "$INSTALL_DIR/nurossh_probe.py"
printf '{"server":"%s","probeId":"%s","token":"%s","maxConcurrency":100}\n' "$SERVER_URL" "$PROBE_ID" "$REGISTER_TOKEN" > "$CONFIG_DIR/config.json"
unset REGISTER_TOKEN
chmod 0600 "$CONFIG_DIR/config.json"
cat > /etc/systemd/system/nurossh-probe.service <<EOF
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
systemctl daemon-reload
systemctl enable --now nurossh-probe.service
sleep 2
if ! systemctl is-active --quiet nurossh-probe.service; then
  echo "nurossh-probe.service failed to start" >&2
  systemctl --no-pager --full status nurossh-probe.service >&2 || true
  journalctl -u nurossh-probe.service -n 30 --no-pager >&2 || true
  exit 1
fi
echo "nurossh-probe.service is running; registration and heartbeat will appear in the NuroSSH probe list."
