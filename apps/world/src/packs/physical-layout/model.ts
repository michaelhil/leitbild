import { z } from 'zod'
import { physicalSceneBoundsSchema, physicalSceneScopeSchema } from '../../core/packs/scene.ts'
import { physicalSourceSchema } from './native/source.ts'
import { physicalSourceSchema as campusPhysicalSourceSchema } from './native/campus/source.ts'
import { physicalSourceSchema as explorerPhysicalSourceSchema } from './native/explorer/source.ts'
import { campusPhysicalCompilerRef, explorerPhysicalCompilerRef, physicalCompilerRef } from './compiler-identity.ts'
import { physicalCoverageEvidenceSchema, physicalCoverageIssues } from './coverage.ts'
import { physicalDesignRequirementsSchema, physicalResolvedMemberSchema, physicalExplorerRequirementsSchema, physicalExplorerResolvedMemberSchema } from './requirements.ts'

export const physicalLayoutPackId = 'physical-layout' as const
const id = z.string().min(1).max(200)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const physicalDesignRefSchema = z.object({ id, revision: id, digest }).strict()
export const turbineIslandCorrespondenceSchema = z.object({ physicalElementId: id, elementId: id, relation: z.enum(['represents', 'partOf']) }).strict()
export const physicalCorrespondenceSchema = turbineIslandCorrespondenceSchema.extend({ relation: z.enum(['represents', 'partOf', 'houses']) }).strict()
const layoutShape = {
  type: z.literal('physical-layout'),
  design: physicalDesignRefSchema,
  sourceDigest: digest,
  bindingDigest: digest,
  bindings: z.array(physicalCorrespondenceSchema).max(10_000),
  owner: z.object({ objectId: id, packId: id, modelRef: id, modelDigest: digest }).strict(),
  placement: z.object({ anchor: z.tuple([z.number().finite().min(-180).max(180), z.number().finite().min(-85).max(85)]), bearing: z.number().finite().min(-360).max(360) }).strict(),
  bounds: physicalSceneBoundsSchema,
  coverage: z.object({ representedSubjectIds: z.array(id).max(10_000), unplacedSubjectIds: z.array(id).max(10_000), totalSubjects: z.number().int().nonnegative() }).strict(),
}
type CoverageInput = {
  readonly source: { readonly elements: ReadonlyArray<{ readonly id: string }> }
  readonly bindings: ReadonlyArray<z.infer<typeof physicalCorrespondenceSchema>>
  readonly coverage: { readonly representedSubjectIds: ReadonlyArray<string>; readonly unplacedSubjectIds: ReadonlyArray<string>; readonly totalSubjects: number }
}
const validateCoverage = (data: CoverageInput, context: z.core.$RefinementCtx): void => {
  const issue = (message: string): void => context.addIssue({ code: 'custom', message })
  const ids = new Set(data.source.elements.map(element => element.id))
  const bindingKeys = data.bindings.map(binding => `${binding.physicalElementId}/${binding.elementId}`)
  if (new Set(bindingKeys).size !== bindingKeys.length) issue('Duplicate correspondence')
  for (const binding of data.bindings) if (!ids.has(binding.physicalElementId)) issue(`Unknown physical correspondence occurrence: ${binding.physicalElementId}`)
  const subjects = new Set(data.bindings.map(binding => binding.elementId))
  if (data.coverage.representedSubjectIds.some(id => !subjects.has(id)) || subjects.size !== data.coverage.representedSubjectIds.length) issue('Binding and represented coverage differ')
  const coverage = [...data.coverage.representedSubjectIds, ...data.coverage.unplacedSubjectIds]
  if (new Set(coverage).size !== coverage.length || coverage.length !== data.coverage.totalSubjects) issue('Coverage must partition the owner subjects')
}

/** Immutable original artifact profile, also the type imported by its frozen compiler. */
export const turbineIslandLayoutDataSchema = z.object({ ...layoutShape,
  bindings: z.array(turbineIslandCorrespondenceSchema).max(10_000),
  compiler: z.object({ id: z.literal(physicalCompilerRef.id), digest: z.literal(physicalCompilerRef.digest) }).strict(),
  source: physicalSourceSchema,
}).strict().superRefine(validateCoverage)
export type PhysicalLayoutData = z.infer<typeof turbineIslandLayoutDataSchema>

export const campusLayoutDataSchema = z.object({ ...layoutShape,
  compiler: z.object({ id: z.literal(campusPhysicalCompilerRef.id), digest: z.literal(campusPhysicalCompilerRef.digest) }).strict(),
  source: campusPhysicalSourceSchema,
  coverageDigest: digest,
  coverageEvidence: physicalCoverageEvidenceSchema,
  requirements: physicalDesignRequirementsSchema,
  relatedMembers: z.array(physicalResolvedMemberSchema).max(64),
}).strict().superRefine((data, context) => {
  validateCoverage(data, context)
  const issue = (message: string): void => context.addIssue({ code: 'custom', message })
  if (data.owner.packId !== data.requirements.ownerPackId) issue('The retained owner Pack differs from the Design requirement')
  if (data.coverageEvidence.modelRequirement.modelRef !== data.owner.modelRef || data.coverageEvidence.modelRequirement.modelDigest !== data.owner.modelDigest) issue('Coverage evidence names a different owner model')
  for (const message of physicalCoverageIssues({ evidence: data.coverageEvidence, physicalIds: data.source.elements.map(element => element.id), ownerSubjectIds: [...data.coverage.representedSubjectIds, ...data.coverage.unplacedSubjectIds], bindings: data.bindings })) issue(message)
  const required = data.requirements.relatedMembers
  if (data.relatedMembers.length !== required.length || new Set(data.relatedMembers.map(member => member.role)).size !== required.length) issue('Related member resolution must match every Design role')
  for (const requirement of required) {
    const member = data.relatedMembers.find(member => member.role === requirement.role)
    if (!member) { issue(`Related member does not satisfy its Design requirement: ${requirement.role}`); continue }
    const { objectId: _objectId, ...resolution } = member
    if (canonicalPhysicalJson(resolution) !== canonicalPhysicalJson(requirement)) issue(`Related member does not satisfy its Design requirement: ${requirement.role}`)
  }
  if (new Set([data.owner.objectId, ...data.relatedMembers.map(member => member.objectId)]).size !== data.relatedMembers.length + 1) issue('Design member roles must resolve to distinct owner objects')
  const placement = data.requirements.placement
  if (placement && (canonicalPhysicalJson(data.placement.anchor) !== canonicalPhysicalJson(placement.anchor) || data.placement.bearing !== placement.bearing || canonicalPhysicalJson(data.source.siteAnchor) !== canonicalPhysicalJson(placement.anchor))) issue('The fixed site source and admitted placement differ')
  if (data.source.siteAnchor && !placement) issue('A georeferenced site requires an explicit placement requirement')
})

export type CampusPhysicalLayoutData = z.infer<typeof campusLayoutDataSchema>
export const physicalApplicabilitySchema = z.object({ sourceDigest: digest, geometryDigest: digest, digest }).strict()
export const physicalPresentationSchema = z.object({ scopes: z.array(physicalSceneScopeSchema), layers: z.array(z.object({ id, label: z.string().min(1).max(300), defaultVisible: z.boolean() }).strict()) }).strict()
export const physicalPlacementGroupSchema = z.object({ id, label: z.string().min(1).max(300) }).strict()
export const explorerLayoutDataSchema = z.object({ ...layoutShape,
  compiler: z.object({ id: z.literal(explorerPhysicalCompilerRef.id), digest: z.literal(explorerPhysicalCompilerRef.digest) }).strict(),
  source: explorerPhysicalSourceSchema,
  coverageDigest: digest, coverageEvidence: physicalCoverageEvidenceSchema,
  requirements: physicalExplorerRequirementsSchema, relatedMembers: z.array(physicalExplorerResolvedMemberSchema).max(64),
  physicalApplicability: physicalApplicabilitySchema,
  presentation: physicalPresentationSchema, presentationDigest: digest,
  group: physicalPlacementGroupSchema.optional(),
}).strict().superRefine((data, context) => {
  validateCoverage(data, context)
  const issue = (message: string): void => context.addIssue({ code: 'custom', message })
  if (data.owner.packId !== data.requirements.ownerPackId) issue('The retained owner Pack differs from the Design requirement')
  if (data.coverageEvidence.modelRequirement.modelRef !== data.owner.modelRef || data.coverageEvidence.modelRequirement.modelDigest !== data.owner.modelDigest) issue('Coverage evidence names a different owner model')
  for (const message of physicalCoverageIssues({ evidence: data.coverageEvidence, physicalIds: data.source.elements.map(element => element.id), ownerSubjectIds: [...data.coverage.representedSubjectIds, ...data.coverage.unplacedSubjectIds], bindings: data.bindings })) issue(message)
  const required = data.requirements.relatedMembers
  if (data.relatedMembers.length !== required.length || new Set(data.relatedMembers.map(member => member.role)).size !== required.length) issue('Related member resolution must match every Design role')
  for (const requirement of required) {
    const member = data.relatedMembers.find(member => member.role === requirement.role)
    if (!member) { issue(`Related member does not satisfy its Design requirement: ${requirement.role}`); continue }
    const { objectId: _objectId, ...resolution } = member
    if (canonicalPhysicalJson(resolution) !== canonicalPhysicalJson(requirement)) issue(`Related member does not satisfy its Design requirement: ${requirement.role}`)
  }
  if (new Set([data.owner.objectId, ...data.relatedMembers.map(member => member.objectId)]).size !== data.relatedMembers.length + 1) issue('Design member roles must resolve to distinct owner objects')
  const placement = data.requirements.placement
  if (placement && (canonicalPhysicalJson(data.placement.anchor) !== canonicalPhysicalJson(placement.anchor) || data.placement.bearing !== placement.bearing || canonicalPhysicalJson(data.source.siteAnchor) !== canonicalPhysicalJson(placement.anchor))) issue('The fixed site source and admitted placement differ')
  if (data.source.siteAnchor && !placement) issue('A georeferenced site requires an explicit placement requirement')
  const scopeIds = new Set(data.presentation.scopes.map(scope => scope.id))
  if (scopeIds.size !== data.presentation.scopes.length || !scopeIds.has(data.source.rootScope.id)) issue('Presentation scope manifest must contain the unique source root')
  const levels = new Set(data.source.levels.map(level => level.id)), scopes = new Map(data.presentation.scopes.map(scope => [scope.id, scope]))
  for (const scope of data.presentation.scopes) {
    if (scope.parentId !== undefined && !scopeIds.has(scope.parentId)) issue('Unknown presentation scope parent')
    if (scope.levelIds.some(level => !levels.has(level))) issue('Unknown presentation scope level')
    const ancestors = new Set([scope.id])
    let parent = scope.parentId
    while (parent !== undefined) {
      if (ancestors.has(parent)) { issue('Presentation scope membership must be acyclic'); break }
      ancestors.add(parent); parent = scopes.get(parent)?.parentId
    }
  }
})
export type ExplorerPhysicalLayoutData = z.infer<typeof explorerLayoutDataSchema>
export type RetainedPhysicalLayoutData = PhysicalLayoutData | CampusPhysicalLayoutData | ExplorerPhysicalLayoutData
const compilerMarkerSchema = z.object({ compiler: z.object({ id: z.enum([physicalCompilerRef.id, campusPhysicalCompilerRef.id, explorerPhysicalCompilerRef.id]) }).passthrough() }).passthrough()
/** Select a known artifact before walking a large source; an unknown compiler never falls through. */
export const physicalLayoutDataSchema = z.unknown().transform((input, context): RetainedPhysicalLayoutData => {
  const marker = compilerMarkerSchema.safeParse(input)
  if (!marker.success) { for (const issue of marker.error.issues) context.addIssue({ code: 'custom', path: issue.path, message: issue.message }); return z.NEVER }
  const result = marker.data.compiler.id === physicalCompilerRef.id ? turbineIslandLayoutDataSchema.safeParse(input)
    : marker.data.compiler.id === campusPhysicalCompilerRef.id ? campusLayoutDataSchema.safeParse(input) : explorerLayoutDataSchema.safeParse(input)
  if (!result.success) { for (const issue of result.error.issues) context.addIssue({ code: 'custom', path: issue.path, message: issue.message }); return z.NEVER }
  return result.data
})

/** Exact source authority; resolved Run member IDs are separate from reusable Design identity. */
export const physicalDesignManifest = (data: RetainedPhysicalLayoutData) => ({
  sourceDigest: data.sourceDigest, bindingDigest: data.bindingDigest,
  modelRequirement: { modelRef: data.owner.modelRef, modelDigest: data.owner.modelDigest }, compiler: data.compiler,
  ...('coverageDigest' in data ? { coverageDigest: data.coverageDigest, requirements: data.requirements } : {}),
  ...('physicalApplicability' in data ? { physicalApplicability: data.physicalApplicability, presentationDigest: data.presentationDigest } : {}),
})

/** Stable JSON equality/hash input; arrays retain their authored order. */
export const canonicalPhysicalJson = (value: unknown): string => JSON.stringify(sort(value))
const sort = (value: unknown): unknown => Array.isArray(value) ? value.map(sort)
  : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, sort(child)]))
  : value
