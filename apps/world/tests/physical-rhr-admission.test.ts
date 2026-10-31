import { expect, test } from 'bun:test'
import retainedRhrTargets from './fixtures/physical-layout/rhr-targets-20261030.json'
import { resolvePhysicalDesign, pwrOperatorUnitPhysicalDesignRef, pwrOperatorCampusPhysicalDesignRef, pwrRhrUnitPhysicalDesignRef, pwrRhrCampusPhysicalDesignRef } from '../src/packs/physical-layout/design.ts'
import { compilePhysicalScene } from '../src/packs/physical-layout/native/drafting/compile-scene.ts'
import { physicalCoverageIssues } from '../src/packs/physical-layout/coverage.ts'
import { parameters } from '../src/packs/physical-layout/native/drafting/source.ts'

const drafting = async (reference: unknown) => { const value = await resolvePhysicalDesign(reference); if (value.profile !== 'drafting') throw Error('Expected exact drafting admission'); return value }
const equipment = ['A', 'B'].flatMap(train => ['rhrHeatExchanger', 'componentCoolingHeatExchanger', 'componentCoolingTank', 'componentCoolingWaterPumpBreaker', 'serviceWaterPumpBreaker'].map(prefix => `${prefix}${train}`))

test('retained RHR admission covers its exact captured graph with original terminals, room placement and architecture', async () => {
  const [before, after, oldCampus, campus] = await Promise.all([drafting(pwrOperatorUnitPhysicalDesignRef), drafting(pwrRhrUnitPhysicalDesignRef), drafting(pwrOperatorCampusPhysicalDesignRef), drafting(pwrRhrCampusPhysicalDesignRef)])
  expect(retainedRhrTargets.sourceCommit).toBe('81e0233fff15a4723073f8d6cdb7d4ff375a893c')
  const model = retainedRhrTargets.description
  expect(after.modelRequirement).toEqual({ modelRef: model.modelRef, modelDigest: model.modelDigest })
  expect(after.modelRequirement).not.toEqual(before.modelRequirement)
  expect(after.compiler).toEqual(before.compiler)
  const subjects = [...model.subjects.map(component => component.id), ...model.connections.map(link => link.id)]
  expect(physicalCoverageIssues({ evidence: after.coverageEvidence, physicalIds: [...after.source.elements.map(element => element.id), ...after.source.routing!.connections.map(route => route.id)], ownerSubjectIds: subjects, bindings: after.bindings })).toEqual([])
  expect(after.coverageEvidence.dispositions.map(row => row.subjectId).sort()).toEqual(subjects.sort())
  expect(after.coverageEvidence.dispositions.some(row => row.disposition === 'unresolved')).toBe(false)
  for (const original of before.source.elements) expect(after.source.elements.find(element => element.id === original.id)).toEqual(original)
  for (const original of before.source.planAnnotations!) expect(after.source.planAnnotations!.find(annotation => annotation.id === original.id)).toEqual(original)
  expect(after.source.planIntent).toEqual({ ...before.source.planIntent!, strokes: [...before.source.planIntent!.strokes, ...after.source.planIntent!.strokes.slice(before.source.planIntent!.strokes.length)] })
  const dimensions = (element: typeof after.source.elements[number]) => { const d = parameters(after.source, element); return { min: element.pose.position, max: [element.pose.position[0] + d.length, element.pose.position[1] + d.width, element.pose.position[2] + d.height] } }
  for (const subject of equipment) {
    const row = after.coverageEvidence.dispositions.find(row => row.subjectId === subject)!
    expect(row.disposition).toBe('direct')
    expect(after.bindings).toContainEqual({ physicalElementId: `equipment/${subject}`, elementId: subject, relation: 'represents' })
    const element = after.source.elements.find(element => element.id === `equipment/${subject}`)!, box = dimensions(element)
    for (const id of element.spaceIds!) {
      const room = dimensions(after.source.elements.find(element => element.id === id)!)
      for (const axis of [0, 1, 2]) {
        expect(box.min[axis]! >= room.min[axis]!).toBe(true)
        expect(box.max[axis]! <= room.max[axis]!).toBe(true)
      }
      const f = element.foundation!
      for (const axis of [0, 1]) {
        const low = element.pose.position[axis]! + f.offset[axis]!, high = low + (axis === 0 ? f.length : f.width)
        expect(low >= room.min[axis]! - 1e-10).toBe(true)
        expect(high <= room.max[axis]! + 1e-10).toBe(true)
      }
    }
  }
  const terminals = new Map(after.source.routing!.terminals.map(terminal => [terminal.id, terminal]))
  for (const route of after.source.routing!.connections) {
    const edge = model.connections.find(edge => edge.id === route.graphConnectionId)!, from = terminals.get(route.from)!, to = terminals.get(route.to)!
    expect(edge).toBeDefined()
    expect({ subjectId: from.subjectId, port: from.port }).toEqual(edge.from)
    expect({ subjectId: to.subjectId, port: to.port }).toEqual(edge.to)
    expect(route.solution!.length).toBeGreaterThanOrEqual(2)
  }
  for (const train of ['A', 'B']) for (const prefix of ['rhrHeatExchanger', 'componentCoolingHeatExchanger']) {
    const ports = after.source.routing!.terminals.filter(terminal => terminal.subjectId === `${prefix}${train}`)
    expect(ports.map(port => port.port).sort()).toEqual(['coldIn', 'coldOut', 'hotIn', 'hotOut'])
    expect(new Set(ports.map(port => JSON.stringify(port.local))).size).toBe(4)
  }
  const oldRoutes = new Map(before.source.routing!.connections.map(route => [route.graphConnectionId, route]))
  const changed = new Set(['rhr-pump-a-to-header', 'rhr-pump-b-to-header', 'safety-bus-a-to-ccw-pump-a', 'safety-bus-b-to-ccw-pump-b', 'safety-bus-a-to-sw-pump-a', 'safety-bus-b-to-sw-pump-b'])
  for (const [id, route] of oldRoutes) if (!changed.has(id)) expect(after.source.routing!.connections.find(next => next.graphConnectionId === id)).toEqual(route)
  const compile = (data: typeof after) => compilePhysicalScene('preservation', { ...data, owner: { objectId: 'plant:same' }, placement: { anchor: [0, 0], bearing: 0 } })
  const oldScene = compile(before), scene = compile(after), objects = new Map(scene.objects.map(object => [object.id, object]))
  for (const object of oldScene.objects) if (!changed.has(object.id.replace(/^connection\//, ''))) expect(objects.get(object.id)).toEqual(object)
  expect(scene.objects.length).toBeGreaterThan(oldScene.objects.length)
  expect(campus.source.elements).toEqual(oldCampus.source.elements)
  expect(campus.bindings).toEqual(oldCampus.bindings)
  expect(campus.compiler).toEqual(oldCampus.compiler)
  for (const member of campus.requirements.relatedMembers) {
    expect(member.modelDigest).toBe(model.modelDigest)
    expect(member.physicalLayout?.physical).toEqual({ id: after.design.id, digest: after.physicalApplicability.digest })
  }
  for (const dependency of campus.source.sourceDependencies!) {
    expect(dependency.physicalSourceDigest).toBe(after.physicalApplicability.sourceDigest)
    expect(dependency.physicalShapeDigest).toBe(after.physicalApplicability.geometryDigest)
  }
}, 30_000)
