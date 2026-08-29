import type { RouteEntry } from './types.ts'
import { json } from './helpers.ts'
import { BUNDLED_PACKS } from '../../packs/bundled.ts'
import { scanPacks } from '../../packs/scanner.ts'
import { buildAgentPackCapabilityManifest } from '../../packs/capabilities.ts'

export const capabilityRoutes: ReadonlyArray<RouteEntry> = [{
  method: 'GET',
  pattern: /^\/capabilities$/,
  handler: async (_request, _match, { system }) => {
    const byId = new Map(BUNDLED_PACKS.map(pack => [pack.descriptor.id, pack.descriptor]))
    for (const pack of await scanPacks(system.packsDir)) byId.set(pack.id, pack.manifest.descriptor)
    return json(buildAgentPackCapabilityManifest([...byId.values()]))
  },
}]
