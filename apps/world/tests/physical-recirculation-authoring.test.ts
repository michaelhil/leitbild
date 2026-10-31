import { expect, test } from 'bun:test'
import retained from './fixtures/physical-layout/recirculation-targets-20261030.json'
import beforeSourceData from '../src/packs/physical-layout/pwr-full-unit-rhr.source.json'
import beforeBindingsData from '../src/packs/physical-layout/pwr-full-unit-rhr.bindings.json'
import beforeCampusSourceData from '../src/packs/physical-layout/pwr-campus-rhr.source.json'
import beforeCampusBindingsData from '../src/packs/physical-layout/pwr-campus-rhr.bindings.json'
import { pwrRecirculationUnitPhysicalDesignRef, pwrRecirculationCampusPhysicalDesignRef, resolvePhysicalDesign } from '../src/packs/physical-layout/design.ts'
import { physicalCoverageIssues } from '../src/packs/physical-layout/coverage.ts'
import { physicalSourceSchema } from '../src/packs/physical-layout/native/drafting/source.ts'
import { physicalCorrespondenceSchema } from '../src/packs/physical-layout/model.ts'
import { compilePhysicalObjects, compilePhysicalScene, physicalObjectsBounds } from '../src/packs/physical-layout/native/drafting/compile-scene.ts'
import { compilePhysicalRoutes } from '../src/packs/physical-layout/native/routing/compile.ts'
import { physicalDraftingAuthoringBounds } from '../src/packs/physical-layout/native/drafting/frame.ts'

const beforeSource = physicalSourceSchema.parse(beforeSourceData), beforeCampusSource = physicalSourceSchema.parse(beforeCampusSourceData)
const beforeBindings = physicalCorrespondenceSchema.array().parse(beforeBindingsData), beforeCampusBindings = physicalCorrespondenceSchema.array().parse(beforeCampusBindingsData)

test('retained recirculation installation preserves architecture, exact captured graph ports and accepted routes under its immutable admission', async () => {
  // Historical installation is admitted against its actual captured graph;
  // regenerating R9 with today's hardware would silently change its meaning.
  // Current R10 authoring/reproducibility is exercised in its own admission test.
  const [unitDesign, campus] = await Promise.all([resolvePhysicalDesign(pwrRecirculationUnitPhysicalDesignRef), resolvePhysicalDesign(pwrRecirculationCampusPhysicalDesignRef)])
  if (unitDesign.profile !== 'drafting' || campus.profile !== 'drafting') throw Error('Expected exact retained native drafting admissions')
  const unit = { ...unitDesign, coverage: unitDesign.coverageEvidence }
  expect(retained.sourceCommit).toBe('1a1dabb69ecab03bd274544d5217279d55a7a9ae')
  expect(unit.coverage.modelRequirement).toEqual({ modelRef: retained.modelRef, modelDigest: retained.modelDigest })
  const subjects = new Set([...retained.subjects.map(component => component.id), ...retained.connections.map(edge => edge.id)])
  const retired = new Set(beforeBindings.filter(binding => !subjects.has(binding.elementId)).map(binding => binding.physicalElementId)), elements = new Map(unit.source.elements.map(element => [element.id, element]))
  for (const before of beforeSource.elements) if (!retired.has(before.id)) expect(elements.get(before.id)).toEqual(before)
  for (const annotation of beforeSource.planAnnotations!) if (annotation.kind !== 'label' || !retired.has(annotation.anchor.elementId)) expect(unit.source.planAnnotations).toContainEqual(annotation)
  expect(unit.source.types).toEqual(beforeSource.types)
  expect(unit.source.northAxis).toEqual(beforeSource.northAxis)
  expect(unit.source.layers).toEqual(beforeSource.layers)
  expect(unit.source.levels).toEqual(beforeSource.levels)
  for (const key of ['floorJoints', 'grids', 'contexts', 'projectedOpenings', 'sections'] as const) expect(unit.source.planIntent![key]).toEqual(beforeSource.planIntent![key])
  for (const route of beforeSource.routing!.connections) if (!retired.has(route.id)) expect(unit.source.routing!.connections.find(current => current.id === route.id)).toEqual(route)
  expect(physicalCoverageIssues({ evidence: unit.coverage, physicalIds: [...unit.source.elements.map(element => element.id), ...unit.source.routing!.connections.map(route => route.id)], ownerSubjectIds: [...subjects], bindings: unit.bindings })).toEqual([])
  expect(unit.coverage.dispositions.some(row => row.disposition === 'unresolved')).toBe(false)
  const terminals = new Map(unit.source.routing!.terminals.map(terminal => [terminal.id, terminal]))
  for (const route of unit.source.routing!.connections) {
    const edge = retained.connections.find(edge => edge.id === route.graphConnectionId)!
    const from = terminals.get(route.from)!, to = terminals.get(route.to)!
    expect(edge).toBeDefined()
    expect(`${from.subjectId}.${from.port}`).toBe(String(edge.from)); expect(`${to.subjectId}.${to.port}`).toBe(String(edge.to))
    expect(route.solution!.length).toBeGreaterThanOrEqual(2)
  }
  const sump = unit.source.routing!.terminals.filter(terminal => terminal.subjectId === 'containment' && terminal.port === 'sumpOut')
  expect(sump).toHaveLength(2)
  expect(new Set(sump.map(terminal => terminal.elementId)).size).toBe(2)
  for (const train of ['A', 'B']) {
    for (const prefix of ['rhrRwstSuctionValve', 'rhrSumpSuctionValve', 'rhrInjectionValve', 'siPiggybackValve', 'siRwstSuctionValve', 'rhrSuctionHeader', 'rhrDischargeHeader', 'siSuctionHeader']) {
      const id = `${prefix}${train}`
      expect(unit.bindings).toContainEqual({ physicalElementId: `equipment/${id}`, elementId: id, relation: 'represents' })
      expect(unit.coverage.dispositions.find(row => row.subjectId === id)?.disposition).toBe('direct')
    }
    for (const prefix of ['rhrSuctionHeader', 'rhrDischargeHeader', 'siSuctionHeader']) {
      const ports = unit.source.routing!.terminals.filter(terminal => terminal.subjectId === `${prefix}${train}`)
      expect(ports).toHaveLength(3)
      expect(new Set(ports.map(terminal => terminal.elementId)).size).toBe(3)
      expect(elements.has(`equipment/${prefix}${train}/blind-first`)).toBe(true)
      expect(elements.has(`equipment/${prefix}${train}/blind-last`)).toBe(true)
    }
  }
  // The full compiler revalidates old and new routes together against all
  // retained reservations and every newly installed valve body. None search
  // at delivery, relax clearance, or replace machinery by bounding boxes.
  const compile = (source: unknown, bindings: unknown) => {
    const data = { source: physicalSourceSchema.parse(source), bindings: physicalCorrespondenceSchema.array().parse(bindings) }
    const objects = compilePhysicalObjects(data), routes = compilePhysicalRoutes(data.source, objects)
    const bounds = physicalDraftingAuthoringBounds(physicalObjectsBounds([...objects, ...routes.map(route => route.object)]), data.source.northAxis)
    return compilePhysicalScene('preservation', { ...data, design: { digest: 'authoring' }, owner: { objectId: 'plant:unchanged' }, placement: { anchor: [0, 0], bearing: 0 }, bounds })
  }
  const oldScene = compile(beforeSource, beforeBindings), scene = compile(unit.source, unit.bindings), objects = new Map(scene.objects.map(object => [object.id, object]))
  for (const old of oldScene.objects) if (!retired.has(old.id)) expect(objects.get(old.id)).toEqual(old)
  for (const train of ['A', 'B']) {
    const room = scene.scopes!.find(scope => scope.id === `space/aux-${train.toLowerCase()}-si`)!.bounds
    for (const prefix of ['rhrRwstSuctionValve', 'rhrSumpSuctionValve', 'rhrInjectionValve', 'siPiggybackValve', 'siRwstSuctionValve', 'rhrSuctionHeader', 'rhrDischargeHeader', 'siSuctionHeader']) {
      const body = objects.get(`equipment/${prefix}${train}`)!.bounds!
      for (const axis of [0, 1, 2]) { expect(body.min[axis]!).toBeGreaterThanOrEqual(room.min[axis]!); expect(body.max[axis]!).toBeLessThanOrEqual(room.max[axis]!) }
    }
  }
  expect(campus.source.elements).toEqual(beforeCampusSource.elements)
  expect(campus.bindings).toEqual(beforeCampusBindings)
  expect(compile(campus.source, campus.bindings).objects).toEqual(compile(beforeCampusSource, beforeCampusBindings).objects)
}, 30_000)
