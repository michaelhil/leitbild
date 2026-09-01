#!/usr/bin/env bash
set -euo pipefail

backup_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
backup_template_dir="$backup_script_dir/launchagents"
backup_account="$(id -un)"
backup_account_id="$(id -u)"
backup_account_root="$(dscl . -read "/Users/$backup_account" NFSHomeDirectory | awk '{print $2}')"
backup_launch_dir="$backup_account_root/Library/LaunchAgents"
backup_log_root="$backup_account_root/Documents/ChatGPT/server-backups/logs"

mkdir -p "$backup_launch_dir" "$backup_log_root"

for backup_template in "$backup_template_dir"/*.plist.in; do
  backup_name="$(basename "$backup_template" .in)"
  backup_target="$backup_launch_dir/$backup_name"
  backup_label="${backup_name%.plist}"
  sed \
    -e "s|__SCRIPT_ROOT__|$backup_script_dir|g" \
    -e "s|__LOG_ROOT__|$backup_log_root|g" \
    "$backup_template" > "$backup_target"
  plutil -lint "$backup_target" >/dev/null
  launchctl bootout "gui/$backup_account_id/$backup_label" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$backup_account_id" "$backup_target"
  echo "Installed $backup_label"
done
