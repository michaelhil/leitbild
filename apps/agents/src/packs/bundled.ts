import type { Tool } from '../core/types/tool.ts'
import { createAgentPackDescriptor } from './manifest.ts'
import { PWR_OPS_MANIFEST } from './pwr-ops/manifest.ts'
import type { PackManifest } from './types.ts'

export interface BundledPack {
  readonly manifest: PackManifest
  readonly loadTools: () => Promise<ReadonlyArray<Tool>>
}

const descriptor = (
  id: string,
  name: string,
  description: string,
  contributionKinds: ReadonlyArray<string>,
): PackManifest['descriptor'] => createAgentPackDescriptor({
  id,
  version: '1.0.0',
  name,
  description,
  contributions: contributionKinds.map(kind => ({ kind })),
})

export const BUNDLED_PACKS: ReadonlyArray<BundledPack> = [
  {
    manifest: {
      descriptor: descriptor('demos', 'Demos', 'Capability showcase tools.', ['tool']),
      wikis: [],
      uiExtensions: [],
    },
    loadTools: async () => (await import('./synthetic-demos/tools/index.ts')).BUNDLED_DEMO_TOOLS,
  },
  {
    manifest: PWR_OPS_MANIFEST,
    loadTools: async () => (await import('./pwr-ops/index.ts')).PWR_OPS_TOOLS,
  },
]

export const getBundledPack = (packId: string): BundledPack | undefined =>
  BUNDLED_PACKS.find(pack => pack.manifest.descriptor.id === packId)
