# Encrypted production backups

Backups are pulled from production into an encrypted Restic repository on the
operator Mac. The Restic password lives in macOS Keychain under
`no.openai.samsinn-restic`; it is not stored beside the repository.

- `critical` runs daily at 03:15. It briefly stops Samsinn and Leitbild while
  creating a server-local snapshot of their mutable state, secrets, host
  configuration, unit files, and recovery metadata. It restarts and
  health-checks both services before streaming that snapshot off-host. An exit
  trap also recovers the services if snapshot creation fails.
- `static` runs Sundays at 04:15 without stopping the apps. It captures the
  map, reference-data, and OSRM roots.
- A restore drill runs on the first of each month. It checks the Restic
  repository, extracts both latest archives into a temporary directory, and
  verifies the expected recovery paths and representative files.

Both backup modes share the deployment lock, so they cannot overlap an app
activation. Restic retains 14 daily, 8 weekly, and 12 monthly critical
snapshots; static snapshots retain 8 weekly and 12 monthly copies.

Manual operations:

```bash
deploy/backup/backup-production.sh critical
deploy/backup/backup-production.sh static
deploy/backup/verify-restore.sh all
```

Initialize the Restic repository and Keychain item once, then load the schedules
with `deploy/backup/install-launchagents.sh`. Loading the schedules authorizes
the documented brief production pause during each critical backup.
