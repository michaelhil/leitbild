// Legacy rsync + map-publication deployment retained temporarily for recovery.
// It is intentionally no longer the package.json default because ordinary
// code changes must not rebuild or promote terrain/scenery artifacts.

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

const terrainBuildId = `terrain-${Date.now()}`
const terrainReleaseDir = `/opt/leitbild/maps/releases/leitbild-osm-norway/${terrainBuildId}`

await ssh('true')
await $`bun install --frozen-lockfile`
await $`bun run check`
await $`bun test`
await $`bun run build:ui`
await ssh('mkdir -p /opt/leitbild/app /opt/leitbild/data /opt/leitbild/osrm-data /opt/leitbild/maps/sources /opt/leitbild/maps/builds /opt/leitbild/maps/releases /opt/leitbild/maps/fonts')
await $`rsync -az --delete --exclude node_modules --exclude .git --exclude data -e "ssh -p ${port}" ./ ${target}:/opt/leitbild/app/`
await ssh('mkdir -p /opt/leitbild/app/data/reference')
await $`rsync -az --delete -e "ssh -p ${port}" ./data/reference/ ${target}:/opt/leitbild/app/data/reference/`
await ssh(`cd /opt/leitbild/app && ${remoteBun} install --frozen-lockfile`)
await ssh(`cd /opt/leitbild/app && ${remoteBun} run build:ui`)
await ssh(`cd /opt/leitbild/app && LEITBILD_MAP_ROOT=/opt/leitbild/maps LEITBILD_MAP_BUILD_ID=${terrainBuildId} ${remoteBun} run maps:terrain:bootstrap`)
await ssh(`cd /opt/leitbild/app && LEITBILD_MAP_ROOT=/opt/leitbild/maps LEITBILD_TERRAIN_PMTILES_PATH=${terrainReleaseDir}/terrain.pmtiles ${remoteBun} run maps:terrain:audit`)
await ssh(`cd /opt/leitbild/app && LEITBILD_MAP_ROOT=/opt/leitbild/maps LEITBILD_SCENERY_SOURCE_PMTILES=${terrainReleaseDir}/norway.pmtiles LEITBILD_SCENERY_OUTPUT_ROOT=${terrainReleaseDir}/scenery LEITBILD_SCENERY_TERRAIN_PMTILES_PATH=${terrainReleaseDir}/terrain.pmtiles LEITBILD_SCENERY_TERRAIN_MODE=required ${remoteBun} run maps:scenery:build`)
await ssh(`cd /opt/leitbild/app && LEITBILD_MAP_ROOT=/opt/leitbild/maps LEITBILD_MAP_RELEASE_DIR=${terrainReleaseDir} ${remoteBun} run maps:promote`)
await ssh('cp /opt/leitbild/app/deploy/leitbild.service /etc/systemd/system/leitbild.service')
await ssh('systemctl daemon-reload && systemctl restart leitbild')
await verifyEndpoint('/health')
await verifyEndpoint('/api/scenarios')
await verifyEndpoint('/map/capabilities.json')
await verifyEndpoint('/map/scenery/current/tileset.json')

console.log('Legacy Leitbild code + map deployment complete')
