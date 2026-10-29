import { createHash } from 'node:crypto'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../../process-plant/index.ts'
import unitSource from '../pwr-full-unit-manifold.source.json'
import unitBindings from '../pwr-full-unit-manifold.bindings.json'
import unitCoverage from '../pwr-full-unit-operator.coverage.json'
import campusSource from '../pwr-campus-manifold.source.json'
import campusBindings from '../pwr-campus-manifold.bindings.json'
import campusCoverage from '../pwr-campus-manifold.coverage.json'
import { canonicalPhysicalJson, physicalCorrespondenceSchema } from '../model.ts'
import { physicalCoverageEvidenceSchema } from '../coverage.ts'
import { physicalSourceSchema, physicalSourceFacts, elementWorld, parameters, type Element, type Source, type V3 } from '../native/drafting/source.ts'
import { compilePhysicalObjects, compilePhysicalScene } from '../native/drafting/compile-scene.ts'
import { physicalTerminalCandidates } from './terminal-placement.ts'
import { solvePhysicalRoutingNetwork } from '../native/routing/compile.ts'
import type { RoutingTerminal, PhysicalRouting } from '../native/routing/source.ts'
import { physicalSceneShapeFacts } from '../source-validation.ts'

type Axis = [-1 | 0 | 1, -1 | 0 | 1, -1 | 0 | 1]
const hash = (value: unknown) => createHash('sha256').update(canonicalPhysicalJson(value)).digest('hex')
const parsePort = (ref: string) => { const at = ref.lastIndexOf('.'); if (at < 1) throw Error(`Invalid graph port: ${ref}`); return { subject: ref.slice(0, at), port: ref.slice(at + 1) } }

/** RHR is an offline installation revision over the exact retained R6 physical
 * source. All existing architecture/machinery and unrelated routes remain exact.
 * Dimensions, nozzle positions and envelopes are illustrative installation data;
 * they do not retune the numerical Plant or qualify OEM access/penetrations. */
export const createPwrRhrUnitArtifacts = () => {
  const source = physicalSourceSchema.parse(structuredClone(unitSource))
  const bindings = physicalCorrespondenceSchema.array().parse(structuredClone(unitBindings))
  const coverage = physicalCoverageEvidenceSchema.parse(structuredClone(unitCoverage))
  const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'authoring:rhr' }))
  coverage.modelRequirement = { modelRef: plant.modelRef, modelDigest: plant.modelDigest }
  if (!source.routing || !source.planIntent || !source.planAnnotations) throw Error('RHR installation requires retained routing and architectural drawing intent')
  const network = source.routing, graph = plant.sourceGraph, added = new Set<string>()
  const appendEquipment = (subject: string, label: string, family: NonNullable<Element['equipmentKind']>, position: V3, dimensions: { length: number; width: number; height: number }, space: string, building = 'building/auxiliary') => {
    if (!graph.components.some(component => component.id === subject)) throw Error(`RHR installation has no exact graph subject: ${subject}`)
    const id = `equipment/${subject}`, typeId = `type/rhr/${subject}`
    if (source.elements.some(element => element.id === id)) throw Error(`Duplicate installed equipment: ${id}`)
    source.types.push({ id: typeId, kind: family, parameters: dimensions })
    source.elements.push({ id, label, kind: 'equipment', equipmentKind: family, typeId, levelId: 'lower', pose: { position, yaw: 0 }, buildingId: building, spaceIds: [space], disposition: 'installed', foundation: { offset: [-.4, -.4], length: dimensions.length + .8, width: dimensions.width + .8, height: .18 } })
    bindings.push({ physicalElementId: id, elementId: subject, relation: 'represents' })
    coverage.dispositions.push({ subjectId: subject, disposition: 'direct', reason: 'Actual graph-owned RHR cooling-chain component. Physical family, envelope and placement are illustrative installation assumptions; native observations and controls come only from its exact graph subject.', physicalElementIds: [id] })
    source.planAnnotations!.push({ id: `annotation/label/${subject}`, kind: 'label', role: 'equipment', text: label, levelIds: ['lower'], scopeIds: [source.rootScope.id, building, space], layerId: 'plan-labels', anchor: { elementId: id, local: [dimensions.length / 2, dimensions.width + .9, dimensions.height] }, rotation: 0 })
    added.add(id)
  }
  for (const [train, x, ccwX, swX] of [['A', -76, 14, 18.5], ['B', -29, 43, 52]] as const) {
    const lower = train.toLowerCase()
    appendEquipment(`rhrHeatExchanger${train}`, `RHR HX ${train}`, 'heat-exchanger', [x, 43.9, 0], { length: 8, width: 2.5, height: 3.2 }, `space/aux-${lower}-si`)
    appendEquipment(`componentCoolingHeatExchanger${train}`, `CCW HX ${train}`, 'heat-exchanger', [x, 74.2, 0], { length: 8, width: 2.5, height: 3.2 }, `space/aux-${lower}-cooling`)
    appendEquipment(`componentCoolingTank${train}`, `CCW ${train} inventory`, 'tank', [x + 19, train === 'A' ? 75 : 78.3, 0], { length: 3.2, width: 3.2, height: 5 }, `space/aux-${lower}-cooling`)
    appendEquipment(`componentCoolingWaterPumpBreaker${train}`, `CCW ${train} feeder`, 'breaker', [ccwX, 71, 0], { length: 1.8, width: 1, height: 2.6 }, `space/electrical-${lower}`, 'building/electrical-control')
    appendEquipment(`serviceWaterPumpBreaker${train}`, `SW ${train} feeder`, 'breaker', [swX, 71, 0], { length: 1.8, width: 1, height: 2.6 }, `space/electrical-${lower}`, 'building/electrical-control')
    for (const subject of [`componentCoolingWaterPump${train}`, `serviceWaterPump${train}`]) {
      const disposition = coverage.dispositions.find(entry => entry.subjectId === subject)!
      disposition.disposition = 'direct'
      disposition.reason = 'The retained physical pump now represents the exact graph-owned hydraulic pump. Its original machinery geometry is unchanged; actual running, flow and electrical demand are modeled and its explicit feeder breaker owns the sequenced electrical supply.'
      for (const binding of bindings) if (binding.elementId === subject && binding.physicalElementId === `equipment/${subject}`) binding.relation = 'represents'
    }
  }
  // Dedicated hot/cold nozzles are physical source hardware, rather than two
  // logical circuits sharing a nearest-face point. Their ends are exact routing
  // terminals; no renderer heuristics or new equipment families are introduced.
  const nozzle = (subject: string, port: string, local: V3, outward: Axis, diameter: number) => {
    const equipment = source.elements.find(element => element.id === `equipment/${subject}`)!, pose = elementWorld(source, equipment)
    const start = local.map((value, axis) => value + pose.position[axis]!) as V3
    const end = start.map((value, axis) => value + outward[axis]! * .7) as V3
    const position = start.map((value, axis) => Math.min(value, end[axis]!)) as V3, delta = end.map((value, axis) => value - start[axis]!) as V3
    const id = `nozzle/${subject}/${port}`, body: Element = { id, label: `${subject}.${port} illustrative terminal nozzle`, kind: 'support', levelId: 'lower', disposition: 'installed', pose: { position, yaw: 0 }, dimensions: { length: Math.max(Math.abs(delta[0]), diameter), width: Math.max(Math.abs(delta[1]), diameter), height: Math.max(Math.abs(delta[2]), diameter) }, member: { kind: 'tube', points: [start.map((value, axis) => value - position[axis]!) as V3, end.map((value, axis) => value - position[axis]!) as V3], radius: diameter / 2 }, material: 'pipe', layerId: 'utility-routes', buildingId: equipment.buildingId, spaceIds: equipment.spaceIds, planDisplay: 'projection' }
    source.elements.push(body); bindings.push({ physicalElementId: id, elementId: subject, relation: 'partOf' })
    coverage.dispositions.find(entry => entry.subjectId === subject)!.physicalElementIds.push(id)
    source.planIntent!.strokes.push({ elementId: id, levelIds: ['lower'], width: diameter, material: 'pipe' })
    network.terminals.push({ id: `port/${subject}.${port}`, subjectId: subject, port, elementId: equipment.id, local: end.map((value, axis) => value - pose.position[axis]!) as V3, outward })
  }
  for (const train of ['A', 'B']) {
    for (const prefix of ['rhrHeatExchanger', 'componentCoolingHeatExchanger']) {
      const subject = `${prefix}${train}`, element = source.elements.find(element => element.id === `equipment/${subject}`)!, d = parameters(source, element), hot = prefix === 'rhrHeatExchanger' ? .32 : .28, cold = prefix === 'rhrHeatExchanger' ? .28 : .35
      nozzle(subject, 'hotIn', [.04 * d.length, .5 * d.width, .5 * d.height], [-1, 0, 0], hot)
      nozzle(subject, 'hotOut', [.96 * d.length, .5 * d.width, .5 * d.height], [1, 0, 0], hot)
      nozzle(subject, 'coldIn', [.25 * d.length, .08 * d.width, .5 * d.height], [0, -1, 0], cold)
      nozzle(subject, 'coldOut', [.75 * d.length, .92 * d.width, .5 * d.height], [0, 1, 0], cold)
    }
    const subject = `componentCoolingTank${train}`, element = source.elements.find(element => element.id === `equipment/${subject}`)!, d = parameters(source, element)
    nozzle(subject, 'inlet', [.5 * d.length, .94 * d.width, .65 * d.height], [0, 1, 0], .28)
    nozzle(subject, 'outlet', [.5 * d.length, .06 * d.width, .25 * d.height], [0, -1, 0], .28)
  }
  const edges = new Map(graph.connections.map(edge => [String(edge.id), edge]))
  const terminalMap = new Map(network.terminals.map(terminal => [terminal.id, terminal]))
  const replaced = new Set(network.connections.filter(route => {
    const edge = edges.get(route.graphConnectionId), from = terminalMap.get(route.from)!, to = terminalMap.get(route.to)!
    return !edge || edge.from !== `${from.subjectId}.${from.port}` || edge.to !== `${to.subjectId}.${to.port}`
  }).map(route => route.graphConnectionId))
  network.connections = network.connections.filter(route => !replaced.has(route.graphConnectionId))
  for (let index = bindings.length - 1; index >= 0; index--) if (replaced.has(bindings[index]!.elementId)) bindings.splice(index, 1)
  coverage.dispositions = coverage.dispositions.filter(entry => !replaced.has(entry.subjectId))
  const existing = new Set(coverage.dispositions.map(entry => entry.subjectId)), objects = compilePhysicalObjects({ source, bindings }), roster = new Map(objects.map(object => [object.id, object]))
  network.obstacleElementIds.push(...added)
  const terminal = (ref: string, peer: string, kind: 'pipe' | 'electrical'): RoutingTerminal => {
    const id = `port/${ref}`, retained = terminalMap.get(id); if (retained) return retained
    const endpoint = parsePort(ref), peerSubject = parsePort(peer).subject
    const element = source.elements.find(element => element.id === `equipment/${endpoint.subject}`), peerElement = source.elements.find(element => element.id === `equipment/${peerSubject}`)
    if (!element) throw Error(`No physical RHR endpoint body: ${ref}`)
    const other = peerElement ? roster.get(peerElement.id)! : roster.get(terminalMap.get(`port/${peer}`)!.elementId)!
    const toward = other.bounds!.min.map((value, axis) => (value + other.bounds!.max[axis]!) / 2) as V3
    const candidates = physicalTerminalCandidates(source, element, roster.get(element.id)!, endpoint.port, kind, toward)
    const chosen = candidates.sort((a, b) => Math.hypot(...a.point.map((value, axis) => value - toward[axis]!)) - Math.hypot(...b.point.map((value, axis) => value - toward[axis]!)))[0]
    if (!chosen) throw Error(`No actual nozzle or body-surface terminal: ${ref}`)
    const value: RoutingTerminal = { id, subjectId: endpoint.subject, port: endpoint.port, elementId: element.id, local: chosen.local, outward: chosen.outward }
    network.terminals.push(value); terminalMap.set(id, value); return value
  }
  for (const edge of graph.connections) {
    if (existing.has(String(edge.id))) continue
    if (!['fluidFlow', 'electricalPower'].includes(edge.connectionKind)) throw Error(`Unexpected new RHR relationship: ${edge.id}`)
    const kind = edge.connectionKind === 'electricalPower' ? 'electrical' : 'pipe', from = terminal(edge.from, edge.to, kind), to = terminal(edge.to, edge.from, kind)
    const diameter = edge.physical?.diameterM ?? (kind === 'pipe' ? .28 : .12), bendRadius = diameter * 3
    // Envelope follows the actual two endpoint bodies with room for the
    // declared bend radius. All solutions are accepted offline and replayed.
    const endpoints = [roster.get(from.elementId)!, roster.get(to.elementId)!]
    const margin = diameter + bendRadius + .15
    const min = [0, 1, 2].map(axis => Math.min(...endpoints.map(object => object.bounds!.min[axis]! + source.origin[axis]!)) - margin) as V3
    const max = [0, 1, 2].map(axis => Math.max(...endpoints.map(object => object.bounds!.max[axis]! + source.origin[axis]!)) + margin) as V3
    const route: PhysicalRouting['connections'][number] = { id: `connection/${edge.id}`, graphConnectionId: String(edge.id), from: from.id, to: to.id, kind, diameter, clearance: .15, bendRadius, envelope: { min, max }, material: kind === 'electrical' ? 'crane' : 'pipe', layerId: 'utility-routes' }
    const solved = solvePhysicalRoutingNetwork({ ...source, routing: { ...network, connections: [route] } }, objects)!.connections[0]!
    network.connections.push(solved)
    bindings.push({ physicalElementId: solved.id, elementId: String(edge.id), relation: 'represents' })
    coverage.dispositions.push({ subjectId: String(edge.id), disposition: 'direct', reason: 'Exact graph-port RHR cooling-chain installation, with retained authoring-time 3D routing checked against declared machinery and column envelopes. Diameter, nozzle location and civil penetrations remain illustrative.', physicalElementIds: [solved.id] })
  }
  const used = new Set(network.connections.flatMap(route => [route.from, route.to])); network.terminals = network.terminals.filter(terminal => used.has(terminal.id))
  source.evidence.origin += ' RHR revision adds explicit two-train heat exchangers, finite CCW inventory and feeder installations while preserving all original machinery and architecture.'
  coverage.evidence.origin += ' RHR cooling chain adds graph-exact heat exchangers, finite inventories, real pumps/feeders and accepted per-port utility routes; original architecture is retained. It does not qualify suction transfer, strainers, NPSH or cold-shutdown service.'
  return { source: physicalSourceSchema.parse(source), bindings, coverage: physicalCoverageEvidenceSchema.parse(coverage), replaced: [...replaced] }
}

export const createPwrRhrCampusArtifacts = (unit: ReturnType<typeof createPwrRhrUnitArtifacts>) => {
  const source = physicalSourceSchema.parse(structuredClone(campusSource)), bindings = physicalCorrespondenceSchema.array().parse(structuredClone(campusBindings)), coverage = physicalCoverageEvidenceSchema.parse(structuredClone(campusCoverage))
  const scene = compilePhysicalScene('rhr:dependency', { ...unit, design: { digest: 'authoring' }, owner: { objectId: 'authoring' }, placement: { anchor: [0, 0], bearing: 0 }, bounds: { min: [-1e9, -1e9, -1e9], max: [1e9, 1e9, 1e9] } })
  const physicalSourceDigest = hash(physicalSourceFacts(unit.source)), physicalShapeDigest = hash(physicalSceneShapeFacts(scene.objects))
  source.sourceDependencies = source.sourceDependencies!.map(witness => ({ ...witness, physicalSourceDigest, physicalShapeDigest }))
  return { source, bindings, coverage }
}
