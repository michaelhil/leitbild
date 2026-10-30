import { createHash } from 'node:crypto'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../../process-plant/index.ts'
import unitSource from '../pwr-full-unit-recirculation.source.json'
import unitBindings from '../pwr-full-unit-recirculation.bindings.json'
import unitCoverage from '../pwr-full-unit-recirculation.coverage.json'
import campusSource from '../pwr-campus-recirculation.source.json'
import campusBindings from '../pwr-campus-recirculation.bindings.json'
import campusCoverage from '../pwr-campus-recirculation.coverage.json'
import { canonicalPhysicalJson, physicalCorrespondenceSchema } from '../model.ts'
import { physicalCoverageEvidenceSchema } from '../coverage.ts'
import { physicalSourceSchema, physicalSourceFacts, type Element, type V3 } from '../native/drafting/source.ts'
import { compilePhysicalObjects, compilePhysicalScene, physicalObjectsBounds } from '../native/drafting/compile-scene.ts'
import { physicalTerminalCandidates } from './terminal-placement.ts'
import { compilePhysicalRoutes, solvePhysicalRoutingNetwork } from '../native/routing/compile.ts'
import { physicalDraftingAuthoringBounds } from '../native/drafting/frame.ts'
import type { RoutingTerminal, PhysicalRouting } from '../native/routing/source.ts'
import { physicalSceneShapeFacts } from '../source-validation.ts'
import { installPwrDcSupportHardware } from './pwr-dc-support.ts'

const hash = (value: unknown) => createHash('sha256').update(canonicalPhysicalJson(value)).digest('hex')
const parsePort = (ref: string) => { const at = ref.lastIndexOf('.'); if (at < 1) throw Error(`Invalid graph port: ${ref}`); return { subject: ref.slice(0, at), port: ref.slice(at + 1) } }

/** Offline native installation over admitted R9, with graph-exact RCS
 * takeoffs/barriers and DC support. Retained architecture, machinery, roads
 * and unrelated accepted utility routes remain exact. Dimensions, equipment
 * placement and civil penetrations are explicit illustrative assumptions. */
export const createPwrShutdownCoolingUnitArtifacts = () => {
  const source = physicalSourceSchema.parse(structuredClone(unitSource)), bindings = physicalCorrespondenceSchema.array().parse(structuredClone(unitBindings))
  const coverage = physicalCoverageEvidenceSchema.parse(structuredClone(unitCoverage))
  const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'authoring:shutdown-cooling' })), graph = plant.sourceGraph
  coverage.modelRequirement = { modelRef: plant.modelRef, modelDigest: plant.modelDigest }
  if (!source.routing || !source.planIntent || !source.planAnnotations) throw Error('Shutdown-cooling installation requires retained architectural drawing and routing intent')
  const network = source.routing, added = new Set(installPwrDcSupportHardware({ source, bindings, coverage, plant }))
  for (const [train, offset] of [['A', 0], ['B', 47]] as const) for (const [barrier, y] of [[1, 54], [2, 57]] as const) {
    const subject = `rhrShutdownSuctionValve${train}${barrier}`, id = `equipment/${subject}`, label = `RHR ${train} RCS ${barrier === 1 ? 'inner' : 'outer'} isolation`
    if (!graph.components.some(component => component.id === subject)) throw Error(`Missing shutdown-cooling graph component ${subject}`)
    const body: Element = { id, label, kind: 'equipment', equipmentKind: 'valve', typeId: 'type/campus/valve/1.8x1.4x2.5',
      levelId: 'lower', pose: { position: [-90.5 + offset, y, 0], yaw: 0 }, buildingId: 'building/auxiliary', spaceIds: [`space/aux-${train.toLowerCase()}-si`], disposition: 'installed' }
    source.elements.push(body); added.add(id)
    bindings.push({ physicalElementId: id, elementId: subject, relation: 'represents' })
    coverage.dispositions.push({ subjectId: subject, disposition: 'direct', reason: 'Exact graph-owned series RCS suction barrier with achieved finite travel and modeled source admission. Hardware envelope, mounting and civil installation are illustrative; this is not a qualified pressure boundary or safety-channel design.', physicalElementIds: [id] })
    source.planAnnotations.push({ id: `annotation/label/${subject}`, kind: 'label', role: 'equipment', text: label, levelIds: ['lower'],
      scopeIds: [source.rootScope.id, 'building/auxiliary', `space/aux-${train.toLowerCase()}-si`], layerId: 'plan-labels', anchor: { elementId: id, local: [.9, 2, 2.5] }, rotation: 0 })
  }
  // Two separate physical takeoffs belong to the same finite vessel inventory
  // and the same logical source port. They do not duplicate its water budget.
  const takeoffs = new Map<string, RoutingTerminal>()
  const vessel = source.elements.find(element => element.id === 'equipment/vessel')!
  for (const [train, x, direction] of [['A', -53.08, -1], ['B', -46.92, 1]] as const) {
    const id = `nozzle/vessel/shutdownCoolingOutlet/${train}`, length = 1.12, start: V3 = [x, 8, 9.18], end: V3 = [x + direction * length, 8, 9.18]
    const position: V3 = [Math.min(start[0], end[0]), start[1], start[2]], local = (point: V3): V3 => point.map((value, axis) => value - position[axis]!) as V3
    source.elements.push({ id, label: `Illustrative RCS shutdown-cooling takeoff ${train}`, kind: 'support', levelId: 'service', disposition: 'installed',
      pose: { position, yaw: 0 }, dimensions: { length, width: .32, height: .32 }, member: { kind: 'tube', points: [local(start), local(end)], radius: .16 },
      material: 'pipe', layerId: 'utility-routes', buildingId: vessel.buildingId, spaceIds: vessel.spaceIds, planDisplay: 'projection' })
    bindings.push({ physicalElementId: id, elementId: 'vessel', relation: 'partOf' })
    coverage.dispositions.find(row => row.subjectId === 'vessel')!.physicalElementIds.push(id)
    source.planIntent.strokes.push({ elementId: id, levelIds: ['lower', 'service'], width: .32, material: 'pipe' })
    const terminal: RoutingTerminal = { id: `port/vessel.shutdownCoolingOutlet/${train}`, subjectId: 'vessel', port: 'shutdownCoolingOutlet', elementId: vessel.id,
      local: end.map((value, axis) => value - vessel.pose.position[axis]!) as V3, outward: [direction, 0, 0] }
    network.terminals.push(terminal); takeoffs.set(`rhrShutdownSuctionValve${train}1.inlet`, terminal)
  }
  const edges = new Map(graph.connections.map(edge => [String(edge.id), edge])), terminalMap = new Map(network.terminals.map(terminal => [terminal.id, terminal]))
  const replaced = new Set(network.connections.filter(route => {
    const edge = edges.get(route.graphConnectionId), from = terminalMap.get(route.from)!, to = terminalMap.get(route.to)!
    return !edge || edge.from !== `${from.subjectId}.${from.port}` || edge.to !== `${to.subjectId}.${to.port}`
  }).map(route => route.graphConnectionId))
  network.connections = network.connections.filter(route => !replaced.has(route.graphConnectionId))
  for (let index = bindings.length - 1; index >= 0; index--) if (replaced.has(bindings[index]!.elementId)) bindings.splice(index, 1)
  coverage.dispositions = coverage.dispositions.filter(row => !replaced.has(row.subjectId))
  network.obstacleElementIds.push(...[...added].filter(id => !network.obstacleElementIds.includes(id)))
  const objects = compilePhysicalObjects({ source, bindings }), roster = new Map(objects.map(object => [object.id, object]))
  const bodyFor = (subject: string): Element | undefined => source.elements.find(element => element.id === `equipment/${subject}`)
    ?? source.elements.find(element => bindings.some(binding => binding.elementId === subject && binding.physicalElementId === element.id && (binding.relation === 'houses' || binding.relation === 'represents')) && element.kind === 'equipment')
  const terminal = (ref: string, peer: string, kind: 'pipe' | 'electrical'): RoutingTerminal => {
    const takeoff = ref === 'vessel.shutdownCoolingOutlet' ? takeoffs.get(peer) : undefined
    if (takeoff) return takeoff
    const id = `port/${ref}`, retained = terminalMap.get(id); if (retained) return retained
    const endpoint = parsePort(ref), element = bodyFor(endpoint.subject), peerElement = bodyFor(parsePort(peer).subject)
    if (!element) throw Error(`No exact equipment or authored housing for physical endpoint ${ref}`)
    const peerTerminal = peer === 'vessel.shutdownCoolingOutlet' ? takeoffs.get(ref) : terminalMap.get(`port/${peer}`)
    const peerObject = peerElement ? roster.get(peerElement.id)! : peerTerminal ? roster.get(peerTerminal.elementId)! : undefined
    if (!peerObject) throw Error(`No installed physical peer ${peer}`)
    const toward = peerObject.bounds!.min.map((value, axis) => (value + peerObject.bounds!.max[axis]!) / 2) as V3
    const chosen = physicalTerminalCandidates(source, element, roster.get(element.id)!, endpoint.port, kind, toward)
      .sort((a, b) => Math.hypot(...a.point.map((value, axis) => value - toward[axis]!)) - Math.hypot(...b.point.map((value, axis) => value - toward[axis]!)))[0]
    if (!chosen) throw Error(`No exact body-surface terminal ${ref}`)
    const value: RoutingTerminal = { id, subjectId: endpoint.subject, port: endpoint.port, elementId: element.id, local: chosen.local, outward: chosen.outward }
    network.terminals.push(value); terminalMap.set(id, value); return value
  }
  const existing = new Set(coverage.dispositions.map(row => row.subjectId))
  for (const edge of graph.connections) {
    if (existing.has(String(edge.id))) continue
    if (edge.connectionKind !== 'fluidFlow' && edge.connectionKind !== 'electricalPower') throw Error(`Unexpected new shutdown-cooling relationship ${edge.id}`)
    const recipient = graph.components.find(component => edge.to.startsWith(`${component.id}.`) && component.kind === 'deltaTProtectionChannel')
    if (recipient && edge.connectionKind === 'electricalPower') {
      const housing = bindings.find(binding => binding.elementId === String(recipient.id) && binding.relation === 'houses')
      const cabinetSubject = housing && bindings.find(binding => binding.physicalElementId === housing.physicalElementId && binding.relation !== 'houses')?.elementId
      const feeder = graph.connections.find(candidate => candidate.from === edge.from && candidate.to === `${cabinetSubject}.power`)
      const physicalFeed = feeder && network.connections.find(candidate => candidate.graphConnectionId === String(feeder.id))
      if (!housing || !physicalFeed) throw Error(`No explicit retained cabinet feeder for internal processing dependency ${edge.id}`)
      coverage.dispositions.push({ subjectId: String(edge.id), disposition: 'functional',
        reason: 'The delta-T processing function is housed in the already supplied controls cabinet. This zero-extra-load electrical dependency is internal to that assembly and references its retained feeder; it is not another external field cable and is not independently localized or given an invented cable length.', physicalElementIds: [physicalFeed.id] })
      continue
    }
    const kind = edge.connectionKind === 'electricalPower' ? 'electrical' : 'pipe', from = terminal(edge.from, edge.to, kind), to = terminal(edge.to, edge.from, kind)
    const diameter = edge.physical?.diameterM ?? (kind === 'pipe' ? .32 : .12), bendRadius = diameter * 3, margin = diameter + bendRadius + .15
    const endpoints = [roster.get(from.elementId)!, roster.get(to.elementId)!]
    const min = [0, 1, 2].map(axis => Math.min(...endpoints.map(object => object.bounds!.min[axis]! + source.origin[axis]!)) - margin) as V3
    const max = [0, 1, 2].map(axis => Math.max(...endpoints.map(object => object.bounds!.max[axis]! + source.origin[axis]!)) + margin) as V3
    const via: V3[] = edge.from === 'vessel.shutdownCoolingOutlet'
      ? edge.to === 'rhrShutdownSuctionValveA1.inlet' ? [[-82, 8, 9.18], [-82, 40, 4.5]] : [[-18, 8, 9.18], [-18, 40, 4.5]] : []
    for (const point of via) for (const axis of [0, 1, 2]) { min[axis] = Math.min(min[axis]!, point[axis]! - margin); max[axis] = Math.max(max[axis]!, point[axis]! + margin) }
    const route: PhysicalRouting['connections'][number] = { id: `connection/${edge.id}`, graphConnectionId: String(edge.id), from: from.id, to: to.id,
      kind, diameter, clearance: .15, bendRadius, envelope: { min, max }, ...(via.length ? { via } : {}), material: kind === 'electrical' ? 'crane' : 'pipe', layerId: 'utility-routes' }
    const solved = solvePhysicalRoutingNetwork({ ...source, routing: { ...network, connections: [route] } }, objects)!.connections[0]!
    network.connections.push(solved); bindings.push({ physicalElementId: solved.id, elementId: String(edge.id), relation: 'represents' })
    coverage.dispositions.push({ subjectId: String(edge.id), disposition: 'direct', reason: 'Exact native graph-port installation with an offline accepted 3D route. Geometry and penetrations are illustrative; live flow, supply and actuator state come from the graph, and no runtime routing or ID-based drawing repair is performed.', physicalElementIds: [solved.id] })
  }
  const used = new Set(network.connections.flatMap(route => [route.from, route.to])); network.terminals = network.terminals.filter(terminal => used.has(terminal.id))
  source.evidence.origin += ' Shutdown-cooling/DC revision adds exact graph-bound RCS takeoffs, series suction barriers and named electrical support while retaining the previous architectural and machinery source. Installation dimensions and civil penetrations are illustrative.'
  coverage.evidence.origin += ' Closed RCS shutdown-cooling and DC supply identities/routes are represented explicitly. This does not qualify reverse pressure, NPSH, safety-channel power or reference operating procedures.'
  return { source: physicalSourceSchema.parse(source), bindings, coverage: physicalCoverageEvidenceSchema.parse(coverage), replaced: [...replaced] }
}

export const createPwrShutdownCoolingCampusArtifacts = (unit: ReturnType<typeof createPwrShutdownCoolingUnitArtifacts>) => {
  const source = physicalSourceSchema.parse(structuredClone(campusSource)), bindings = physicalCorrespondenceSchema.array().parse(structuredClone(campusBindings)), coverage = physicalCoverageEvidenceSchema.parse(structuredClone(campusCoverage))
  const objects = compilePhysicalObjects({ source: unit.source, bindings: unit.bindings }), routes = compilePhysicalRoutes(unit.source, objects)
  const bounds = physicalDraftingAuthoringBounds(physicalObjectsBounds([...objects, ...routes.map(route => route.object)]), unit.source.northAxis)
  const scene = compilePhysicalScene('shutdown-cooling:dependency', { ...unit, design: { digest: 'authoring' }, owner: { objectId: 'authoring' }, placement: { anchor: [0, 0], bearing: 0 }, bounds })
  const physicalSourceDigest = hash(physicalSourceFacts(unit.source)), physicalShapeDigest = hash(physicalSceneShapeFacts(scene.objects))
  source.sourceDependencies = source.sourceDependencies!.map(witness => ({ ...witness, physicalSourceDigest, physicalShapeDigest }))
  return { source, bindings, coverage }
}
