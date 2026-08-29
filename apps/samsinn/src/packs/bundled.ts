import type { PackDescriptor } from '@samsinn-leitbild/platform-contracts'
import { createSamsinnPackDescriptor } from './manifest.ts'

export interface BundledPack {
  readonly descriptor: PackDescriptor
  readonly system: boolean
  readonly defaultActive: boolean
}

const descriptor = (
  id: string,
  name: string,
  description: string,
  contributionKinds: ReadonlyArray<string>,
): PackDescriptor => createSamsinnPackDescriptor({
  id,
  version: '1.0.0',
  name,
  description,
  contributions: contributionKinds.map(kind => ({ kind })),
})

export const BUNDLED_PACKS: ReadonlyArray<BundledPack> = [
  {
    descriptor: descriptor('core', 'Core', 'Built-in tools and skills.', ['tool', 'skill']),
    system: true,
    defaultActive: true,
  },
  {
    descriptor: descriptor(
      'local',
      'Local',
      'Operator-managed tools, skills, scripts, and geodata.',
      ['tool', 'skill', 'script', 'geodata'],
    ),
    system: true,
    defaultActive: true,
  },
  {
    descriptor: descriptor('demos', 'Demos', 'Capability showcase tools.', ['tool']),
    system: false,
    defaultActive: true,
  },
  {
    descriptor: descriptor(
      'pwr-ops',
      'PWR Operations',
      'Westinghouse PWR Emergency Operating Procedures and wiki-backed tools.',
      ['tool', 'wiki'],
    ),
    system: false,
    defaultActive: true,
  },
]

export const getBundledPack = (packId: string): BundledPack | undefined =>
  BUNDLED_PACKS.find(pack => pack.descriptor.id === packId)

export const isSystemPack = (packId: string): boolean =>
  BUNDLED_PACKS.some(pack => pack.descriptor.id === packId && pack.system)

export const defaultActivePackIds = (): ReadonlyArray<string> =>
  BUNDLED_PACKS.filter(pack => pack.defaultActive).map(pack => pack.descriptor.id)
