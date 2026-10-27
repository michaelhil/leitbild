import { z } from 'zod'
import { objectIdSchema, packIdSchema, type OperationalObject } from '../../core/model/index.ts'
import type { PackScenarioItemSpec, WorldPack } from '../../core/packs/protocol.ts'
import { emptyPackScenarioConfigSchema } from '../../core/packs/protocol.ts'
import { pwrDraftingUnitPhysicalDesignRef, resolvePhysicalDesign } from './design.ts'
import { physicalDesignRefSchema, physicalLayoutDataSchema, physicalLayoutPackId, physicalPlacementGroupSchema } from './model.ts'
import { physicalLayoutPackView } from './ui-pack.ts'
import { physicalCoverageIssues } from './coverage.ts'
import { validatePhysicalConnections } from './connections.ts'
import { physicalLayoutDependencyFailure } from './dependencies.ts'

export const physicalLayoutScenarioItemSchema = z.object({
  pack: z.literal(physicalLayoutPackId), type: z.literal('site-layout'), id: objectIdSchema,
  label: z.string().min(1).max(300), design: physicalDesignRefSchema,
  members: z.record(z.string().min(1).max(200), objectIdSchema).refine(members => Object.keys(members).length <= 65, 'Design member roles must be bounded'),
  bearing: z.number().finite().min(-360).max(360),
  group: physicalPlacementGroupSchema.optional(),
}).strict()

export const physicalLayoutPack: WorldPack = {
  ...physicalLayoutPackView,
  scenarioConfigSchema: emptyPackScenarioConfigSchema,
  knowledge: { wikiRefs: [{ name: 'Physical layouts', url: '/wiki?path=world%2Fphysical-layouts%2Findex.md' }] },
  authoring: { itemTypes: [{
    id: 'site-layout', label: 'Physical site layout',
    description: 'An exact retained physical Design Revision bound to its declared owner and related member roles. Existing Runs keep their admitted revision.',
    idPrefix: 'layout', defaultItem: { design: pwrDraftingUnitPhysicalDesignRef, members: {}, bearing: 0 },
    fields: [{ path: ['members', 'unit'], label: 'Owner unit', description: 'Required by a unit Design. Exact member roles are checked when the Scenario is admitted.', control: { kind: 'reference', itemTypes: ['plant'] } }, { path: ['bearing'], label: 'Local north bearing (degrees)', control: { kind: 'number', min: -360, max: 360 } }],
  }] },
  scenario: {
    validateInitialObjects: (objects, _config, _at, _sides, connections) => {
      const layouts = objects.filter(object => object.packId === physicalLayoutPackId).map(object => ({ object, data: physicalLayoutDataSchema.parse(object.packData) }))
      const groups = new Map<string, string>()
      for (const { data } of layouts) {
        if ('group' in data && data.group !== undefined) {
          const label = groups.get(data.group.id)
          if (label !== undefined && label !== data.group.label) throw new Error('Physical placement group labels must agree')
          groups.set(data.group.id, data.group.label)
        }
        validatePhysicalConnections(data, connections)
        const failure = physicalLayoutDependencyFailure(data, layouts)
        if (failure !== null) throw new Error(failure)
      }
    },
    itemSchemas: { 'site-layout': physicalLayoutScenarioItemSchema },
    referencedObjects: spec => Object.values(physicalLayoutScenarioItemSchema.parse(spec).members),
    expandItem: async (spec: PackScenarioItemSpec, context) => {
      const item = physicalLayoutScenarioItemSchema.parse(spec)
      const retained = await resolvePhysicalDesign(item.design)
      const requirements = retained.profile !== 'turbine-island' ? retained.requirements : { ownerRole: 'unit', ownerPackId: 'process-plant', relatedMembers: [] }
      if (item.group !== undefined && !('physicalApplicability' in retained)) throw new Error('A placement group requires an admitted explorer profile')
      const roles = [requirements.ownerRole, ...requirements.relatedMembers.map(member => member.role)]
      if (Object.keys(item.members).length !== roles.length || roles.some(role => item.members[role] === undefined)) throw new Error('Physical layout members must match the exact Design roles')
      const ownerId = item.members[requirements.ownerRole]!
      const owner = context.objectById(ownerId)
      if (!owner?.spatial?.position) throw new Error(`Physical layout owner has no admitted point: ${ownerId}`)
      if (!context.physicalTargetsFor) throw new Error('Physical-layout admission requires owner target description')
      const targetsFor = context.physicalTargetsFor
      const targets = await targetsFor(ownerId)
      if (owner.packId !== requirements.ownerPackId || targets.objectId !== owner.id || targets.modelRef !== retained.modelRequirement.modelRef || targets.modelDigest !== retained.modelRequirement.modelDigest) throw new Error(`Physical-layout owner model mismatch: ${owner.id}`)
      const point = owner.spatial.position.point.coordinates
      const distance = (a: readonly number[], b: readonly number[]): number => Math.hypot((a[0]! - b[0]!) * Math.cos(b[1]! * Math.PI / 180), a[1]! - b[1]!) * 111_320
      if ('placement' in requirements && requirements.placement) {
        const expected = requirements.placement
        const graphLocation = targets.subjects.find(subject => subject.id === expected.subjectId)?.location
        if (distance(point, expected.anchor) >= 0.5 || item.bearing !== expected.bearing || graphLocation === undefined || distance(graphLocation, expected.anchor) >= 0.5) throw new Error('Physical site geography differs from the owner graph or authored placement')
      }
      const resolvedMembers = await Promise.all(requirements.relatedMembers.map(async requirement => {
        const objectId = item.members[requirement.role]!, object = context.objectById(objectId)
        if (!object?.spatial?.position || object.packId !== requirement.packId || distance(object.spatial.position.point.coordinates, requirement.anchor) >= 0.5) throw new Error(`Physical site member geography mismatch: ${requirement.role}`)
        const description = await targetsFor(objectId)
        if (description.objectId !== objectId || description.modelRef !== requirement.modelRef || description.modelDigest !== requirement.modelDigest) throw new Error(`Physical site member model mismatch: ${requirement.role}`)
        return { ...requirement, objectId }
      }))
      const memberObjects = [owner, ...resolvedMembers.map(member => context.objectById(member.objectId)!)]
      const restricted = memberObjects.flatMap(member => member.audience === undefined || member.audience === 'public' ? [] : [member.audience])
      const audience = restricted.length === 0 ? owner.audience : restricted[0]!.filter(side => restricted.every(sides => sides.includes(side)))
      if (audience?.length === 0) throw new Error('Physical layout members have no shared audience')
      const subjectIds = new Set(targets.subjects.map(subject => subject.id))
      const representedSubjectIds = [...new Set(retained.bindings.map(binding => binding.elementId))].sort()
      for (const id of representedSubjectIds) if (!subjectIds.has(id)) throw new Error(`Physical-layout correspondence names an unknown owner subject: ${id}`)
      if (retained.profile !== 'turbine-island') {
        const issues = physicalCoverageIssues({ evidence: retained.coverageEvidence, physicalIds: retained.source.elements.map(element => element.id), ownerSubjectIds: targets.subjects.map(subject => subject.id), bindings: retained.bindings })
        if (issues.length) throw new Error(`Physical coverage admission failed: ${issues.join('; ')}`)
      }
      const data = physicalLayoutDataSchema.parse({
        type: physicalLayoutPackId, design: retained.design, sourceDigest: retained.sourceDigest, bindingDigest: retained.bindingDigest,
        compiler: retained.compiler, source: retained.source, bindings: retained.bindings,
        owner: { objectId: owner.id, packId: owner.packId, modelRef: targets.modelRef, modelDigest: targets.modelDigest },
        placement: { anchor: [point[0], point[1]], bearing: item.bearing }, bounds: retained.bounds,
        coverage: { representedSubjectIds, unplacedSubjectIds: targets.subjects.filter(subject => !representedSubjectIds.includes(subject.id)).map(subject => subject.id).sort(), totalSubjects: targets.subjects.length },
        ...(retained.profile !== 'turbine-island' ? { coverageDigest: retained.coverageDigest, coverageEvidence: retained.coverageEvidence, requirements: retained.requirements, relatedMembers: resolvedMembers } : {}),
        ...('physicalApplicability' in retained ? { physicalApplicability: retained.physicalApplicability, presentation: retained.presentation, presentationDigest: retained.presentationDigest, ...(item.group === undefined ? {} : { group: item.group }) } : {}),
      })
      const object: OperationalObject = {
        id: item.id, label: item.label, kind: 'facility', packId: packIdSchema.parse(physicalLayoutPackId), lifecycle: 'active', revision: 0,
        spatial: { frame: { kind: 'wgs84' } },
        operational: { status: 'available', priority: 'normal', mode: 'simulated' },
        alerts: [], provenance: { source: 'import', externalId: retained.design.digest },
        ...(audience === undefined ? {} : { audience }),
        timestamps: { createdAt: context.at, updatedAt: context.at }, packData: data,
      }
      return { objects: [object] }
    },
  },
}
