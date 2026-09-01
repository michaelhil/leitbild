# Production backups

Leitbild backups are pulled from production into the encrypted Restic
repository on the operator Mac. The password is stored in macOS Keychain under
`no.openai.leitbild-restic`.

- `critical` runs daily at 03:15. It briefly stops World, Agents, and Host to
  capture `/var/lib/leitbild`, service definitions, environment files, Caddy,
  and recovery metadata. All three services are restarted and health-checked
  before the archive is sent to Restic.
- `static` runs Sundays at 04:15 without stopping the platform. It captures
  map, reference, and OSRM data.
- `verify` runs monthly and extracts both latest archives into a temporary
  directory to prove that the expected recovery files are present.

Backups and deployments share the same host lock and cannot overlap. Critical
snapshots retain 14 daily, 8 weekly, and 12 monthly copies; static snapshots
retain 8 weekly and 12 monthly copies.

```bash
apps/leitbild/deploy/backup/backup-production.sh critical
apps/leitbild/deploy/backup/backup-production.sh static
apps/leitbild/deploy/backup/verify-restore.sh all
apps/leitbild/deploy/backup/install-launchagents.sh
```
