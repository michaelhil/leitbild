#!/usr/bin/env bash
set -euo pipefail

backup_keychain_account="${LEITBILD_BACKUP_KEYCHAIN_ACCOUNT:-$(id -un)}"
backup_keychain_service="${LEITBILD_BACKUP_KEYCHAIN_SERVICE:-no.openai.leitbild-restic}"
exec /usr/bin/security find-generic-password \
  -a "$backup_keychain_account" \
  -s "$backup_keychain_service" \
  -w
