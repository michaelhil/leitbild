import { z } from 'zod'
import { physicalSceneBoundsSchema } from '../../core/packs/scene.ts'
import { physicalSourceSchema } from './native/source.ts'

export const physicalLayoutPackId = 'physical-layout' as const
const id = z.string().min(1).max(200)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const physicalDesignRefSchema = z.object({ id, revision: id, digest }).strict()
export const physicalCorrespondenceSchema = z.object({ physicalElementId: id, elementId: id, relation: z.enum(['represents', 'partOf']) }).strict()
export const physicalLayoutDataSchema = z.object({
  type: z.literal('physical-layout'),
  design: physicalDesignRefSchema,
  sourceDigest: digest,
  bindingDigest: digest,
  compiler: z.literal('physical-layout-native'),
  source: physicalSourceSchema,
  bindings: z.array(physicalCorrespondenceSchema).max(10_000),
  owner: z.object({ objectId: id, packId: id, modelRef: id, modelDigest: digest }).strict(),
  placement: z.object({ anchor: z.tuple([z.number().finite().min(-180).max(180), z.number().finite().min(-85).max(85)]), bearing: z.number().finite().min(-360).max(360) }).strict(),
  bounds: physicalSceneBoundsSchema,
  coverage: z.object({ representedSubjectIds: z.array(id).max(10_000), unplacedSubjectIds: z.array(id).max(10_000), totalSubjects: z.number().int().nonnegative() }).strict(),
}).strict().superRefine((data, context) => {
  const issue = (message: string): void => context.addIssue({ code: 'custom', message })
  const ids = new Set(data.source.elements.map(element => element.id))
  const bindingKeys = data.bindings.map(binding => `${binding.physicalElementId}/${binding.elementId}`)
  if (new Set(bindingKeys).size !== bindingKeys.length) issue('Duplicate correspondence')
  for (const binding of data.bindings) if (!ids.has(binding.physicalElementId)) issue(`Unknown physical correspondence occurrence: ${binding.physicalElementId}`)
  const subjects = new Set(data.bindings.map(binding => binding.elementId))
  if (data.coverage.representedSubjectIds.some(id => !subjects.has(id)) || subjects.size !== data.coverage.representedSubjectIds.length) issue('Binding and represented coverage differ')
  const coverage = [...data.coverage.representedSubjectIds, ...data.coverage.unplacedSubjectIds]
  if (new Set(coverage).size !== coverage.length || coverage.length !== data.coverage.totalSubjects) issue('Coverage must partition the owner subjects')
})
export type PhysicalLayoutData = z.infer<typeof physicalLayoutDataSchema>

/** Stable JSON equality/hash input; arrays retain their authored order. */
export const canonicalPhysicalJson = (value: unknown): string => JSON.stringify(sort(value))
const sort = (value: unknown): unknown => Array.isArray(value) ? value.map(sort)
  : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, sort(child)]))
  : value
