import type { PackDescriptor } from '@leitbild/contracts'
import { createAgentPackDescriptor } from './manifest.ts'

export interface BundledPack {
  readonly descriptor: PackDescriptor
}

const descriptor = (
  id: string,
  name: string,
  description: string,
  contributionKinds: ReadonlyArray<string>,
): PackDescriptor => createAgentPackDescriptor({
  id,
  version: '1.0.0',
  name,
  description,
  contributions: contributionKinds.map(kind => ({ kind })),
})

export const BUNDLED_PACKS: ReadonlyArray<BundledPack> = [
  {
    descriptor: descriptor('demos', 'Demos', 'Capability showcase tools.', ['tool']),
  },
  {
    descriptor: descriptor(
      'pwr-ops',
      'PWR Operations',
      'Westinghouse PWR Emergency Operating Procedures and wiki-backed tools.',
      ['tool', 'wiki'],
    ),
  },
]

export const getBundledPack = (packId: string): BundledPack | undefined =>
  BUNDLED_PACKS.find(pack => pack.descriptor.id === packId)
