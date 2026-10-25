import { z } from 'zod'

const id = z.string().min(1).max(200)
export const physicalCoverageEvidenceSchema = z.object({
  modelRequirement: z.object({ modelRef: id, modelDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  /** A site subset does not pretend that the rest of a national network is on this site. */
  scope: z.enum(['owner', 'site-subset']),
  dispositions: z.array(z.object({
    subjectId: id,
    disposition: z.enum(['direct', 'assembly', 'housed', 'internal', 'functional', 'boundary', 'unresolved']),
    reason: z.string().min(1).max(2000), physicalElementIds: z.array(id).max(1000),
  }).strict()).max(10_000),
  contextElements: z.array(z.object({ physicalElementId: id, reason: z.string().min(1).max(2000) }).strict()).max(10_000),
  evidence: z.object({ accuracy: z.literal('illustrative'), origin: z.string().min(1).max(4000) }).strict(),
}).strict().superRefine((value, context) => {
  const fail = (message: string): void => context.addIssue({ code: 'custom', message })
  if (new Set(value.dispositions.map(entry => entry.subjectId)).size !== value.dispositions.length) fail('Coverage has duplicate owner dispositions')
  if (new Set(value.contextElements.map(entry => entry.physicalElementId)).size !== value.contextElements.length) fail('Coverage has duplicate context elements')
  for (const entry of value.dispositions) if (new Set(entry.physicalElementIds).size !== entry.physicalElementIds.length) fail(`Coverage has duplicate physical references: ${entry.subjectId}`)
})
export type PhysicalCoverageEvidence = z.infer<typeof physicalCoverageEvidenceSchema>

/** Validate authored disposition and context against the retained identities, never labels. */
export const physicalCoverageIssues = (input: {
  readonly evidence: PhysicalCoverageEvidence
  readonly physicalIds: ReadonlyArray<string>
  readonly ownerSubjectIds: ReadonlyArray<string>
  readonly bindings: ReadonlyArray<{ readonly physicalElementId: string; readonly elementId: string; readonly relation?: string }>
}): ReadonlyArray<string> => {
  const issues: string[] = []
  const { evidence, bindings } = input
  const physical = new Set(input.physicalIds), owner = new Set(input.ownerSubjectIds)
  const represented = new Set(bindings.map(binding => binding.elementId))
  const boundPhysical = new Set(bindings.map(binding => binding.physicalElementId))
  const dispositions = new Map(evidence.dispositions.map(entry => [entry.subjectId, entry]))
  if (evidence.scope === 'owner' && (owner.size !== dispositions.size || [...owner].some(id => !dispositions.has(id)))) issues.push('Owner coverage must classify every exact model subject')
  for (const entry of evidence.dispositions) {
    if (!owner.has(entry.subjectId)) issues.push(`Coverage names an unknown owner subject: ${entry.subjectId}`)
    if (entry.physicalElementIds.some(id => !physical.has(id))) issues.push(`Coverage names an unknown physical element: ${entry.subjectId}`)
    const spatial = entry.disposition === 'direct' || entry.disposition === 'assembly' || entry.disposition === 'housed'
    if (spatial && (!represented.has(entry.subjectId) || entry.physicalElementIds.length === 0)) issues.push(`A represented disposition needs its occurrence correspondence: ${entry.subjectId}`)
    if (represented.has(entry.subjectId) && !spatial && entry.disposition !== 'boundary') issues.push(`A nonspatial disposition cannot localize live state: ${entry.subjectId}`)
    const ownBindings = bindings.filter(binding => binding.elementId === entry.subjectId)
    if (entry.disposition === 'housed' && !ownBindings.some(binding => binding.relation === 'houses')) issues.push(`A housed disposition needs an explicit houses correspondence: ${entry.subjectId}`)
    for (const binding of ownBindings) {
      if (!entry.physicalElementIds.includes(binding.physicalElementId)) issues.push(`Coverage omits a bound occurrence: ${entry.subjectId}/${binding.physicalElementId}`)
      if (binding.relation === 'houses' && entry.disposition !== 'housed') issues.push(`A housing correspondence needs a housed disposition: ${entry.subjectId}`)
    }
  }
  for (const subject of represented) if (!dispositions.has(subject)) issues.push(`Correspondence has no authored disposition: ${subject}`)
  const contextual = new Set(evidence.contextElements.map(entry => entry.physicalElementId))
  for (const entry of evidence.contextElements) if (!physical.has(entry.physicalElementId) || boundPhysical.has(entry.physicalElementId)) issues.push(`Invalid contextual element: ${entry.physicalElementId}`)
  for (const id of physical) if (!boundPhysical.has(id) && !contextual.has(id)) issues.push(`Unbound physical element needs a context reason: ${id}`)
  return issues
}
