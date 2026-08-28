#!/usr/bin/env bun
// Legacy GitHub-pull deployment retained temporarily as an emergency fallback.
// New production work should use scripts/deploy.ts, which deploys immutable
// local artifacts without requiring a GitHub push.

import { spawn } from 'bun'

const args = process.argv.slice(2)
const hostIdx = args.indexOf('--host')
const HOST = hostIdx >= 0 ? args[hostIdx + 1]! : '178.104.229.113'
const SKIP_SMOKE = args.includes('--no-smoke')

const run = async (label: string, cmd: string[]): Promise<void> => {
  console.log(`\n→ ${label}`)
  const proc = spawn(cmd, { stdout: 'inherit', stderr: 'inherit' })
  const code = await proc.exited
  if (code !== 0) {
    console.error(`✗ ${label} failed (exit ${code})`)
    process.exit(code)
  }
}

const remote = (script: string): string[] => ['ssh', `root@${HOST}`, script]

await run('Pull + restart on box', remote(`set -e
  cd /opt/samsinn
  sudo -u samsinn git pull --ff-only
  systemctl restart samsinn
  for i in $(seq 1 30); do
    if curl -fsS -o /dev/null http://127.0.0.1:3000/api/system/info; then
      echo "samsinn HTTP up after \${i}s"
      exit 0
    fi
    sleep 1
  done
  echo "samsinn HTTP did not come up within 30s" >&2
  systemctl status samsinn --no-pager
  exit 1
`))

if (!SKIP_SMOKE) {
  await run('Smoke test (broadcast wiring)', remote(`set -a; source /etc/samsinn/env; set +a
    cd /opt/samsinn
    /home/samsinn/.bun/bin/bun run scripts/smoke-streaming.ts
  `))
}

console.log('\n✓ Legacy deploy complete')
