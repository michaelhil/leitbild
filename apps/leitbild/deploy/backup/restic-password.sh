#!/usr/bin/env bash
set -euo pipefail

backup_keychain_account="${LEITBILD_BACKUP_KEYCHAIN_ACCOUNT:-$(id -un)}"
exec /usr/bin/security find-generic-password \
  -a "$backup_keychain_account" \
  -s no.openai.leitbild-restic \
  -w
