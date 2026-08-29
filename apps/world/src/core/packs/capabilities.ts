import {
  packCapabilityManifestSchema,
  type PackCapabilityDescriptor,
} from '@leitbild/contracts'
import type { WorldPack } from './protocol.ts'

const capabilityKindFor = (contributionKind: string): PackCapabilityDescriptor['kind'] => {
  switch (contributionKind) {
    case 'runtime': return 'stream'
    case 'presentation': return 'surface'
    case 'commands':
    case 'interactions': return 'command'
    case 'queries': return 'query'
    case 'knowledge':
    case 'reference-data':
    case 'scenario': return 'data'
    default: throw new Error(`Unsupported Leitbild Pack contribution kind: ${contributionKind}`)
  }
}

export const buildWorldPackCapabilityManifest = (packs: ReadonlyArray<WorldPack>) =>
  packCapabilityManifestSchema.parse({
    generatedAt: new Date().toISOString(),
    capabilities: packs
      .flatMap(pack => pack.descriptor.contributions.map(contribution => ({
        id: contribution.id ?? `${pack.descriptor.id}.${contribution.kind}`,
        kind: capabilityKindFor(contribution.kind),
        packId: pack.descriptor.id,
        version: pack.descriptor.version,
        ...(pack.descriptor.description === undefined ? {} : { description: pack.descriptor.description }),
      })))
      .sort((left, right) => left.id.localeCompare(right.id)),
  })
