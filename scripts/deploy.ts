import { $ } from 'bun'

const defaultHetznerHost = '178.104.229.113'
const host = process.env.HETZNER_HOST ?? defaultHetznerHost
const user = process.env.HETZNER_USER ?? 'root'
const port = process.env.HETZNER_PORT ?? '22'
const remoteBun = process.env.HETZNER_BUN ?? '/root/.bun/bin/bun'

const target = `${user}@${host}`
const ssh = async (command: string): Promise<void> => {
  await $`ssh -p ${port} ${target} ${command}`
}

const verifyEndpoint = async (path: string): Promise<void> => {
  let lastError: unknown
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      await ssh(`status="$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:4177${path})" && [ "$status" = "200" ]`)
      return
    } catch (error) {
      lastError = error
      if (attempt < 30) await Bun.sleep(1000)
    }
  }
  throw new Error(`Post-deploy verification failed for ${path}`, { cause: lastError })
}

// Fail fast before spending time on local checks when the execution environment
// cannot open SSH. Codex sandboxed runs need escalation for this command.
await ssh('true')

await $`bun install --frozen-lockfile`
await $`bun run check`
await $`bun test`
await $`bun run build:ui`

await ssh('mkdir -p /opt/leitbild/app /opt/leitbild/data /opt/leitbild/osrm-data /opt/leitbild/maps/sources /opt/leitbild/maps/builds /opt/leitbild/maps/releases /opt/leitbild/maps/fonts')
await $`rsync -az --delete --exclude node_modules --exclude .git --exclude data -e "ssh -p ${port}" ./ ${target}:/opt/leitbild/app/`
// Repo-tracked reference-data overlays (e.g. data/reference/manual/*.geojson)
// must accompany the deploy so reference:rebuild can find them. The broader
// exclude `data` keeps local-only data/sources / data/builds / etc. out.
await ssh('mkdir -p /opt/leitbild/app/data/reference')
await $`rsync -az --delete -e "ssh -p ${port}" ./data/reference/ ${target}:/opt/leitbild/app/data/reference/`

await ssh(`cd /opt/leitbild/app && ${remoteBun} install --frozen-lockfile`)
await ssh(`cd /opt/leitbild/app && ${remoteBun} run build:ui`)
await ssh(`cd /opt/leitbild/app && LEITBILD_MAP_ROOT=/opt/leitbild/maps ${remoteBun} run maps:scenery:build`)
await ssh('cp /opt/leitbild/app/deploy/leitbild.service /etc/systemd/system/leitbild.service')
await ssh('for unit in leitbild-drone-sitl.service leitbild-px4-gazebo.service leitbild-ardupilot-gazebo.service; do if systemctl list-unit-files "$unit" --no-legend | grep -q . || systemctl list-units "$unit" --all --no-legend | grep -q .; then systemctl disable --now "$unit"; fi; done')
await ssh('rm -f /etc/systemd/system/leitbild-drone-sitl.service /etc/systemd/system/leitbild-px4-gazebo.service /etc/systemd/system/leitbild-ardupilot-gazebo.service')
await ssh('systemctl daemon-reload && systemctl enable --now leitbild && systemctl restart leitbild')
await verifyEndpoint('/health')
await verifyEndpoint('/api/scenarios')
await verifyEndpoint('/map/capabilities.json')
await verifyEndpoint('/map/scenery/current/tileset.json')

console.log('Leitbild deploy complete')
