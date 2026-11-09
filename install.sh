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

ensure_host_dependencies() {
  local scope="${1:-basic}" command_name
  local need_python=0 need_flock=0 need_curl=0 need_tar=0 need_gzip=0 need_crontab=0
  if [[ "${scope}" == basic || "${scope}" == backup || "${scope}" == cron ]]; then
    command -v curl >/dev/null 2>&1 || need_curl=1
    command -v tar >/dev/null 2>&1 || need_tar=1
    command -v gzip >/dev/null 2>&1 || need_gzip=1
  fi
  if [[ "${scope}" == backup || "${scope}" == cron ]]; then
    command -v python3 >/dev/null 2>&1 && python3 -c 'import sqlite3' >/dev/null 2>&1 || need_python=1
    command -v flock >/dev/null 2>&1 || need_flock=1
  fi
  if [[ "${scope}" == cron ]]; then
    command -v crontab >/dev/null 2>&1 || need_crontab=1
  fi
  if (( !need_python && !need_flock && !need_curl && !need_tar && !need_gzip && !need_crontab )); then
    return 0
  fi

  local manager="" packages=()
  if command -v apt-get >/dev/null 2>&1; then
    manager=apt
    (( need_python )) && packages+=(python3)
    (( need_flock )) && packages+=(util-linux)
    (( need_curl )) && packages+=(curl)
    (( need_tar )) && packages+=(tar)
    (( need_gzip )) && packages+=(gzip)
    (( need_crontab )) && packages+=(cron)
  elif command -v dnf >/dev/null 2>&1; then
    manager=dnf
    (( need_python )) && packages+=(python3)
    (( need_flock )) && packages+=(util-linux)
    (( need_curl )) && packages+=(curl)
    (( need_tar )) && packages+=(tar)
    (( need_gzip )) && packages+=(gzip)
    (( need_crontab )) && packages+=(cronie)
  elif command -v yum >/dev/null 2>&1; then
    manager=yum
    (( need_python )) && packages+=(python3)
    (( need_flock )) && packages+=(util-linux)
    (( need_curl )) && packages+=(curl)
    (( need_tar )) && packages+=(tar)
    (( need_gzip )) && packages+=(gzip)
    (( need_crontab )) && packages+=(cronie)
  elif command -v apk >/dev/null 2>&1; then
    manager=apk
    (( need_python )) && packages+=(python3)
    (( need_flock )) && packages+=(util-linux)
    (( need_curl )) && packages+=(curl)
    (( need_tar )) && packages+=(tar)
    (( need_gzip )) && packages+=(gzip)
    (( need_crontab )) && packages+=(dcron)
  elif command -v zypper >/dev/null 2>&1; then
    manager=zypper
    (( need_python )) && packages+=(python3)
    (( need_flock )) && packages+=(util-linux)
    (( need_curl )) && packages+=(curl)
    (( need_tar )) && packages+=(tar)
    (( need_gzip )) && packages+=(gzip)
    (( need_crontab )) && packages+=(cron)
  else
    die "缺少系统依赖，且未找到 apt/dnf/yum/apk/zypper，无法自动安装。"
  fi

  info "检测到缺少系统依赖，准备自动安装：${packages[*]}"
  case "${manager}" in
    apt)
      export DEBIAN_FRONTEND=noninteractive
      apt-get update
      apt-get install -y --no-install-recommends "${packages[@]}"
      ;;
    dnf) dnf install -y "${packages[@]}" ;;
    yum) yum install -y "${packages[@]}" ;;
    apk) apk add --no-cache "${packages[@]}" ;;
    zypper) zypper --non-interactive install --no-recommends "${packages[@]}" ;;
  esac

  (( need_python )) && { command -v python3 >/dev/null 2>&1 && python3 -c 'import sqlite3' >/dev/null 2>&1; } || true
  for command_name in curl tar gzip; do
    if [[ "${scope}" == basic || "${scope}" == backup || "${scope}" == cron ]] && ! command -v "${command_name}" >/dev/null 2>&1; then
      die "自动安装后仍缺少依赖：${command_name}"
    fi
  done
  if [[ "${scope}" == backup || "${scope}" == cron ]]; then
    command -v flock >/dev/null 2>&1 || die "自动安装后仍缺少依赖：flock"
    command -v python3 >/dev/null 2>&1 && python3 -c 'import sqlite3' >/dev/null 2>&1 || die "自动安装后 Python 缺少 sqlite3 模块"
  fi
  [[ "${scope}" != cron || -x "$(command -v crontab 2>/dev/null || true)" ]] || die "自动安装后仍缺少依赖：crontab"
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
  local files=() configured separator candidate
  if [[ -f docker-compose.storage.yml ]]; then
    # Explicit -f disables Compose's automatic overrides. Preserve those and
    # COMPOSE_FILE before appending our independent persistent key mount.
    configured="${COMPOSE_FILE:-$(read_env_value .env COMPOSE_FILE)}"
    configured="${configured#\"}"; configured="${configured%\"}"
    configured="${configured#\'}"; configured="${configured%\'}"
    if [[ -n "${configured}" ]]; then
      separator="${COMPOSE_PATH_SEPARATOR:-$(read_env_value .env COMPOSE_PATH_SEPARATOR ':')}"
      local configured_files=()
      IFS="${separator}" read -r -a configured_files <<< "${configured}"
      for candidate in "${configured_files[@]}"; do
        [[ -z "${candidate}" ]] || files+=(-f "${candidate}")
      done
    else
      for candidate in compose.yaml compose.yml docker-compose.yaml docker-compose.yml; do
        if [[ -f "${candidate}" ]]; then files+=(-f "${candidate}"); break; fi
      done
      for candidate in compose.override.yaml compose.override.yml docker-compose.override.yaml docker-compose.override.yml; do
        if [[ -f "${candidate}" ]]; then files+=(-f "${candidate}"); break; fi
      done
    fi
    files+=(-f docker-compose.storage.yml)
  fi
  [[ ! -f docker-compose.tg.yml ]] || files+=(-f docker-compose.tg.yml)
  if command -v docker-compose >/dev/null 2>&1; then
    docker-compose "${files[@]}" "$@"
  else
    docker compose "${files[@]}" "$@"
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
  ensure_host_dependencies basic

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
    --exclude='./secrets' \
    --exclude='./tg-browser-data' \
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
      - ./secrets:/app/secrets
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
  mkdir -p "${install_path}/secrets"
  chown 10001:10001 "${install_path}/secrets"
  chmod 700 "${install_path}/secrets"
}

ensure_storage_mount() {
  local workdir="$1"
  # Merge a separate persistent key mount without rewriting custom Compose settings.
  cat > "${workdir}/docker-compose.storage.yml" <<'EOF'
services:
  nurossh:
    volumes:
      - ./secrets:/app/secrets
EOF
  ensure_tg_hosting_mount "${workdir}"
}

ensure_tg_hosting_mount() {
  local workdir="$1"
  [[ "$(read_env_value "${workdir}/.env" TG_HOSTING_ENABLED)" == 1 ]] || return 0
  [[ -f "${workdir}/app/docker-compose.tg.yml" ]] || die "缺少 TG 托管组件部署模板，请先升级服务。"
  sed 's|context: \.$|context: ./app|' "${workdir}/app/docker-compose.tg.yml" > "${workdir}/docker-compose.tg.yml"
  mkdir -p "${workdir}/tg-browser-data" "${workdir}/data/tg-hosted-snapshots"
  chmod 700 "${workdir}/tg-browser-data" "${workdir}/data/tg-hosted-snapshots"
  chown 10001:10001 "${workdir}/tg-browser-data"
  chown 10001:10001 "${workdir}/data/tg-hosted-snapshots"
}

build_tg_browser() {
  [[ ! -f docker-compose.tg.yml ]] || compose_cmd --profile tg-image build tg-browser
}

stop_tg_browsers() {
  [[ -f docker-compose.tg.yml ]] || return 0
  [[ -z "$(compose_cmd ps -q --status running tg-runner)" ]] || compose_cmd exec -T tg-runner node --input-type=module -e 'import http from "node:http";const req=http.request({socketPath:"/control/runner.sock",path:"/shutdown",method:"POST",timeout:300000},res=>{res.resume();res.on("end",()=>process.exit(res.statusCode===200?0:1))});req.on("error",()=>process.exit(1));req.on("timeout",()=>req.destroy());req.end();'
}

wait_tg_runner_transport() {
  local attempt
  # An unconfigured runner returns 503. Its socket must still accept requests
  # before the backup helper can perform /configure and acquire its lease.
  for attempt in $(seq 1 20); do
    if compose_cmd exec -T tg-runner node --input-type=module -e 'import http from "node:http";const req=http.get({socketPath:"/control/runner.sock",path:"/status",timeout:2000},res=>{res.resume();res.on("end",()=>process.exit([200,503].includes(res.statusCode)?0:1));res.on("error",()=>process.exit(1))});req.on("error",()=>process.exit(1));req.on("timeout",()=>req.destroy());' >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

prepare_tg_upgrade_backup() (
  set -euo pipefail
  local bundle="${1:-}" minimum container stage image_ref previous_image running
  [[ -n "${bundle}" && -f docker-compose.tg.yml ]] || return 0
  container="$(compose_cmd ps -a -q tg-runner)"
  [[ -n "${container}" ]] || return 0
  minimum="$(docker version --format '{{.Server.MinAPIVersion}}')"
  # Only the known old-client/new-engine incompatibility needs a bootstrap.
  if ! python3 - "${minimum}" <<'PY'
import re, sys
value = sys.argv[1]
sys.exit(0 if re.fullmatch(r'1\.\d+', value) and int(value.split('.')[1]) > 41 else 1)
PY
  then
    return 0
  fi
  stage="$(mktemp -d)"
  trap 'rm -rf -- "${stage}"' EXIT
  docker cp "${container}:/runtime/runner.mjs" "${stage}/runner.mjs"
  grep -Fq '/v1.41${endpoint}' "${stage}/runner.mjs" || return 0
  [[ -f "${bundle}/shared/tg-docker.js" && -f "${bundle}/tg-hosting/Dockerfile" ]] && grep -Fq createTgDockerClient "${bundle}/tg-hosting/runner.mjs" || die "新版源码缺少 Docker API 兼容修复，未继续升级；请使用包含修复的完整源码。"
  image_ref="$(docker inspect --format '{{.Config.Image}}' "${container}")"
  previous_image="$(docker inspect --format '{{.Image}}' "${container}")"
  running="$(docker inspect --format '{{.State.Running}}' "${container}")"
  [[ -n "${image_ref}" && "${image_ref}" != *@* && "${image_ref}" != sha256:* && -n "${previous_image}" ]] || die "无法确认托管组件镜像标签，未继续升级；原组件和数据未修改。"
  info "检测到旧托管组件 API v1.41 与 Docker 最低版本 ${minimum} 不兼容；先更新独立组件，再进行完整备份。"
  # Build first, while existing browsers and the panel keep running. Replacing
  # the runner does not stop/delete account containers or their profile mounts.
  docker build --target runner --file "${bundle}/tg-hosting/Dockerfile" --tag "${image_ref}" "${bundle}" || die "兼容组件构建失败，原组件仍保留，未继续升级。"
  # A stopped deployment stays cold. backup_service starts a temporary runner
  # with desired=false, so an offline backup cannot activate restored sessions.
  if [[ "${running}" != true && -z "$(compose_cmd ps -q --status running nurossh)" ]]; then
    return 0
  fi
  if ! { compose_cmd up -d --no-deps --no-build tg-runner && wait_tg_runner_transport; }; then
    warn "兼容组件启动失败，正在恢复原组件镜像；本次升级已取消。"
    docker image tag "${previous_image}" "${image_ref}"
    compose_cmd up -d --no-deps --no-build tg-runner || true
    die "托管组件未就绪，未跳过备份，也未更新面板和数据。"
  fi
)

wait_tg_hosting_ready() {
  local attempt
  # Probe as the panel user, through its own socket mount. A running container
  # alone does not prove the panel can connect or initialize the component.
  for attempt in $(seq 1 30); do
    if compose_cmd exec -T nurossh node --input-type=module -e 'import http from "node:http";const socketPath=process.env.TG_HOSTING_SOCKET;if(!socketPath)process.exit(1);const req=http.get({socketPath,path:"/status",timeout:2000},res=>{let body="";res.on("data",chunk=>{body+=chunk;if(body.length>8*1024*1024)req.destroy()});res.on("end",()=>{try{const data=JSON.parse(body);process.exit(res.statusCode===200&&Array.isArray(data.accounts)?0:1)}catch{process.exit(1)}});res.on("error",()=>process.exit(1))});req.on("error",()=>process.exit(1));req.on("timeout",()=>req.destroy());' >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

enable_tg_hosting() {
  require_docker; require_compose
  local workdir
  workdir="$(get_workdir)"
  [[ -n "${workdir}" ]] || die "请先部署面板。"
  [[ -f "${workdir}/app/docker-compose.tg.yml" ]] || die "请先使用菜单 2 升级服务。"
  info "将安装独立浏览器组件：组件需要 Docker 管理权限，面板本身不挂载 Docker socket。"
  info "默认最多运行 2 个账号，每个账号上限 1 GB 内存；无空闲资源时排队。首次下载浏览器镜像较大。"
  grep -q '^TG_HOSTING_ENABLED=' "${workdir}/.env" && sed -i 's/^TG_HOSTING_ENABLED=.*/TG_HOSTING_ENABLED=1/' "${workdir}/.env" || printf '\nTG_HOSTING_ENABLED=1\n' >> "${workdir}/.env"
  ensure_storage_mount "${workdir}"
  (cd "${workdir}" && build_tg_browser && compose_cmd up -d --build && wait_service_ready && wait_tg_hosting_ready) || die "托管组件尚未就绪，请查看 docker compose -f docker-compose.yml -f docker-compose.storage.yml -f docker-compose.tg.yml logs --tail=80 tg-runner；账号资料未清除。"
  info "TG 托管组件已连接。刷新面板，点击已创建账号的「打开」即可扫码登录，无需重新添加账号。"
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
  ensure_host_dependencies basic

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
  ensure_storage_mount "${install_path}"
  copy_manage_script "${install_path}" "${bundle_dir}"

  echo "${install_path}" > "${STATE_FILE}"

  (
    cd "${install_path}" || exit 1
    build_tg_browser && compose_cmd up -d --build
  )

  print_access_info "${install_path}/.env"
}

wait_service_ready() {
  local attempt check_status
  for attempt in $(seq 1 300); do
    if compose_cmd exec -T nurossh node -e 'const http=require("node:http");const host=["0.0.0.0","::",""].includes(process.env.HOST||"")?"127.0.0.1":process.env.HOST;const req=http.get({host,port:process.env.PORT||38471,path:"/api/auth/status",timeout:1500},res=>{let body="";res.on("data",chunk=>body+=chunk);res.on("end",()=>{try{const result=JSON.parse(body);process.exit(res.statusCode===200&&typeof result.configured==="boolean"?0:result.code==="STORAGE_INITIALIZING"?2:1)}catch{process.exit(1)}})});req.on("timeout",()=>req.destroy());req.on("error",()=>process.exit(1));' >/dev/null 2>&1; then
      return 0
    else
      check_status=$?
      # Large first-time encryption may outlast ordinary startup. Failures keep
      # the usual timeout; only explicit ongoing migration gets more time.
      if [[ "${check_status}" -ne 2 && "${attempt}" -ge 20 ]]; then return 1; fi
    fi
    sleep 2
  done
  return 1
}

upgrade_service() {
  require_docker
  require_compose
  ensure_host_dependencies backup

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
  ensure_storage_mount "${workdir}"
  copy_manage_script "${workdir}" "${bundle_dir}"

  if ! (
    cd "${workdir}" || exit 1
    build_tg_browser && compose_cmd up -d --build && wait_service_ready
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
    stop_tg_browsers && compose_cmd stop
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

backup_key_file() {
  local workdir="$1" db_path configured_master
  db_path="$(read_env_value "${workdir}/.env" SQLITE_DB_PATH /app/data/app.db)"
  configured_master="$(read_env_value "${workdir}/.env" MASTER_KEY_FILE '')"
  python3 - "${workdir}" "${db_path}" "${configured_master}" <<'PY'
import os, secrets, sqlite3, sys
from pathlib import Path
root, database, custom = sys.argv[1:]
database = database.strip().strip('"').strip("'")
custom = custom.strip().strip('"').strip("'")
if not database.startswith('/app/data/') or '/../' in database:
    raise SystemExit('数据库必须位于 /app/data 持久化目录')
directory = Path(root) / 'secrets'
file = directory / 'master.key'
if directory.is_symlink() or file.is_symlink():
    raise SystemExit('主密钥路径不能是符号链接')
if not file.exists():
    dbfile = Path(root) / 'data' / database[len('/app/data/'):]
    if dbfile.exists() and not custom:
        with sqlite3.connect(f'file:{dbfile}?mode=ro', uri=True) as db:
            row = db.execute("SELECT value FROM app_kv WHERE key='secret'").fetchone()
            if row and row[0].startswith('wrapped-v1:'):
                raise SystemExit('缺少原 secrets/master.key，禁止生成替代密钥，请先恢复原密钥')
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    with open(file, 'x', opener=lambda name, flags: os.open(name, flags, 0o600)) as stream:
        stream.write(secrets.token_hex(32) + '\n')
        stream.flush()
        os.fsync(stream.fileno())
    if os.geteuid() == 0:
        os.chown(directory, 10001, 10001)
        os.chown(file, 10001, 10001)
    directory_fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
print(file.resolve())
PY
}

run_backup_codec() {
  local helper="$1" mode="$2" key_file="$3" codec key_owner
  codec="$(cat "${helper}")"
  key_owner="$(python3 -c 'import os,sys; s=os.stat(sys.argv[1]); print(f"{s.st_uid}:{s.st_gid}")' "${key_file}")"
  docker run --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --user "${key_owner}" \
    -v "${key_file}:/run/backup-key:ro" --entrypoint node node:22-alpine \
    -e "${codec}" "${mode}" /run/backup-key
}

backup_service() (
  set -euo pipefail
  umask 077
  require_docker
  require_compose
  ensure_host_dependencies backup
  local workdir helper archive_helper crypto_helper key_file stage snapshot timestamp db_path backup_file
  workdir="$(get_workdir)"
  [[ -n "${workdir}" ]] || die "未检测到已部署实例。"
  helper="$(management_helper storage-backup.js "${1:-}")"
  archive_helper="$(management_helper backup-archive.py "${1:-}")"
  crypto_helper="$(management_helper backup-crypto.cjs "${1:-}")"
  mkdir -p "${workdir}/backups"
  exec 9>"${workdir}/backups/.backup.lock"
  flock -n 9 || die "已有备份正在执行，请稍后重试。"
  # The old runner may be the very component this upgrade fixes. Repair only
  # that compatibility deadlock, under the same lock, before asking it to back up.
  (cd "${workdir}" && prepare_tg_upgrade_backup "${1:-}")
  key_file="$(backup_key_file "${workdir}")"
  stage="$(mktemp -d "${workdir}/backups/.stage-XXXXXX")"
  snapshot=".backup-${stage##*/}"
  trap "$(printf 'rm -rf -- %q %q' "${stage}" "${workdir}/data/${snapshot}")" EXIT
  timestamp="$(date +%Y%m%d_%H%M%S)"
  backup_file="${workdir}/backups/${APP_NAME}_backup_${timestamp}_${stage##*-}.tar.gz.enc"
  db_path="$(read_env_value "${workdir}/.env" SQLITE_DB_PATH "/app/data/app.db")"
  db_path="${db_path%\"}"; db_path="${db_path#\"}"
  db_path="${db_path%\'}"; db_path="${db_path#\'}"
  [[ "${db_path}" == /app/data/* && "${db_path}" != *"/../"* ]] || die "数据库必须位于 /app/data 持久化目录，已停止备份以避免遗漏自定义数据库。"
  (
    cd "${workdir}"
    if [[ -n "$(compose_cmd ps -q --status running nurossh)" ]]; then
      compose_cmd exec -T nurossh node --input-type=module - /app/data "/app/data/${snapshot}" "${db_path}" < "${helper}"
    else
      local backup_runner_started=0
      if [[ -f docker-compose.tg.yml && -z "$(compose_cmd ps -q --status running tg-runner)" ]]; then
        compose_cmd up -d --no-deps tg-runner
        backup_runner_started=1
        trap 'compose_cmd stop tg-runner >/dev/null 2>&1 || true' EXIT
        wait_tg_runner_transport || die "临时托管组件未就绪，未继续备份。"
      fi
      compose_cmd run --rm --no-deps -T -e "TG_HOSTING_BACKUP_COLD=${backup_runner_started}" nurossh node --input-type=module - /app/data "/app/data/${snapshot}" "${db_path}" < "${helper}"
    fi
  )
  mv "${workdir}/data/${snapshot}" "${stage}/data"
  cp -p "${workdir}/.env" "${workdir}/docker-compose.yml" "${workdir}/manage.sh" "${stage}/"
  mkdir "${stage}/app"
  tar --exclude='./node_modules' --exclude='./.git' --exclude='./data' --exclude='./backups' --exclude='./secrets' --exclude='./tg-browser-data' --exclude='./.env' --exclude='./dist' --exclude='__pycache__' -cf - -C "${workdir}/app" . | tar -xf - -C "${stage}/app"
  python3 "${archive_helper}" manifest "${stage}"
  # Fast compression reduces CPU spent on large attachments. Publish only a complete archive.
  tar -cf - -C "${stage}" . | gzip -1 | run_backup_codec "${crypto_helper}" encrypt "${key_file}" > "${backup_file}.partial"
  mv "${backup_file}.partial" "${backup_file}"
  info "一致性备份已创建：${backup_file}"
  info "备份已加密。请将 ${key_file} 单独保管；恢复到其他机器时需要原密钥，密钥不包含在备份中。"
  if ! python3 "${archive_helper}" prune "${workdir}/backups" "${backup_file##*/}"; then
    warn "新备份已保存，但旧备份清理失败，请检查 backups 目录权限。"
  fi
)

do_backup() {
  backup_service
}

restore_service() (
  set -euo pipefail
  umask 077
  require_docker
  require_compose
  ensure_host_dependencies backup
  local backup_path target_dir input_path archive_root previous_dir helper confirm_restore key_file='' crypto_helper decrypted_archive=''
  read -r -p "备份压缩包路径: " backup_path
  [[ -f "${backup_path}" ]] || die "未找到备份文件。"
  backup_path="$(readlink -f "${backup_path}")"
  helper="$(management_helper backup-archive.py)"
  archive_root="$(mktemp -d)"
  trap 'rm -rf -- "${archive_root}"; [[ -z "${decrypted_archive}" ]] || rm -f -- "${decrypted_archive}"' EXIT
  info "正在校验备份和数据库，校验结束前不会停止现有服务。"
  if python3 - "${backup_path}" <<'PY'
import sys
with open(sys.argv[1], 'rb') as stream:
    magic = b'NUROSSH-BACKUP-1\n'
    sys.exit(0 if stream.read(len(magic)) == magic else 1)
PY
  then
    key_file="$(dirname "$(dirname "${backup_path}")")/secrets/master.key"
    if [[ ! -f "${key_file}" ]]; then
      read -r -p "加密备份的原主密钥文件路径（secrets/master.key）: " key_file
    fi
    [[ -f "${key_file}" ]] || die "未找到原主密钥，未执行恢复。"
    key_file="$(readlink -f "${key_file}")"
    crypto_helper="$(management_helper backup-crypto.cjs)"
    decrypted_archive="$(mktemp)"
    run_backup_codec "${crypto_helper}" decrypt "${key_file}" < "${backup_path}" > "${decrypted_archive}" || die "备份解密失败，原部署未修改。"
    python3 "${helper}" extract "${decrypted_archive}" "${archive_root}"
    rm -f -- "${decrypted_archive}"; decrypted_archive=''
  else
    python3 "${helper}" extract "${backup_path}" "${archive_root}"
  fi
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
  if [[ -n "${key_file}" ]]; then
    mkdir -p "${prepared}/secrets"
    cp "${key_file}" "${prepared}/secrets/master.key"
    chmod 600 "${prepared}/secrets/master.key"
    if [[ "${EUID}" -eq 0 ]]; then chown 10001:10001 "${prepared}/secrets/master.key"; fi
  elif [[ -f "${target_dir}/secrets/master.key" ]]; then
    mkdir -p "${prepared}/secrets"
    cp -p "${target_dir}/secrets/master.key" "${prepared}/secrets/master.key"
  fi
  ensure_runtime_env_file "${prepared}"
  mark_tg_hosting_restore "${prepared}"
  ensure_data_permissions "${prepared}"
  ensure_storage_mount "${prepared}"
  if [[ -e "${target_dir}" ]]; then
    (cd "${target_dir}" && stop_tg_browsers && compose_cmd stop)
    previous_dir="${target_dir}.before-restore-$(date +%Y%m%d_%H%M%S)"
    [[ ! -e "${previous_dir}" ]] || die "回退目录已存在，请稍后重试。"
    mv "${target_dir}" "${previous_dir}"
    info "原部署已保留：${previous_dir}"
  fi
  mv "${prepared}" "${target_dir}"
  if ! (cd "${target_dir}" && build_tg_browser && compose_cmd up -d --build --force-recreate && wait_service_ready); then
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
mark_tg_hosting_restore() {
  local workdir="$1" db_path
  db_path="$(read_env_value "${workdir}/.env" SQLITE_DB_PATH /app/data/app.db)"
  python3 - "${workdir}" "${db_path}" <<'PY'
import json, os, sqlite3, sys, uuid
from pathlib import Path
from datetime import datetime, timezone
root = Path(sys.argv[1])
database = sys.argv[2].strip().strip('"').strip("'")
if not database.startswith('/app/data/') or '/../' in database:
    raise SystemExit('TG 托管恢复要求数据库位于持久化目录')
file = root / 'data' / database[len('/app/data/'):]
if not file.exists():
    sys.exit(0)
with sqlite3.connect(f'file:{file}?mode=ro', uri=True) as db:
    table = db.execute("SELECT 1 FROM sqlite_master WHERE name='tg_hosting_accounts'").fetchone()
    accounts = table and db.execute('SELECT 1 FROM tg_hosting_accounts LIMIT 1').fetchone()
if accounts:
    marker = root / 'data' / '.tg-hosting-restored.json'
    marker.unlink(missing_ok=True)
    with open(marker, 'x', opener=lambda name, flags: os.open(name, flags, 0o600)) as stream:
        json.dump({'id': str(uuid.uuid4()), 'restoredAt': datetime.now(timezone.utc).isoformat()}, stream)
        stream.flush()
        os.fsync(stream.fileno())
PY
}
restore_backup() {
  restore_service
}

setup_auto_backup() {
  ensure_host_dependencies cron

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
    stop_tg_browsers || die "浏览器停止失败，已取消卸载，避免删除使用中的登录资料。"
    compose_cmd down -v || true
  ) || die "停止或移除容器失败，已取消卸载。"

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
  echo "11) 💬 TG 托管组件"
  echo " 0) 退出"
  echo "=================================================="

  local choice
  read -r -p "请选择操作 [0-11]: " choice
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
    11) enable_tg_hosting ;;
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
    tg-hosting) enable_tg_hosting ;;
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
      echo "可用命令: install | upgrade | stop | restart | backup | restore | cron | uninstall | run-backup | tg-hosting"
      exit 1
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  require_root
  dispatch_command "${1:-}"
fi
