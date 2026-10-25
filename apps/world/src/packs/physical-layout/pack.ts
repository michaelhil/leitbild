import { z } from 'zod'
import { objectIdSchema, packIdSchema, type OperationalObject } from '../../core/model/index.ts'
import type { PackScenarioItemSpec, WorldPack } from '../../core/packs/protocol.ts'
import { emptyPackScenarioConfigSchema } from '../../core/packs/protocol.ts'
import { currentPwrPhysicalDesignRef, resolvePhysicalDesign } from './design.ts'
import { physicalDesignRefSchema, physicalLayoutDataSchema, physicalLayoutPackId } from './model.ts'
import { physicalLayoutPackView } from './ui-pack.ts'

export const physicalLayoutScenarioItemSchema = z.object({
  pack: z.literal(physicalLayoutPackId), type: z.literal('site-layout'), id: objectIdSchema,
  label: z.string().min(1).max(300), design: physicalDesignRefSchema,
  members: z.object({ unit: objectIdSchema }).strict(),
  bearing: z.number().finite().min(-360).max(360),
}).strict()

export const physicalLayoutPack: WorldPack = {
  ...physicalLayoutPackView,
  scenarioConfigSchema: emptyPackScenarioConfigSchema,
  knowledge: { wikiRefs: [{ name: 'Physical layouts', url: '/wiki?path=world%2Fphysical-layouts%2Findex.md' }] },
  authoring: { itemTypes: [{
    id: 'site-layout', label: 'Physical site layout',
    description: 'An exact retained physical Design Revision bound to one compatible unit. Existing Runs keep their admitted revision.',
    idPrefix: 'layout', defaultItem: { design: currentPwrPhysicalDesignRef, bearing: 0 },
    fields: [{ path: ['members', 'unit'], label: 'Owner unit', control: { kind: 'reference', itemTypes: ['plant'] } }, { path: ['bearing'], label: 'Local north bearing (degrees)', control: { kind: 'number', min: -360, max: 360 } }],
  }] },
  scenario: {
    itemSchemas: { 'site-layout': physicalLayoutScenarioItemSchema },
    referencedObjects: spec => [physicalLayoutScenarioItemSchema.parse(spec).members.unit],
    expandItem: (spec: PackScenarioItemSpec, context) => {
      const item = physicalLayoutScenarioItemSchema.parse(spec)
      const owner = context.objectById(item.members.unit)
      if (!owner?.spatial?.position) throw new Error(`Physical layout owner has no admitted point: ${item.members.unit}`)
      if (!context.physicalTargetsFor) throw new Error('Physical-layout admission requires owner target description')
      const targets = context.physicalTargetsFor(item.members.unit)
      const retained = resolvePhysicalDesign(item.design)
      if (targets.objectId !== owner.id || targets.modelRef !== retained.modelRequirement.modelRef || targets.modelDigest !== retained.modelRequirement.modelDigest) throw new Error(`Physical-layout owner model mismatch: ${owner.id}`)
      const subjectIds = new Set(targets.subjects.map(subject => subject.id))
      const representedSubjectIds = [...new Set(retained.bindings.map(binding => binding.elementId))].sort()
      for (const id of representedSubjectIds) if (!subjectIds.has(id)) throw new Error(`Physical-layout correspondence names an unknown owner subject: ${id}`)
      const point = owner.spatial.position.point.coordinates
      const data = physicalLayoutDataSchema.parse({
        type: physicalLayoutPackId, design: retained.design, sourceDigest: retained.sourceDigest, bindingDigest: retained.bindingDigest,
        compiler: 'physical-layout-native', source: retained.source, bindings: retained.bindings,
        owner: { objectId: owner.id, packId: owner.packId, modelRef: targets.modelRef, modelDigest: targets.modelDigest },
        placement: { anchor: [point[0], point[1]], bearing: item.bearing }, bounds: retained.bounds,
        coverage: { representedSubjectIds, unplacedSubjectIds: targets.subjects.filter(subject => !representedSubjectIds.includes(subject.id)).map(subject => subject.id).sort(), totalSubjects: targets.subjects.length },
      })
      const object: OperationalObject = {
        id: item.id, label: item.label, kind: 'facility', packId: packIdSchema.parse(physicalLayoutPackId), lifecycle: 'active', revision: 0,
        spatial: { frame: { kind: 'wgs84' } },
        operational: { status: 'available', priority: 'normal', mode: 'simulated' },
        alerts: [], provenance: { source: 'import', externalId: retained.design.digest },
        timestamps: { createdAt: context.at, updatedAt: context.at }, packData: data,
      }
      return { objects: [object] }
    },
  },
}
