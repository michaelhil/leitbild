import { expect, test } from 'bun:test'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { pwrRecirculationUnitPhysicalDesignRef, pwrRecirculationCampusPhysicalDesignRef, pwrShutdownCoolingUnitPhysicalDesignRef, pwrShutdownCoolingCampusPhysicalDesignRef, resolvePhysicalDesign } from '../src/packs/physical-layout/design.ts'
import { physicalCoverageIssues } from '../src/packs/physical-layout/coverage.ts'
import { compilePhysicalScene, compilePhysicalObjects } from '../src/packs/physical-layout/native/drafting/compile-scene.ts'
import { createPwrShutdownCoolingUnitArtifacts, createPwrShutdownCoolingCampusArtifacts } from '../src/packs/physical-layout/authoring/pwr-shutdown-cooling.ts'
import { parameters, elementWorld, type V3 } from '../src/packs/physical-layout/native/drafting/source.ts'
import { compilePhysicalRoutes } from '../src/packs/physical-layout/native/routing/compile.ts'

const drafting = async (ref: unknown) => { const design = await resolvePhysicalDesign(ref); if (design.profile !== 'drafting') throw Error('Expected exact drafting admission'); return design }

test('shutdown cooling and finite DC have graph-exact reproducible native Plan/3D coverage without changing retained geometry', async () => {
  const [previous, current, previousCampus, campus] = await Promise.all([drafting(pwrRecirculationUnitPhysicalDesignRef), drafting(pwrShutdownCoolingUnitPhysicalDesignRef), drafting(pwrRecirculationCampusPhysicalDesignRef), drafting(pwrShutdownCoolingCampusPhysicalDesignRef)])
  const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'shutdown-cooling:admission' }))
  const authored = createPwrShutdownCoolingUnitArtifacts(), authoredCampus = createPwrShutdownCoolingCampusArtifacts(authored)
  expect(current.source).toEqual(authored.source); expect(current.bindings).toEqual(authored.bindings); expect(current.coverageEvidence).toEqual(authored.coverage)
  expect(campus.source).toEqual(authoredCampus.source); expect(campus.bindings).toEqual(authoredCampus.bindings); expect(campus.coverageEvidence).toEqual(authoredCampus.coverage)
  expect(current.modelRequirement).toEqual({ modelRef: plant.modelRef, modelDigest: plant.modelDigest })
  expect(current.modelRequirement).not.toEqual(previous.modelRequirement)
  expect(current.compiler).toEqual(previous.compiler)
  const subjects = [...plant.graph.components.map(component => String(component.id)), ...plant.graph.links.map(link => String(link.id))]
  expect(physicalCoverageIssues({ evidence: current.coverageEvidence, physicalIds: [...current.source.elements.map(element => element.id), ...current.source.routing!.connections.map(route => route.id)], ownerSubjectIds: subjects, bindings: current.bindings })).toEqual([])
  expect(current.coverageEvidence.dispositions.map(row => row.subjectId).sort()).toEqual(subjects.sort())
  expect(current.coverageEvidence.dispositions.some(row => row.disposition === 'unresolved')).toBe(false)
  const elements = new Map(current.source.elements.map(element => [element.id, element]))
  for (const original of previous.source.elements) {
    const changedLabel = /^equipment\/vitalBattery[AB]$/.test(original.id)
    expect(elements.get(original.id)).toEqual(changedLabel ? { ...original, label: elements.get(original.id)!.label } : original)
  }
  for (const route of previous.source.routing!.connections) expect(current.source.routing!.connections.find(candidate => candidate.id === route.id)).toEqual(route)
  for (const annotation of previous.source.planAnnotations!) expect(current.source.planAnnotations!.find(candidate => candidate.id === annotation.id)).toEqual(annotation)
  const compile = (data: typeof current) => compilePhysicalScene('preservation', { ...data, owner: { objectId: 'plant:unchanged' }, placement: { anchor: [0, 0], bearing: 0 } })
  const before = compile(previous), after = compile(current), objects = new Map(after.objects.map(object => [object.id, object]))
  for (const object of before.objects) {
    const retained = objects.get(object.id)!
    expect(retained).toEqual({ ...object, label: retained.label, subjectIds: retained.subjectIds })
  }
  expect(campus.source.elements).toEqual(previousCampus.source.elements); expect(campus.bindings).toEqual(previousCampus.bindings)
  expect(compile(campus).objects).toEqual(compile(previousCampus).objects)
  for (const member of campus.requirements.relatedMembers) {
    expect(member.modelDigest).toBe(plant.modelDigest)
    expect(member.physicalLayout?.physical).toEqual({ id: current.design.id, digest: current.physicalApplicability.digest })
  }
  for (const dependency of campus.source.sourceDependencies!) {
    expect(dependency.physicalSourceDigest).toBe(current.physicalApplicability.sourceDigest)
    expect(dependency.physicalShapeDigest).toBe(current.physicalApplicability.geometryDigest)
  }
}, 30_000)

test('RCS barriers, powered motors and housed processing dependencies retain honest exact physical endpoints', async () => {
  const current = await drafting(pwrShutdownCoolingUnitPhysicalDesignRef), source = current.source
  const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'shutdown-cooling:ports' }))
  const terminals = new Map(source.routing!.terminals.map(terminal => [terminal.id, terminal]))
  const bodies = new Map(compilePhysicalObjects({ source, bindings: current.bindings }).map(object => [object.id, object]))
  for (const route of source.routing!.connections) {
    const edge = plant.sourceGraph.connections.find(edge => String(edge.id) === route.graphConnectionId)!, from = terminals.get(route.from)!, to = terminals.get(route.to)!
    expect(edge).toBeDefined(); expect(`${from.subjectId}.${from.port}`).toBe(edge.from); expect(`${to.subjectId}.${to.port}`).toBe(edge.to)
    expect(route.solution!.length).toBeGreaterThanOrEqual(2)
  }
  for (const train of ['A', 'B']) for (const barrier of [1, 2]) {
    const id = `rhrShutdownSuctionValve${train}${barrier}`, equipment = source.elements.find(element => element.id === `equipment/${id}`)!
    const bounds = bodies.get(equipment.id)!.bounds!, room = source.elements.find(element => element.id === equipment.spaceIds![0])!, roomSize = parameters(source, room)
    for (const axis of [0, 1, 2] as const) {
      const dimension = axis === 0 ? 'length' : axis === 1 ? 'width' : 'height'
      expect(bounds.min[axis]! + source.origin[axis]!).toBeGreaterThanOrEqual(room.pose.position[axis])
      expect(bounds.max[axis]! + source.origin[axis]!).toBeLessThanOrEqual(room.pose.position[axis] + roomSize[dimension])
    }
    expect(source.routing!.connections.some(route => terminals.get(route.to)?.subjectId === id && terminals.get(route.to)?.port === 'motorPower')).toBe(true)
  }
  const takeoffs = source.routing!.terminals.filter(terminal => terminal.subjectId === 'vessel' && terminal.port === 'shutdownCoolingOutlet')
  expect(takeoffs).toHaveLength(2); expect(new Set(takeoffs.map(terminal => JSON.stringify(terminal.local))).size).toBe(2)
  for (const channel of plant.sourceGraph.components.filter(component => component.kind === 'deltaTProtectionChannel')) {
    const row = current.coverageEvidence.dispositions.find(row => row.subjectId === String(channel.id))!
    expect(row.disposition).toBe('housed'); expect(row.physicalElementIds).toHaveLength(1)
    expect(current.bindings).toContainEqual({ physicalElementId: row.physicalElementIds[0]!, elementId: String(channel.id), relation: 'houses' })
    const power = plant.sourceGraph.connections.find(edge => edge.to === `${channel.id}.power`)!
    const dependency = current.coverageEvidence.dispositions.find(row => row.subjectId === String(power.id))!
    expect(dependency.disposition).toBe('functional'); expect(dependency.physicalElementIds).toHaveLength(1)
    expect(source.routing!.connections.some(route => route.graphConnectionId === String(power.id))).toBe(false)
    expect(source.routing!.connections.some(route => route.id === dependency.physicalElementIds[0])).toBe(true)
  }
})

test('new shutdown barrier nozzle and power anchors touch their actual rendered bodies and continuous accepted routes', async () => {
  const current = await drafting(pwrShutdownCoolingUnitPhysicalDesignRef), source = current.source
  const objects = compilePhysicalObjects({ source, bindings: current.bindings }), bodies = new Map(objects.map(object => [object.id, object]))
  const routes = new Map(compilePhysicalRoutes(source, objects).map(route => [route.object.id, route]))
  const dot = (a: V3, b: V3) => a.reduce((sum, value, axis) => sum + value * b[axis]!, 0)
  const sub = (a: V3, b: V3) => a.map((value, axis) => value - b[axis]!) as V3
  for (const terminal of source.routing!.terminals.filter(terminal => terminal.subjectId.startsWith('rhrShutdownSuctionValve'))) {
    const element = source.elements.find(element => element.id === terminal.elementId)!, pose = elementWorld(source, element)
    const c = Math.cos(pose.yaw), s = Math.sin(pose.yaw), [x, y, z] = terminal.local
    const point: V3 = [pose.position[0] + c * x - s * y - source.origin[0], pose.position[1] + s * x + c * y - source.origin[1], pose.position[2] + z - source.origin[2]]
    const body = bodies.get(element.id)!, tolerance = 128 * Number.EPSILON * Math.max(1, ...point.map(Math.abs))
    let onActualTriangle = false
    for (let index = 0; index < body.positions.length; index += 9) {
      const a = body.positions.slice(index, index + 3) as V3, u = sub(body.positions.slice(index + 3, index + 6) as V3, a), v = sub(body.positions.slice(index + 6, index + 9) as V3, a), w = sub(point, a)
      const n: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
      const length = Math.hypot(...n), uu = dot(u, u), vv = dot(v, v), uv = dot(u, v), denominator = uu * vv - uv * uv
      if (!(length > 0 && denominator > 0) || Math.abs(dot(w, n)) > tolerance * length) continue
      const aWeight = (vv * dot(w, u) - uv * dot(w, v)) / denominator, bWeight = (uu * dot(w, v) - uv * dot(w, u)) / denominator
      if (aWeight >= -tolerance && bWeight >= -tolerance && aWeight + bWeight <= 1 + tolerance) { onActualTriangle = true; break }
    }
    expect(onActualTriangle, terminal.id).toBe(true)
    for (const connection of source.routing!.connections.filter(connection => connection.from === terminal.id || connection.to === terminal.id)) {
      const compiled = routes.get(connection.id)!, endpoint = connection.from === terminal.id ? compiled.centerline[0]! : compiled.centerline.at(-1)!
      expect(Math.hypot(...sub(endpoint as V3, point)), connection.id).toBeLessThanOrEqual(tolerance)
    }
  }
  for (const train of ['a', 'b']) {
    const series = source.routing!.connections.find(route => route.graphConnectionId === `rhr-shutdown-suction-${train}-inner-to-outer`)!
    expect(series.solution).toHaveLength(2)
    expect(series.solution![0]![1]).toBe(series.solution![1]![1]); expect(series.solution![0]![2]).toBe(series.solution![1]![2])
    expect(series.solution![1]![0]).toBeGreaterThan(series.solution![0]![0])
  }
})

test('all current Halden Scenarios pin the exact semantic-model physical admissions', async () => {
  for (const name of ['halden-normal-operation', 'halden-power-complex', 'halden-offsite-power-restoration', 'halden-rhr-cooling-chain', 'halden-cold-leg-recirculation', 'halden-station-blackout']) {
    const scenario = await Bun.file(new URL(`../src/scenarios/${name}.scenario.json`, import.meta.url)).json()
    const layouts = scenario.packs.find((pack: { id: string }) => pack.id === 'physical-layout').items
    expect(layouts.length, name).toBeGreaterThan(0)
    for (const layout of layouts) expect(layout.design, `${name}/${layout.id}`).toEqual(layout.design.id === 'pwr-campus' ? pwrShutdownCoolingCampusPhysicalDesignRef : pwrShutdownCoolingUnitPhysicalDesignRef)
  }
})
