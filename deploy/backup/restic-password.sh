#!/usr/bin/env bash
set -euo pipefail

backup_keychain_account="${SAMSINN_BACKUP_KEYCHAIN_ACCOUNT:-$(id -un)}"
backup_keychain_service="${SAMSINN_BACKUP_KEYCHAIN_SERVICE:-no.openai.samsinn-restic}"
exec /usr/bin/security find-generic-password \
  -a "$backup_keychain_account" \
  -s "$backup_keychain_service" \
  -w
