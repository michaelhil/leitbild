import {
  packCapabilityManifestSchema,
  type PackCapabilityDescriptor,
  type PackDescriptor,
} from '@leitbild/contracts'

const capabilityKindFor = (contributionKind: string): PackCapabilityDescriptor['kind'] => {
  switch (contributionKind) {
    case 'tool': return 'tool'
    case 'skill': return 'skill'
    case 'ui-extension': return 'surface'
    case 'script':
    case 'geodata':
    case 'wiki': return 'data'
    default: throw new Error(`Unsupported Agent Pack contribution kind: ${contributionKind}`)
  }
}

export const buildAgentPackCapabilityManifest = (descriptors: ReadonlyArray<PackDescriptor>) =>
  packCapabilityManifestSchema.parse({
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
