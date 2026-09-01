#!/usr/bin/env bash
set -euo pipefail

backup_scope="${1:-}"
if [[ "$backup_scope" != critical && "$backup_scope" != static ]]; then
  echo 'Usage: stream-production.sh critical|static' >&2
  exit 2
fi

umask 077
exec 8>/run/lock/leitbild-backup.lock
flock -n 8 || { echo 'Another Leitbild backup is active' >&2; exit 1; }
exec 9>/run/lock/leitbild-deploy.lock
flock -n 9 || { echo 'A Leitbild deployment is active' >&2; exit 1; }

backup_temp_root="$(mktemp -d /tmp/leitbild-backup.XXXXXX)"
backup_metadata_dir="$backup_temp_root/backup-metadata"
mkdir "$backup_metadata_dir"

backup_services=(leitbild-world.service leitbild-agents.service leitbild-host.service)
backup_services_stopped=0

backup_wait_for_health() {
  local backup_port="$1"
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null "http://127.0.0.1:${backup_port}/health"; then return 0; fi
    sleep 1
  done
  return 1
}

backup_restart_services() {
  [[ "$backup_services_stopped" -eq 1 ]] || return 0
  local backup_restart_failed=0
  systemctl start "${backup_services[@]}" || backup_restart_failed=1
  for backup_port in 4177 3000 3100; do
    if ! backup_wait_for_health "$backup_port"; then
      echo "Leitbild service on port ${backup_port} did not recover after backup" >&2
      backup_restart_failed=1
    fi
  done
  [[ "$backup_restart_failed" -eq 0 ]] || return 1
  backup_services_stopped=0
}

backup_cleanup() {
  local backup_exit_code=$?
  trap - EXIT
  if [[ "$backup_services_stopped" -eq 1 ]]; then
    backup_restart_services || backup_exit_code=1
  fi
  rm -rf -- "$backup_temp_root"
  exit "$backup_exit_code"
}
trap backup_cleanup EXIT HUP INT TERM

if [[ "$backup_scope" == critical ]]; then
  for backup_service in "${backup_services[@]}"; do
    systemctl is-active --quiet "$backup_service" || {
      echo "Refusing critical backup because ${backup_service} is not active" >&2
      exit 1
    }
    systemctl cat "$backup_service" > "$backup_metadata_dir/${backup_service}.txt"
  done

  docker inspect leitbild-osrm > "$backup_metadata_dir/leitbild-osrm.inspect.json"
  readlink -f /opt/leitbild/current > "$backup_metadata_dir/current-release.txt"
  caddy version > "$backup_metadata_dir/caddy-version.txt" 2>&1

  backup_services_stopped=1
  systemctl stop "${backup_services[@]}"

  backup_archive="$backup_temp_root/critical.tar"
  tar --acls --xattrs --numeric-owner -cf "$backup_archive" -C / \
    var/lib/leitbild \
    etc/caddy/Caddyfile \
    etc/systemd/system/leitbild-world.service \
    etc/systemd/system/leitbild-agents.service \
    etc/systemd/system/leitbild-host.service \
    etc/leitbild \
    etc/ssh/sshd_config \
    etc/ssh/sshd_config.d \
    etc/ufw \
    -C "$backup_temp_root" backup-metadata
  backup_restart_services
  cat "$backup_archive"
else
  tar --acls --xattrs --numeric-owner -cf - -C / \
    opt/leitbild/maps \
    opt/leitbild/reference \
    opt/leitbild/osrm-data
fi
