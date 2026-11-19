const quote = value => `'${String(value).replace(/'/g, "'\\''")}'`;

// Self-contained POSIX sh, bootstrapping curl when missing. The credential is used
// only for the final panel request, never for public IP discovery services.
export function poolLocalIpCommand(endpoint, token, family = 'ipv4') {
  if (!['ipv4', 'ipv6'].includes(family)) throw Error('请选择 IPv4 或 IPv6');
  const version = family === 'ipv4' ? 4 : 6;
  const services = version === 4
    ? ['https://api.ipify.org', 'https://ipv4.icanhazip.com']
    : ['https://api6.ipify.org', 'https://ipv6.icanhazip.com'];
  return `sh <<'NUROSSH_POOL_LOCAL_IP'
run_as_root() {
  if [ "$(id -u)" = 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    printf '%s\\n' '安装 curl 需要 root 或 sudo 权限，请使用 root 重新运行。' >&2
    return 1
  fi
}
ensure_curl() {
  if command -v curl >/dev/null 2>&1; then return 0; fi
  printf '%s\\n' '未安装 curl，正在安装 curl 和 HTTPS 证书…'
  if command -v apt-get >/dev/null 2>&1; then
    run_as_root apt-get update && run_as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates
  elif command -v dnf >/dev/null 2>&1; then
    run_as_root dnf install -y curl ca-certificates
  elif command -v yum >/dev/null 2>&1; then
    run_as_root yum install -y curl ca-certificates
  elif command -v apk >/dev/null 2>&1; then
    run_as_root apk add --no-cache curl ca-certificates
  elif command -v zypper >/dev/null 2>&1; then
    run_as_root zypper --non-interactive install curl ca-certificates
  elif command -v pacman >/dev/null 2>&1; then
    run_as_root pacman -S --noconfirm --needed curl ca-certificates
  else
    printf '%s\\n' '未找到支持的包管理器，请手动安装 curl 后重新运行。' >&2
    return 1
  fi || return 1
  command -v curl >/dev/null 2>&1
}
lookup_ip() {
  for service in ${services.map(quote).join(' ')}; do
    candidate=$(curl -q -${version} -fsS --noproxy '*' --connect-timeout 4 --max-time 8 "$service" 2>/dev/null) || continue
    candidate=$(printf '%s' "$candidate" | tr -d '\\r\\n')
    case "$candidate" in
      ${version === 4 ? "''|*[!0-9.]*|*.*.*.*.*" : "''|*[!0-9a-fA-F:]*"}) continue ;;
    esac
    case "$candidate" in
      ${version === 4 ? '*.*.*.*' : '*:*'}) printf '%s\\n' "$candidate"; return 0 ;;
    esac
  done
  return 1
}
main() {
  ensure_curl || {
    printf '%s\\n' 'curl 安装失败，未向备用池提交。' >&2
    return 1
  }
  detected_ip=$(lookup_ip) || {
    printf '%s\\n' '未获取到公网出口 IPv${version}，未向备用池提交。' >&2
    return 1
  }
  printf '将加入备用池的公网出口 IPv${version}：%s\\n' "$detected_ip"
  printf '%s\\n' "$detected_ip" | curl -q -fsS --connect-timeout 10 --max-time 30 \\
    -X POST ${quote(endpoint)} \\
    -H ${quote(`Authorization: Bearer ${token}`)} \\
    -H 'Content-Type: text/plain' \\
    --data-binary @-
}
main
NUROSSH_POOL_LOCAL_IP`;
}
