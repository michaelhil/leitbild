import type { PackPhysicalTargetDescription } from '../../core/packs/protocol.ts'

/** A Design declares whether its complete coverage includes graph connections.
 * Older immutable Designs retain their original subject domain. */
export const physicalDesignTargets = (description: PackPhysicalTargetDescription, includeGraphConnections: boolean) => {
  if (includeGraphConnections && description.connections === undefined) throw new Error('Physical Design requires graph connection targets which its owner does not supply')
  const result = includeGraphConnections ? [...description.subjects, ...description.connections!] : description.subjects
  if (new Set(result.map(subject => subject.id)).size !== result.length) throw new Error('Physical owner has ambiguous subject and connection identities')
  return result
}
