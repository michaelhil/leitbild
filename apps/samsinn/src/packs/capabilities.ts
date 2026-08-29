import {
  capabilityManifestSchema,
  type CapabilityDescriptor,
  type PackDescriptor,
} from '@samsinn-leitbild/platform-contracts'

const capabilityKindFor = (contributionKind: string): CapabilityDescriptor['kind'] => {
  switch (contributionKind) {
    case 'tool': return 'tool'
    case 'skill': return 'skill'
    case 'ui-extension': return 'surface'
    case 'script':
    case 'geodata':
    case 'wiki': return 'data'
    default: throw new Error(`Unsupported Samsinn Pack contribution kind: ${contributionKind}`)
  }
}

export const buildSamsinnCapabilityManifest = (descriptors: ReadonlyArray<PackDescriptor>) =>
  capabilityManifestSchema.parse({
    generatedAt: new Date().toISOString(),
    capabilities: descriptors
      .flatMap(descriptor => descriptor.contributions.map(contribution => ({
        id: contribution.id ?? `${descriptor.id}.${contribution.kind}`,
        kind: capabilityKindFor(contribution.kind),
        packId: descriptor.id,
        version: descriptor.version,
        ...(descriptor.description === undefined ? {} : { description: descriptor.description }),
      })))
      .sort((left, right) => left.id.localeCompare(right.id)),
  })
