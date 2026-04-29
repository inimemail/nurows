#!/usr/bin/env bash

set -euo pipefail

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
export LANG="C.UTF-8"
export LC_ALL="C.UTF-8"

SCRIPT_SOURCE="${BASH_SOURCE[0]:-install.sh}"
SCRIPT_PATH="$(readlink -f "${SCRIPT_SOURCE}")"
SCRIPT_DIR="$(cd "$(dirname "${SCRIPT_PATH}")" && pwd)"

APP_NAME="autorun-webssh"
DEFAULT_INSTALL_PATH="/opt/${APP_NAME}"
STATE_FILE="/etc/${APP_NAME}_path"

info() { echo -e "\033[32m[INFO]\033[0m $1" >&2; }
warn() { echo -e "\033[33m[WARN]\033[0m $1" >&2; }
err() { echo -e "\033[31m[ERROR]\033[0m $1" >&2; }
die() { echo -e "\033[31m[FATAL]\033[0m $1" >&2; exit 1; }

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    die "请使用 root 权限运行此脚本。"
  fi
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "缺少依赖：$1"
}

require_docker() {
  require_cmd docker
  docker info >/dev/null 2>&1 || die "Docker 未启动，或当前环境无法访问 Docker。"
}

require_compose() {
  if command -v docker-compose >/dev/null 2>&1; then
    return
  fi
  docker compose version >/dev/null 2>&1 || die "未安装 Docker Compose。"
}

compose_cmd() {
  if command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    docker compose "$@"
  fi
}

read_env_value() {
  local env_file="$1"
  local key="$2"
  local fallback="${3:-}"

  if [[ -f "${env_file}" ]]; then
    local value
    value="$(awk -F= -v target="${key}" '$1 == target { sub(/^[^=]*=/, "", $0); print $0; exit }' "${env_file}")"
    if [[ -n "${value}" ]]; then
      echo "${value}"
      return
    fi
  fi

  echo "${fallback}"
}

get_bundle_dir() {
  if [[ -f "${SCRIPT_DIR}/package.json" && -f "${SCRIPT_DIR}/server/index.js" ]]; then
    echo "${SCRIPT_DIR}"
    return
  fi

  if [[ -f "${SCRIPT_DIR}/app/package.json" && -f "${SCRIPT_DIR}/app/server/index.js" ]]; then
    echo "${SCRIPT_DIR}/app"
    return
  fi

  die "未找到应用源码目录。"
}

get_workdir() {
  if [[ -f "${STATE_FILE}" ]]; then
    local dir
    dir="$(cat "${STATE_FILE}")"
    if [[ -d "${dir}" ]]; then
      echo "${dir}"
      return
    fi
  fi

  if [[ -d "${DEFAULT_INSTALL_PATH}" && -f "${DEFAULT_INSTALL_PATH}/docker-compose.yml" ]]; then
    echo "${DEFAULT_INSTALL_PATH}"
    return
  fi

  echo ""
}

copy_manage_script() {
  local install_path="$1"
  install -m 755 "${SCRIPT_PATH}" "${install_path}/manage.sh"
}

sync_app_bundle() {
  local source_dir="$1"
  local target_dir="$2"

  mkdir -p "${target_dir}"
  if [[ "$(readlink -f "${source_dir}")" == "$(readlink -f "${target_dir}")" ]]; then
    return
  fi

  find "${target_dir}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +

  tar \
    --exclude='./.git' \
    --exclude='./node_modules' \
    --exclude='./dist' \
    --exclude='./data' \
    --exclude='./backups' \
    --exclude='./.env' \
    --exclude='./*.log' \
    --exclude='./local-run.out' \
    --exclude='./local-run.err' \
    -cf - -C "${source_dir}" . | tar -xf - -C "${target_dir}"
}

write_compose_file() {
  local install_path="$1"

  cat > "${install_path}/docker-compose.yml" <<'EOF'
services:
  autorun-webssh:
    build:
      context: ./app
    container_name: autorun-webssh
    restart: unless-stopped
    init: true
    env_file:
      - .env
    environment:
      NODE_ENV: ${NODE_ENV}
      HOST: ${HOST}
      PORT: ${PORT}
      SQLITE_DB_PATH: ${SQLITE_DB_PATH}
    ports:
      - "${PORT}:${PORT}"
    volumes:
      - ./data:/app/data
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    tmpfs:
      - /tmp:size=64m,mode=1777
EOF
}

write_runtime_env() {
  local target_file="$1"
  local port="$2"
  local host="$3"

  cat > "${target_file}" <<EOF
PORT=${port}
HOST=${host}
NODE_ENV=production
SQLITE_DB_PATH=/app/data/app.db
EOF
}

ensure_runtime_env_file() {
  local workdir="$1"
  local env_file="${workdir}/.env"
  local port host

  port="$(read_env_value "${env_file}" PORT "38471")"
  host="$(read_env_value "${env_file}" HOST "0.0.0.0")"
  write_runtime_env "${env_file}" "${port}" "${host}"
}

ensure_data_permissions() {
  local install_path="$1"
  mkdir -p "${install_path}/data" "${install_path}/backups"
  chown -R 10001:10001 "${install_path}/data" "${install_path}/backups" 2>/dev/null || true
}

get_local_ip() {
  hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1"
}

print_access_info() {
  local env_file="$1"
  local server_ip port
  server_ip="$(get_local_ip)"
  port="$(read_env_value "${env_file}" PORT "38471")"

  echo
  echo "=================================================="
  echo -e "\033[32m部署完成。\033[0m"
  echo -e "访问地址：\033[36mhttp://${server_ip}:${port}/\033[0m"
  echo "数据目录：$(dirname "${env_file}")/data"
  echo "=================================================="
  echo
}

deploy_service() {
  require_docker
  require_compose
  require_cmd tar

  local bundle_dir install_path input_path input_port port
  bundle_dir="$(get_bundle_dir)"

  read -r -p "安装路径 [默认: ${DEFAULT_INSTALL_PATH}]: " input_path
  install_path="${input_path:-$DEFAULT_INSTALL_PATH}"

  if [[ -d "${install_path}" && -f "${install_path}/docker-compose.yml" ]]; then
    warn "检测到该路径已经存在部署：${install_path}"
    local overwrite_existing
    read -r -p "是否覆盖现有部署？(y/N): " overwrite_existing
    if [[ ! "${overwrite_existing}" =~ ^[Yy]$ ]]; then
      info "已取消部署。"
      return
    fi
  fi

  read -r -p "对外端口 [默认: 38471]: " input_port
  port="${input_port:-38471}"

  mkdir -p "${install_path}/app"
  sync_app_bundle "${bundle_dir}" "${install_path}/app"
  write_compose_file "${install_path}"
  write_runtime_env "${install_path}/.env" "${port}" "0.0.0.0"
  ensure_data_permissions "${install_path}"
  copy_manage_script "${install_path}"

  echo "${install_path}" > "${STATE_FILE}"

  (
    cd "${install_path}" || exit 1
    compose_cmd up -d --build
  )

  print_access_info "${install_path}/.env"
}

upgrade_service() {
  require_docker
  require_compose
  require_cmd tar

  local workdir bundle_dir
  workdir="$(get_workdir)"
  [[ -n "${workdir}" ]] || die "未检测到已部署实例。"

  bundle_dir="$(get_bundle_dir)"
  sync_app_bundle "${bundle_dir}" "${workdir}/app"
  write_compose_file "${workdir}"
  ensure_runtime_env_file "${workdir}"
  ensure_data_permissions "${workdir}"
  copy_manage_script "${workdir}"

  (
    cd "${workdir}" || exit 1
    compose_cmd up -d --build
  )

  print_access_info "${workdir}/.env"
}

stop_service() {
  require_docker
  require_compose

  local workdir
  workdir="$(get_workdir)"
  [[ -n "${workdir}" ]] || die "未检测到已部署实例。"

  (
    cd "${workdir}" || exit 1
    compose_cmd stop
  )

  info "服务已停止。"
}

restart_service() {
  require_docker
  require_compose

  local workdir
  workdir="$(get_workdir)"
  [[ -n "${workdir}" ]] || die "未检测到已部署实例。"

  (
    cd "${workdir}" || exit 1
    compose_cmd restart || compose_cmd up -d --build
  )

  info "服务已重启。"
}

status_service() {
  require_docker
  require_compose

  local workdir
  workdir="$(get_workdir)"
  [[ -n "${workdir}" ]] || die "未检测到已部署实例。"

  info "当前部署路径：${workdir}"
  (
    cd "${workdir}" || exit 1
    compose_cmd ps
  )
}

logs_service() {
  require_docker
  require_compose

  local workdir input_lines lines
  workdir="$(get_workdir)"
  [[ -n "${workdir}" ]] || die "未检测到已部署实例。"

  read -r -p "查看最近多少行日志 [默认: 200]: " input_lines
  lines="${input_lines:-200}"

  info "正在显示服务日志，按 Ctrl+C 退出。"
  (
    cd "${workdir}" || exit 1
    compose_cmd logs --tail "${lines}" -f autorun-webssh
  )
}

backup_service() {
  require_cmd tar

  local workdir backup_dir backup_file timestamp
  workdir="$(get_workdir)"
  [[ -n "${workdir}" ]] || die "未检测到已部署实例。"

  backup_dir="${workdir}/backups"
  mkdir -p "${backup_dir}"
  timestamp="$(date +"%Y%m%d_%H%M%S")"
  backup_file="${backup_dir}/${APP_NAME}_backup_${timestamp}.tar.gz"

  (
    cd "${workdir}" || exit 1
    tar -czf "${backup_file}" docker-compose.yml .env app data manage.sh
  )

  info "备份已创建：${backup_file}"
}

restore_service() {
  require_docker
  require_compose
  require_cmd tar

  local backup_path target_dir input_path input_backup

  read -r -p "备份压缩包路径: " input_backup
  backup_path="${input_backup}"
  [[ -f "${backup_path}" ]] || die "未找到备份文件。"

  read -r -p "恢复目标路径 [默认: ${DEFAULT_INSTALL_PATH}]: " input_path
  target_dir="${input_path:-$DEFAULT_INSTALL_PATH}"

  if [[ -d "${target_dir}" && -f "${target_dir}/docker-compose.yml" ]]; then
    warn "目标路径已有部署，恢复会覆盖现有内容：${target_dir}"
    local confirm_restore
    read -r -p "是否继续恢复？(y/N): " confirm_restore
    if [[ ! "${confirm_restore}" =~ ^[Yy]$ ]]; then
      info "已取消恢复。"
      return
    fi

    (
      cd "${target_dir}" || exit 1
      compose_cmd down || true
    )
  fi

  mkdir -p "${target_dir}"
  tar -xzf "${backup_path}" -C "${target_dir}"
  write_compose_file "${target_dir}"
  ensure_runtime_env_file "${target_dir}"
  ensure_data_permissions "${target_dir}"
  copy_manage_script "${target_dir}"

  echo "${target_dir}" > "${STATE_FILE}"

  (
    cd "${target_dir}" || exit 1
    compose_cmd up -d --build
  )

  print_access_info "${target_dir}/.env"
}

uninstall_service() {
  require_docker
  require_compose

  local workdir
  workdir="$(get_workdir)"
  [[ -n "${workdir}" ]] || die "未检测到已部署实例。"

  warn "该操作会删除容器以及 ${workdir} 下的全部数据。"
  local confirm
  read -r -p "确认卸载？(y/N): " confirm
  if [[ ! "${confirm}" =~ ^[Yy]$ ]]; then
    info "已取消卸载。"
    return
  fi

  (
    cd "${workdir}" || exit 1
    compose_cmd down -v || true
  )

  rm -rf "${workdir}"
  rm -f "${STATE_FILE}"
  info "卸载完成。"
}

main_menu() {
  if command -v clear >/dev/null 2>&1; then
    clear
  fi

  local workdir
  workdir="$(get_workdir)"

  echo "=================================================="
  echo "             autorun-webssh 管理脚本"
  echo "=================================================="
  echo " 当前部署路径：${workdir:-未部署}"
  echo "--------------------------------------------------"
  echo " 1) 安装部署"
  echo " 2) 升级服务"
  echo " 3) 停止服务"
  echo " 4) 重启服务"
  echo " 5) 查看状态"
  echo " 6) 查看日志"
  echo " 7) 手动备份"
  echo " 8) 恢复备份"
  echo " 9) 卸载服务"
  echo " 0) 退出"
  echo "=================================================="

  local choice
  read -r -p "请选择 [0-9]: " choice
  case "${choice}" in
    1) deploy_service ;;
    2) upgrade_service ;;
    3) stop_service ;;
    4) restart_service ;;
    5) status_service ;;
    6) logs_service ;;
    7) backup_service ;;
    8) restore_service ;;
    9) uninstall_service ;;
    0) exit 0 ;;
    *) warn "无效选项。" ;;
  esac
}

dispatch_command() {
  case "${1:-}" in
    install) deploy_service ;;
    upgrade) upgrade_service ;;
    stop) stop_service ;;
    restart) restart_service ;;
    status) status_service ;;
    logs) logs_service ;;
    backup) backup_service ;;
    restore) restore_service ;;
    uninstall) uninstall_service ;;
    "")
      while true; do
        main_menu
        echo
        read -r -p "按回车返回主菜单..."
      done
      ;;
    *)
      err "不支持的命令：${1}"
      echo "可用命令：install | upgrade | stop | restart | status | logs | backup | restore | uninstall"
      exit 1
      ;;
  esac
}

require_root
dispatch_command "${1:-}"
