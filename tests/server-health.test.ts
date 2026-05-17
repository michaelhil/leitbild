import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ControlInstanceId } from '../src/core/model/index.ts'
import { createHealthDetails } from '../src/core/api/server.ts'
import { createControlInstanceRegistry } from '../src/core/control-instances/registry.ts'
import { createLocalAmbulanceSimulationAdapter } from '../src/domains/ambulance/sim/adapter.ts'
import { createLocalTrafficSimulationAdapter } from '../src/domains/traffic/sim/adapter.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'

describe('server health', () => {
  test('reports process, storage, control instance, and realtime details', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-health-test-'))
    const mapRoot = await mkdtemp(join(tmpdir(), 'leitbild-map-health-test-'))
    const releaseDir = join(mapRoot, 'releases', 'leitbild-osm-norway', 'health-build')
    const glyphDir = join(mapRoot, 'fonts', 'Noto Sans Regular')
    await mkdir(releaseDir, { recursive: true })
    await mkdir(glyphDir, { recursive: true })
    await Bun.write(join(releaseDir, 'norway.pmtiles'), 'pmtiles')
    await Bun.write(join(glyphDir, '0-255.pbf'), 'glyphs')
    await symlink(releaseDir, join(mapRoot, 'current'))
    const registry = createControlInstanceRegistry({
      dataDir,
      simulationAdapters: [
        createLocalAmbulanceSimulationAdapter({ routing: createDirectRoutingAdapter() }),
        createLocalTrafficSimulationAdapter(),
      ],
    })
    const runtime = await registry.ensure('sandbox' as ControlInstanceId)
    try {
      const details = await createHealthDetails({ registry, mapArtifacts: { rootDir: mapRoot } })

      expect(details.ok).toBe(true)
      expect(details.process.memory.rssBytes).toBeGreaterThan(0)
      expect(details.registry.dataDir).toBe(dataDir)
      expect(details.registry.storage.totalBytes).toBeGreaterThan(0)
      expect(details.registry.controlInstances).toContainEqual({
        id: runtime.id,
        loaded: true,
        objectCount: 3,
        snapshotSeq: 0,
      })
      expect(details.realtime.websocketClientCount).toBe(0)
      expect(details.realtime.subscribedControlInstanceCount).toBe(0)
      expect(details.mapArtifacts.status).toBe('ready')
      expect(details.mapArtifacts.activeBuildId).toBe('health-build')
      expect(details.mapArtifacts.currentPmtiles.sizeBytes).toBeGreaterThan(0)
      expect(details.mapArtifacts.glyphProbe.available).toBe(true)
    } finally {
      await registry.close(runtime.id)
    }
  })
})
