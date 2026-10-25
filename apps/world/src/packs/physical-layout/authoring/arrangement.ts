import { z } from 'zod'
import { physicalSourceSchema, parameters, type Source } from '../native/campus/source.ts'
import { createPhysicalComposition, type Binding, type CoverageDisposition } from './composition.ts'

const id = z.string().min(1).max(200)
const v3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()])
const dimensions = z.object({ length: z.number().positive(), width: z.number().positive(), height: z.number().positive() }).strict()
const room = z.object({ id, label: z.string().min(1), levelId: id, position: v3, dimensions }).strict()
const partition = z.object({ id, levelId: id, position: v3, length: z.number().positive(), yaw: z.number().finite(), height: z.number().positive(), doorAt: z.number().nonnegative().optional(), doorWidth: z.number().positive().optional() }).strict()
const building = z.object({ id, label: z.string().min(1), levelId: id, position: v3, dimensions, footprint: z.enum(['ellipse', 'rectangle']).optional(), enclosure: z.enum(['continuous', 'authored']).optional(), entranceOffsets: z.object({ south: z.number().nonnegative().optional(), east: z.number().nonnegative().optional(), north: z.number().nonnegative().optional(), west: z.number().nonnegative().optional() }).strict().optional(), floors: z.array(z.object({ levelId: id, elevation: z.number().finite() }).strict()), rooms: z.array(room), partitions: z.array(partition) }).strict()
export const physicalArrangementSchema = z.object({
  id, title: z.string().min(1), origin: v3, levels: physicalSourceSchema.shape.levels,
  retainedGroups: z.array(z.object({ id, label: z.string().min(1), levelId: id, position: v3, dimensions, sourceElementIds: z.array(id) }).strict()),
  buildings: z.array(building),
  equipment: z.array(z.object({ id, label: z.string().min(1), family: physicalSourceSchema.shape.types.element.shape.kind, levelId: id, position: v3, dimensions, buildingId: id.optional(), spaceId: id.optional(), yaw: z.number().finite().optional(), subjects: z.array(z.object({ id, relation: z.enum(['represents', 'partOf', 'houses']) }).strict()), reason: z.string().min(1) }).strict()),
  routes: z.array(z.object({ id, label: z.string().min(1), levelId: id, width: z.number().positive(), path: z.array(v3).min(2), buildingId: id.optional(), subjectId: id.optional(), reason: z.string().min(1) }).strict()),
  bindings: z.array(z.object({ physicalElementId: id, elementId: id, relation: z.enum(['represents', 'partOf', 'houses']), reason: z.string().min(1) }).strict()),
  elements: physicalSourceSchema.shape.elements,
  unplaced: z.array(z.object({ subjectId: id, disposition: z.enum(['internal', 'functional', 'boundary', 'unresolved']), reason: z.string().min(1), physicalElementIds: z.array(id) }).strict()),
  modelRequirement: z.object({ modelRef: id, modelDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  evidence: z.object({ accuracy: z.literal('illustrative'), origin: z.string().min(1).max(1000) }).strict(),
}).strict()

/** Compose one authored arrangement; deliberately does not derive positions from a process graph. */
export const composePhysicalArrangement = (raw: unknown, base: Source, baseBindings: readonly Binding[]) => {
  const arrangement = physicalArrangementSchema.parse(raw)
  const c = createPhysicalComposition({ ...base, id: arrangement.id, title: arrangement.title, origin: arrangement.origin, levels: arrangement.levels, evidence: arrangement.evidence }, baseBindings)
  const assigned = new Set<string>()
  for (const group of arrangement.retainedGroups) {
    c.add(c.element(group.id, group.label, 'building', group.levelId, group.position, group.dimensions, { footprint: 'rectangle' }), 'Retained turbine-island architectural container; its accepted geometry and equipment positions are unchanged.')
    for (const id of group.sourceElementIds) {
      const element = c.source.elements.find(element => element.id === id)
      if (!element || assigned.has(id)) throw new Error(`Invalid retained building membership: ${id}`)
      element.buildingId = group.id; assigned.add(id)
    }
  }
  for (const spec of arrangement.buildings) c.building(spec)
  for (const spec of arrangement.equipment) c.equipment(spec)
  for (const spec of arrangement.routes) c.route(spec)
  for (const element of arrangement.elements) c.add(element, element.kind === 'stair' ? 'Conceptual inter-level access. Dimensions are illustrative and do not qualify evacuation or equipment handling.' : 'Architectural or site context, with no independent operational subject in the current graph.')
  for (const { reason: _reason, ...binding } of arrangement.bindings) c.bindings.push(binding)
  addStairShaftVoids(c.source, new Set(base.elements.map(element => element.id)))
  const source = physicalSourceSchema.parse(c.source)
  const bound = new Set(c.bindings.map(binding => binding.physicalElementId))
  const subjectIds = [...new Set(c.bindings.map(binding => binding.elementId))].sort()
  const dispositions: CoverageDisposition[] = subjectIds.map(subjectId => {
    const relations = c.bindings.filter(binding => binding.elementId === subjectId)
    return { subjectId, disposition: relations.some(relation => relation.relation === 'houses') ? 'housed' : relations.length === 1 && relations[0]!.relation === 'represents' ? 'direct' : 'assembly',
      reason: arrangement.equipment.find(equipment => equipment.subjects.some(subject => subject.id === subjectId))?.reason
        ?? arrangement.routes.find(route => route.subjectId === subjectId)?.reason
        ?? arrangement.bindings.find(binding => binding.elementId === subjectId)?.reason
        ?? 'Accepted turbine-island machinery correspondence, retained without changing the original physical arrangement. Repeated casings share the one aggregate operational state.',
      physicalElementIds: relations.map(binding => binding.physicalElementId).sort(),
    }
  })
  dispositions.push(...arrangement.unplaced)
  dispositions.sort((a, b) => a.subjectId.localeCompare(b.subjectId, 'en'))
  if (new Set(dispositions.map(row => row.subjectId)).size !== dispositions.length) throw new Error('A subject cannot be both physically bound and unplaced')
  for (const disposition of dispositions) for (const id of disposition.physicalElementIds) if (!source.elements.some(element => element.id === id)) throw new Error(`Unknown coverage housing: ${id}`)
  const contextElements = source.elements.filter(element => !bound.has(element.id)).map(element => ({ physicalElementId: element.id,
    reason: c.reasons.get(element.id) ?? (element.id.startsWith('msr-') ? 'Illustrative moisture-separator reheater context retained from the accepted turbine source; the owner graph has no independent MSR subject.' : 'Retained architectural fabric or illustrative utility path; no independent operational identity or live state is invented.'),
  }))
  return { source, bindings: c.bindings, coverage: { scope: 'owner' as const, modelRequirement: arrangement.modelRequirement, dispositions, contextElements, evidence: arrangement.evidence } }
}

/** Keep each new floor's shaft derived from its stair footprint; retained civil source is immutable. */
const addStairShaftVoids = (source: Source, retained: ReadonlySet<string>): void => {
  const stairs = source.elements.filter(element => element.kind === 'stair')
  for (const slab of source.elements.filter(element => element.kind === 'slab' && !retained.has(element.id))) {
    const plate = parameters(source, slab), floor = slab.pose.position[2] + plate.height
    for (const stair of stairs) {
      if (slab.buildingId !== stair.buildingId || slab.buildingId === undefined) continue
      const p = parameters(source, stair)
      if (floor <= stair.pose.position[2] + 0.001 || floor > stair.pose.position[2] + p.height + 0.001) continue
      const c = Math.cos(slab.pose.yaw), s = Math.sin(slab.pose.yaw)
      const sc = Math.cos(stair.pose.yaw), ss = Math.sin(stair.pose.yaw)
      let polygon = [[0, 0], [p.length, 0], [p.length, p.width], [0, p.width]].map(([x, y]) => {
        const dx = stair.pose.position[0] + sc * x! - ss * y! - slab.pose.position[0], dy = stair.pose.position[1] + ss * x! + sc * y! - slab.pose.position[1]
        return [c * dx + s * dy, -s * dx + c * dy] as [number, number]
      })
      for (const [axis, limit, greater] of [[0, 0, true], [0, plate.length, false], [1, 0, true], [1, plate.width, false]] as const) {
        const next: typeof polygon = []
        for (let i = 0; i < polygon.length; i++) {
          const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!, insideA = greater ? a[axis] >= limit : a[axis] <= limit, insideB = greater ? b[axis] >= limit : b[axis] <= limit
          if (insideA) next.push(a)
          if (insideA !== insideB) { const t = (limit - a[axis]) / (b[axis] - a[axis]); next.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]) }
        }
        polygon = next
      }
      if (polygon.length < 3) continue
      const x = Math.max(0, Math.min(...polygon.map(point => point[0]))), y = Math.max(0, Math.min(...polygon.map(point => point[1])))
      const length = Math.min(plate.length, Math.max(...polygon.map(point => point[0]))) - x, width = Math.min(plate.width, Math.max(...polygon.map(point => point[1]))) - y
      if (length < 0.001 || width < 0.001) continue
      slab.holes = [...(slab.holes ?? []), { x, y, length, width }]
      slab.dependsOn = [...new Set([...(slab.dependsOn ?? []), stair.id])]
    }
  }
}
