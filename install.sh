#!/usr/bin/env bash

set -euo pipefail

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
export LANG="C.UTF-8"
export LC_ALL="C.UTF-8"

SCRIPT_SOURCE="${BASH_SOURCE[0]:-install.sh}"
SCRIPT_PATH="${SCRIPT_SOURCE}"
if [[ "${SCRIPT_SOURCE}" == /dev/fd/* || "${SCRIPT_SOURCE}" == /proc/*/fd/* ]]; then
  SCRIPT_DIR="$(pwd)"
else
  SCRIPT_PATH="$(readlink -f "${SCRIPT_SOURCE}")"
  SCRIPT_DIR="$(cd "$(dirname "${SCRIPT_PATH}")" && pwd)"
fi

APP_NAME="nurossh"
DEFAULT_INSTALL_PATH="/opt/${APP_NAME}"
STATE_FILE="/etc/${APP_NAME}_path"
CRON_TAG_BEGIN="# NUROSSH_BACKUP_BEGIN"
CRON_TAG_END="# NUROSSH_BACKUP_END"
BACKUP_LOG="/var/log/${APP_NAME}_backup.log"
REPO_ARCHIVE_URL="https://github.com/inimemail/nurows/archive/refs/heads/main.tar.gz"
TEMP_BUNDLE_ROOT=""

info() { echo -e "\033[32m[INFO]\033[0m $1" >&2; }
warn() { echo -e "\033[33m[WARN]\033[0m $1" >&2; }
err() { echo -e "\033[31m[ERROR]\033[0m $1" >&2; }
die() { echo -e "\033[31m[FATAL]\033[0m $1" >&2; exit 1; }

cleanup_temp_bundle() {
  if [[ -n "${TEMP_BUNDLE_ROOT}" && -d "${TEMP_BUNDLE_ROOT}" ]]; then
    rm -rf "${TEMP_BUNDLE_ROOT}"
  fi
}

trap cleanup_temp_bundle EXIT

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

download_bundle() {
  require_cmd curl
  require_cmd tar

  TEMP_BUNDLE_ROOT="$(mktemp -d)"
  local archive_path="${TEMP_BUNDLE_ROOT}/${APP_NAME}.tar.gz"

  info "正在下载 NuroSSH 源码包..."
  curl -fsSL "${REPO_ARCHIVE_URL}" -o "${archive_path}"
  tar -xzf "${archive_path}" -C "${TEMP_BUNDLE_ROOT}"

  local extracted_dir
  extracted_dir="$(find "${TEMP_BUNDLE_ROOT}" -maxdepth 1 -type d -name 'nurows-*' | head -n 1)"
  [[ -n "${extracted_dir}" && -f "${extracted_dir}/package.json" && -f "${extracted_dir}/server/index.js" ]] || die "从 GitHub 准备应用源码失败。"

  echo "${extracted_dir}"
}

get_install_bundle_dir() {
  if [[ -f "${SCRIPT_DIR}/package.json" && -f "${SCRIPT_DIR}/server/index.js" ]]; then
    echo "${SCRIPT_DIR}"
    return
  fi

  if [[ -f "${SCRIPT_DIR}/app/package.json" && -f "${SCRIPT_DIR}/app/server/index.js" ]]; then
    echo "${SCRIPT_DIR}/app"
    return
  fi

  download_bundle
}

get_upgrade_bundle_dir() {
  local workdir="$1"
  local current_app_dir=""

  if [[ -d "${workdir}/app" ]]; then
    current_app_dir="$(readlink -f "${workdir}/app")"
  fi

  if [[ -f "${SCRIPT_DIR}/package.json" && -f "${SCRIPT_DIR}/server/index.js" ]]; then
    local bundled_dir
    bundled_dir="$(readlink -f "${SCRIPT_DIR}")"
    if [[ -n "${current_app_dir}" && "${bundled_dir}" == "${current_app_dir}" ]]; then
      download_bundle
      return
    fi

    echo "${SCRIPT_DIR}"
    return
  fi

  if [[ -f "${SCRIPT_DIR}/app/package.json" && -f "${SCRIPT_DIR}/app/server/index.js" ]]; then
    local bundled_app_dir
    bundled_app_dir="$(readlink -f "${SCRIPT_DIR}/app")"
    if [[ -n "${current_app_dir}" && "${bundled_app_dir}" == "${current_app_dir}" ]]; then
      download_bundle
      return
    fi

    echo "${SCRIPT_DIR}/app"
    return
  fi

  download_bundle
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
  local bundle_dir="${2:-}"
  local source_script="${SCRIPT_PATH}"

  if [[ -n "${bundle_dir}" && -f "${bundle_dir}/install.sh" ]]; then
    source_script="${bundle_dir}/install.sh"
  fi

  if [[ -f "${source_script}" ]]; then
    install -m 755 "${source_script}" "${install_path}/manage.sh"
  elif [[ -f "${install_path}/manage.sh" ]]; then
    chmod 755 "${install_path}/manage.sh"
  else
    warn "未找到可复制的管理脚本，已跳过 manage.sh 更新。"
  fi
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
  nurossh:
    build:
      context: ./app
    container_name: nurossh
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
    cap_add:
      - NET_RAW
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
  local port host tmp_env

  port="$(read_env_value "${env_file}" PORT "38471")"
  host="$(read_env_value "${env_file}" HOST "0.0.0.0")"
  if [[ ! -f "${env_file}" ]]; then
    write_runtime_env "${env_file}" "${port}" "${host}"
    return
  fi
  tmp_env="$(mktemp "${env_file}.XXXXXX")"
  cp -p "${env_file}" "${tmp_env}"
  printf '\n' >> "${tmp_env}"
  grep -q '^PORT=' "${tmp_env}" || printf 'PORT=%s\n' "${port}" >> "${tmp_env}"
  grep -q '^HOST=' "${tmp_env}" || printf 'HOST=%s\n' "${host}" >> "${tmp_env}"
  grep -q '^NODE_ENV=' "${tmp_env}" || printf 'NODE_ENV=production\n' >> "${tmp_env}"
  grep -q '^SQLITE_DB_PATH=' "${tmp_env}" || printf 'SQLITE_DB_PATH=/app/data/app.db\n' >> "${tmp_env}"
  chmod --reference="${env_file}" "${tmp_env}" 2>/dev/null || true
  mv -f "${tmp_env}" "${env_file}"
}

ensure_data_permissions() {
  local install_path="$1"
  mkdir -p "${install_path}/data" "${install_path}/backups"
  find "${install_path}/data" \( ! -user 10001 -o ! -group 10001 \) -exec chown 10001:10001 {} +
  chmod 700 "${install_path}/data" "${install_path}/backups"
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

  bundle_dir="$(get_install_bundle_dir)"

  mkdir -p "${install_path}/app"
  sync_app_bundle "${bundle_dir}" "${install_path}/app"
  write_compose_file "${install_path}"
  if [[ -f "${install_path}/.env" ]]; then
    ensure_runtime_env_file "${install_path}"
  else
    write_runtime_env "${install_path}/.env" "${port}" "0.0.0.0"
  fi
  ensure_data_permissions "${install_path}"
  copy_manage_script "${install_path}" "${bundle_dir}"

  echo "${install_path}" > "${STATE_FILE}"

  (
    cd "${install_path}" || exit 1
    compose_cmd up -d --build
  )

  print_access_info "${install_path}/.env"
}

wait_service_ready() {
  local attempt
  for attempt in $(seq 1 20); do
    if compose_cmd exec -T nurossh node -e 'const http=require("node:http");const host=["0.0.0.0","::",""].includes(process.env.HOST||"")?"127.0.0.1":process.env.HOST;const req=http.get({host,port:process.env.PORT||38471,path:"/api/auth/status",timeout:1500},res=>{let body="";res.on("data",chunk=>body+=chunk);res.on("end",()=>{try{process.exit(res.statusCode===200&&typeof JSON.parse(body).configured==="boolean"?0:1)}catch{process.exit(1)}})});req.on("timeout",()=>req.destroy());req.on("error",()=>process.exit(1));' >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

upgrade_service() {
  require_docker
  require_compose
  require_cmd tar

  local workdir bundle_dir
  workdir="$(get_workdir)"
  [[ -n "${workdir}" ]] || die "未检测到已部署实例。"

  bundle_dir="$(get_upgrade_bundle_dir "${workdir}")"
  info "升级前先创建数据快照，确保新版本异常时可以恢复。"
  backup_service "${bundle_dir}"
  sync_app_bundle "${bundle_dir}" "${workdir}/app"
  [[ -f "${workdir}/docker-compose.yml" ]] || write_compose_file "${workdir}"
  ensure_runtime_env_file "${workdir}"
  ensure_data_permissions "${workdir}"
  copy_manage_script "${workdir}" "${bundle_dir}"

  if ! (
    cd "${workdir}" || exit 1
    compose_cmd up -d --build && wait_service_ready
  ); then
    die "新版服务未通过就绪检查。升级前备份保存在 ${workdir}/backups，原数据目录未清空，请查看日志或恢复该备份。"
  fi

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

pause_service() {
  stop_service
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
    compose_cmd logs --tail "${lines}" -f nurossh
  )
}

management_helper() {
  local name="$1" bundle="${2:-}"
  if [[ -n "${bundle}" && -f "${bundle}/server/${name}" ]]; then
    echo "${bundle}/server/${name}"
  elif [[ -f "${SCRIPT_DIR}/server/${name}" ]]; then
    echo "${SCRIPT_DIR}/server/${name}"
  elif [[ -f "${SCRIPT_DIR}/app/server/${name}" ]]; then
    echo "${SCRIPT_DIR}/app/server/${name}"
  else
    local fetched
    fetched="$(get_install_bundle_dir)"
    [[ -f "${fetched}/server/${name}" ]] || die "缺少管理组件 ${name}，请使用新版完整源码中的 install.sh。"
    echo "${fetched}/server/${name}"
  fi
}

backup_service() (
  set -euo pipefail
  umask 077
  require_docker
  require_compose
  require_cmd python3
  require_cmd flock
  local workdir helper archive_helper stage snapshot timestamp db_path backup_file
  workdir="$(get_workdir)"
  [[ -n "${workdir}" ]] || die "未检测到已部署实例。"
  helper="$(management_helper storage-backup.js "${1:-}")"
  archive_helper="$(management_helper backup-archive.py "${1:-}")"
  mkdir -p "${workdir}/backups"
  exec 9>"${workdir}/backups/.backup.lock"
  flock -n 9 || die "已有备份正在执行，请稍后重试。"
  stage="$(mktemp -d "${workdir}/backups/.stage-XXXXXX")"
  snapshot=".backup-${stage##*/}"
  trap "$(printf 'rm -rf -- %q %q' "${stage}" "${workdir}/data/${snapshot}")" EXIT
  timestamp="$(date +%Y%m%d_%H%M%S)"
  backup_file="${workdir}/backups/${APP_NAME}_backup_${timestamp}_${stage##*-}.tar.gz"
  db_path="$(read_env_value "${workdir}/.env" SQLITE_DB_PATH "/app/data/app.db")"
  db_path="${db_path%\"}"; db_path="${db_path#\"}"
  db_path="${db_path%\'}"; db_path="${db_path#\'}"
  [[ "${db_path}" == /app/data/* && "${db_path}" != *"/../"* ]] || die "数据库必须位于 /app/data 持久化目录，已停止备份以避免遗漏自定义数据库。"
  (
    cd "${workdir}"
    if [[ -n "$(compose_cmd ps -q --status running nurossh)" ]]; then
      compose_cmd exec -T nurossh node --input-type=module - /app/data "/app/data/${snapshot}" "${db_path}" < "${helper}"
    else
      compose_cmd run --rm --no-deps -T nurossh node --input-type=module - /app/data "/app/data/${snapshot}" "${db_path}" < "${helper}"
    fi
  )
  mv "${workdir}/data/${snapshot}" "${stage}/data"
  cp -p "${workdir}/.env" "${workdir}/docker-compose.yml" "${workdir}/manage.sh" "${stage}/"
  mkdir "${stage}/app"
  tar --exclude='./node_modules' --exclude='./.git' --exclude='./data' --exclude='./backups' --exclude='./.env' --exclude='./dist' --exclude='__pycache__' -cf - -C "${workdir}/app" . | tar -xf - -C "${stage}/app"
  python3 "${archive_helper}" manifest "${stage}"
  # Fast compression reduces CPU spent on large attachments. Publish only a complete archive.
  tar -cf - -C "${stage}" . | gzip -1 > "${backup_file}.partial"
  mv "${backup_file}.partial" "${backup_file}"
  info "一致性备份已创建：${backup_file}"
)

do_backup() {
  backup_service
}

restore_service() (
  set -euo pipefail
  umask 077
  require_docker
  require_compose
  require_cmd python3
  local backup_path target_dir input_path archive_root previous_dir helper confirm_restore
  read -r -p "备份压缩包路径: " backup_path
  [[ -f "${backup_path}" ]] || die "未找到备份文件。"
  backup_path="$(readlink -f "${backup_path}")"
  helper="$(management_helper backup-archive.py)"
  archive_root="$(mktemp -d)"
  trap "$(printf 'rm -rf -- %q' "${archive_root}")" EXIT
  info "正在校验备份和数据库，校验结束前不会停止现有服务。"
  python3 "${helper}" extract "${backup_path}" "${archive_root}"
  read -r -p "恢复目标路径 [默认: ${DEFAULT_INSTALL_PATH}]: " input_path
  target_dir="${input_path:-$DEFAULT_INSTALL_PATH}"
  [[ "${target_dir}" == /* && "${target_dir}" != "/" && "${target_dir}" != "/root" && "${target_dir}" != "/home" && "${target_dir}" != "/opt" && ! -L "${target_dir}" ]] || die "请指定独立的绝对部署路径。"
  target_dir="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "${target_dir}")"
  [[ "${target_dir}" != "/" && "${target_dir}" != "/root" && "${target_dir}" != "/home" && "${target_dir}" != "/opt" && "${target_dir}" != "/etc" && "${target_dir}" != "/usr" && "${target_dir}" != "/var" ]] || die "恢复目标不能是系统目录。"
  if [[ -e "${target_dir}" ]]; then
    [[ -f "${target_dir}/docker-compose.yml" ]] || die "目标目录已有非部署数据，请使用其他目录。"
    read -r -p "恢复将替换当前部署，并保留完整旧目录。是否继续？(y/N): " confirm_restore
    [[ "${confirm_restore}" =~ ^[Yy]$ ]] || { info "已取消恢复。"; return; }
  fi
  # Stage on the destination filesystem; directory rename cannot mix old WAL files.
  local prepared
  mkdir -p "$(dirname "${target_dir}")"
  prepared="$(mktemp -d "${target_dir}.restore-XXXXXX")"
  cp -a "${archive_root}/." "${prepared}/"
  ensure_runtime_env_file "${prepared}"
  ensure_data_permissions "${prepared}"
  if [[ -e "${target_dir}" ]]; then
    (cd "${target_dir}" && compose_cmd stop)
    previous_dir="${target_dir}.before-restore-$(date +%Y%m%d_%H%M%S)"
    [[ ! -e "${previous_dir}" ]] || die "回退目录已存在，请稍后重试。"
    mv "${target_dir}" "${previous_dir}"
    info "原部署已保留：${previous_dir}"
  fi
  mv "${prepared}" "${target_dir}"
  if ! (cd "${target_dir}" && compose_cmd up -d --build --force-recreate && wait_service_ready); then
    warn "恢复版本启动失败，新目录已保留。"
    if [[ -n "${previous_dir:-}" ]]; then
      (cd "${target_dir}" && compose_cmd down) || true
      mv "${target_dir}" "${target_dir}.failed-$(date +%Y%m%d_%H%M%S)"
      mv "${previous_dir}" "${target_dir}"
      (cd "${target_dir}" && compose_cmd up -d --force-recreate) || true
    fi
    die "恢复失败，请检查日志；原数据未被覆盖。"
  fi
  echo "${target_dir}" > "${STATE_FILE}"
  print_access_info "${target_dir}/.env"
)
restore_backup() {
  restore_service
}

setup_auto_backup() {
  require_cmd crontab

  local workdir
  workdir="$(get_workdir)"
  if [[ -z "${workdir}" ]]; then
    err "未检测到已部署实例，无法配置定时备份。"
    return
  fi

  local cron_script existing_cron
  cron_script="${workdir}/cron_backup.sh"
  existing_cron="$(crontab -l 2>/dev/null | sed -n "/^${CRON_TAG_BEGIN}$/,/^${CRON_TAG_END}$/p" | grep -v '^#' || true)"

  if [[ -n "${existing_cron}" ]]; then
    echo "当前定时备份任务:"
    echo "${existing_cron}"
    local reset_cron
    read -r -p "是否覆盖现有定时备份任务? (y/N): " reset_cron
    if [[ ! "${reset_cron}" =~ ^[Yy]$ ]]; then
      info "保留现有定时备份任务。"
      return
    fi
  fi

  echo "1) 按分钟间隔备份"
  echo "2) 每天固定时间备份"
  echo "3) 删除定时备份任务"

  local cron_type
  read -r -p "请选择 [1/2/3]: " cron_type

  local cron_spec=""
  if [[ "${cron_type}" == "1" ]]; then
    local interval
    read -r -p "分钟间隔 [1,2,3,4,5,6,10,12,15,20,30]: " interval
    case "${interval}" in
      1|2|3|4|5|6|10|12|15|20|30) cron_spec="*/${interval} * * * *" ;;
      *) err "不支持该时间间隔。"; return ;;
    esac
  elif [[ "${cron_type}" == "2" ]]; then
    local cron_time hour minute
    read -r -p "每天执行时间 (HH:MM): " cron_time
    if [[ ! "${cron_time}" =~ ^([0-1][0-9]|2[0-3]):[0-5][0-9]$ ]]; then
      err "时间格式不正确。"
      return
    fi
    hour="${cron_time%:*}"
    minute="${cron_time#*:}"
    hour="${hour#0}"
    minute="${minute#0}"
    [[ -z "${hour}" ]] && hour="0"
    [[ -z "${minute}" ]] && minute="0"
    cron_spec="${minute} ${hour} * * *"
  elif [[ "${cron_type}" == "3" ]]; then
    local tmp_cron
    tmp_cron="$(mktemp)"
    crontab -l 2>/dev/null | sed "/^${CRON_TAG_BEGIN}$/,/^${CRON_TAG_END}$/d" > "${tmp_cron}" || true
    crontab "${tmp_cron}" 2>/dev/null || true
    rm -f "${tmp_cron}" "${cron_script}"
    info "定时备份任务已删除。"
    return
  else
    err "无效选项。"
    return
  fi

  cat > "${cron_script}" <<EOF
#!/usr/bin/env bash
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:\$PATH"
cd "${workdir}" || exit 1
bash "${workdir}/manage.sh" run-backup
EOF
  chmod +x "${cron_script}"

  local tmp_cron
  tmp_cron="$(mktemp)"
  crontab -l 2>/dev/null | sed "/^${CRON_TAG_BEGIN}$/,/^${CRON_TAG_END}$/d" > "${tmp_cron}" || true
  cat >> "${tmp_cron}" <<EOF
${CRON_TAG_BEGIN}
${cron_spec} bash ${cron_script} >> ${BACKUP_LOG} 2>&1
${CRON_TAG_END}
EOF
  crontab "${tmp_cron}"
  rm -f "${tmp_cron}"

  info "已设置定时备份: ${cron_spec}"
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

install_ftp() {
  require_cmd curl
  bash <(curl -fsSL https://raw.githubusercontent.com/hiapb/ftp/main/back.sh)
}

install_s3() {
  require_cmd curl
  bash <(curl -fsSL https://raw.githubusercontent.com/hiapb/bs3/main/install.sh)
}

main_menu() {
  if command -v clear >/dev/null 2>&1; then
    clear
  fi

  local workdir
  workdir="$(get_workdir)"

  echo "=================================================="
  echo "              NuroSSH 管理脚本"
  echo "=================================================="
  echo " 当前部署路径: ${workdir:-未部署}"
  echo "--------------------------------------------------"
  echo " 1) 一键部署"
  echo " 2) 升级服务"
  echo " 3) 停止服务"
  echo " 4) 重启服务"
  echo " 5) 手动备份"
  echo " 6) 恢复备份"
  echo " 7) 定时备份"
  echo " 8) 完全卸载"
  echo " 9) 📁 FTP/SFTP 备份工具"
  echo "10) 📂 S3 备份工具"
  echo " 0) 退出"
  echo "=================================================="

  local choice
  read -r -p "请选择操作 [0-10]: " choice
  case "${choice}" in
    1) deploy_service ;;
    2) upgrade_service ;;
    3) pause_service ;;
    4) restart_service ;;
    5) do_backup ;;
    6) restore_backup ;;
    7) setup_auto_backup ;;
    8) uninstall_service ;;
    9) install_ftp ;;
    10) install_s3 ;;
    0) info "再见"; exit 0 ;;
    *) warn "无效选项。" ;;
  esac
}

dispatch_command() {
  case "${1:-}" in
    run-backup) do_backup ;;
    install) deploy_service ;;
    upgrade) upgrade_service ;;
    stop) pause_service ;;
    restart) restart_service ;;
    backup) do_backup ;;
    restore) restore_backup ;;
    cron) setup_auto_backup ;;
    uninstall) uninstall_service ;;
    "")
      while true; do
        main_menu
        echo
        read -r -p "按回车返回主菜单..."
      done
      ;;
    *)
      err "不支持的命令: ${1}"
      echo "可用命令: install | upgrade | stop | restart | backup | restore | cron | uninstall | run-backup"
      exit 1
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  require_root
  dispatch_command "${1:-}"
fi
