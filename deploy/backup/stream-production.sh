#!/usr/bin/env bash
set -euo pipefail

backup_scope="${1:-}"
if [[ "$backup_scope" != critical && "$backup_scope" != static ]]; then
  echo 'Usage: stream-production.sh critical|static' >&2
  exit 2
fi

umask 077
exec 8>/run/lock/samsinn-stack-backup.lock
flock -n 8 || { echo 'Another stack backup is active' >&2; exit 1; }
exec 9>/run/lock/samsinn-stack-deploy.lock
flock -n 9 || { echo 'A Samsinn/Leitbild deployment is active' >&2; exit 1; }

backup_temp_root="$(mktemp -d /tmp/samsinn-backup-metadata.XXXXXX)"
backup_metadata_dir="$backup_temp_root/backup-metadata"
mkdir "$backup_metadata_dir"

backup_samsinn_was_active=0
backup_leitbild_was_active=0
backup_services_stopped=0

backup_wait_for_health() {
  local backup_url="$1"
  for backup_attempt in $(seq 1 60); do
    if curl -fsS -o /dev/null "$backup_url"; then return 0; fi
    sleep 1
  done
  return 1
}

backup_cleanup() {
  local backup_exit_code=$?
  trap - EXIT
  if [[ "$backup_services_stopped" -eq 1 ]]; then
    if [[ "$backup_leitbild_was_active" -eq 1 ]]; then
      systemctl start leitbild.service || backup_exit_code=1
    fi
    if [[ "$backup_samsinn_was_active" -eq 1 ]]; then
      systemctl start samsinn.service || backup_exit_code=1
    fi
    if [[ "$backup_leitbild_was_active" -eq 1 ]] && ! backup_wait_for_health http://127.0.0.1:4177/health; then
      echo 'Leitbild did not recover after backup' >&2
      backup_exit_code=1
    fi
    if [[ "$backup_samsinn_was_active" -eq 1 ]] && ! backup_wait_for_health http://127.0.0.1:3000/health; then
      echo 'Samsinn did not recover after backup' >&2
      backup_exit_code=1
    fi
  fi
  rm -rf -- "$backup_temp_root"
  exit "$backup_exit_code"
}
trap backup_cleanup EXIT HUP INT TERM

if [[ "$backup_scope" == critical ]]; then
  systemctl is-active --quiet samsinn.service && backup_samsinn_was_active=1
  systemctl is-active --quiet leitbild.service && backup_leitbild_was_active=1
  [[ "$backup_samsinn_was_active" -eq 1 && "$backup_leitbild_was_active" -eq 1 ]] || {
    echo 'Refusing critical backup because both application services are not active' >&2
    exit 1
  }

  docker inspect leitbild-osrm > "$backup_metadata_dir/leitbild-osrm.inspect.json"
  readlink -f /opt/samsinn-deploy/current > "$backup_metadata_dir/samsinn-current-release.txt"
  readlink -f /opt/leitbild/current > "$backup_metadata_dir/leitbild-current-release.txt"
  systemctl cat samsinn.service > "$backup_metadata_dir/samsinn.service.txt"
  systemctl cat leitbild.service > "$backup_metadata_dir/leitbild.service.txt"
  caddy version > "$backup_metadata_dir/caddy-version.txt" 2>&1

  backup_services_stopped=1
  systemctl stop samsinn.service leitbild.service

  tar --acls --xattrs --numeric-owner -cf - -C / \
    var/lib/samsinn \
    opt/leitbild/data \
    etc/caddy/Caddyfile \
    etc/systemd/system/samsinn.service \
    etc/systemd/system/leitbild.service \
    etc/systemd/system/leitbild.service.d \
    etc/samsinn \
    etc/leitbild \
    etc/ssh/sshd_config \
    etc/ssh/sshd_config.d \
    etc/ufw \
    -C "$backup_temp_root" backup-metadata
else
  tar --acls --xattrs --numeric-owner -cf - -C / \
    opt/leitbild/maps \
    opt/leitbild/reference \
    opt/leitbild/osrm-data
fi
