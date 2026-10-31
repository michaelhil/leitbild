import { createHash } from 'node:crypto'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../../process-plant/index.ts'
import unitSource from '../pwr-full-unit-rhr.source.json'
import unitBindings from '../pwr-full-unit-rhr.bindings.json'
import unitCoverage from '../pwr-full-unit-rhr.coverage.json'
import campusSource from '../pwr-campus-rhr.source.json'
import campusBindings from '../pwr-campus-rhr.bindings.json'
import campusCoverage from '../pwr-campus-rhr.coverage.json'
import { canonicalPhysicalJson, physicalCorrespondenceSchema } from '../model.ts'
import { physicalCoverageEvidenceSchema } from '../coverage.ts'
import { physicalSourceSchema, physicalSourceFacts, type Element, type V3 } from '../native/drafting/source.ts'
import { compilePhysicalObjects, compilePhysicalScene, physicalObjectsBounds } from '../native/drafting/compile-scene.ts'
import { physicalTerminalCandidates } from './terminal-placement.ts'
import { compilePhysicalRoutes, solvePhysicalRoutingNetwork } from '../native/routing/compile.ts'
import { physicalDraftingAuthoringBounds } from '../native/drafting/frame.ts'
import type { RoutingTerminal, PhysicalRouting } from '../native/routing/source.ts'
import { physicalSceneShapeFacts } from '../source-validation.ts'

type Axis = [-1 | 0 | 1, -1 | 0 | 1, -1 | 0 | 1]
const hash = (value: unknown) => createHash('sha256').update(canonicalPhysicalJson(value)).digest('hex')
const parsePort = (ref: string) => { const at = ref.lastIndexOf('.'); if (at < 1) throw Error(`Invalid graph port: ${ref}`); return { subject: ref.slice(0, at), port: ref.slice(at + 1) } }

/** Offline installation over retained R8. Source selection is graph-owned;
 * this revision installs its exact valve/manifold hardware and accepted routes.
 * All dimensions and civil penetrations remain illustrative, not as-built. */
export const createPwrRecirculationUnitInstallation = () => {
  const source = physicalSourceSchema.parse(structuredClone(unitSource))
  const bindings = physicalCorrespondenceSchema.array().parse(structuredClone(unitBindings))
  const coverage = physicalCoverageEvidenceSchema.parse(structuredClone(unitCoverage))
  const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'authoring:recirculation' }))
  coverage.modelRequirement = { modelRef: plant.modelRef, modelDigest: plant.modelDigest }
  if (!source.routing || !source.planIntent || !source.planAnnotations) throw Error('Recirculation installation requires retained architectural drawing and routing intent')
  const network = source.routing, graph = plant.sourceGraph, subjects = new Set(graph.components.map(component => String(component.id)))
  const retiredSubjects = new Set(coverage.dispositions.filter(row => !subjects.has(row.subjectId) && !graph.connections.some(edge => edge.id === row.subjectId)).map(row => row.subjectId))
  const retiredElements = new Set(bindings.filter(binding => retiredSubjects.has(binding.elementId)).map(binding => binding.physicalElementId))
  source.elements = source.elements.filter(element => !retiredElements.has(element.id))
  const retiredAnnotations = new Set(source.planAnnotations.filter(annotation => annotation.kind === 'label' && retiredElements.has(annotation.anchor.elementId)).map(annotation => annotation.id))
  source.planAnnotations = source.planAnnotations.filter(annotation => !retiredAnnotations.has(annotation.id))
  source.planIntent.strokes = source.planIntent.strokes.filter(stroke => !retiredElements.has(stroke.elementId))
  source.planIntent.labelPositions = source.planIntent.labelPositions.filter(label => !retiredAnnotations.has(label.annotationId))
  network.obstacleElementIds = network.obstacleElementIds.filter(id => !retiredElements.has(id))
  network.terminals = network.terminals.filter(terminal => !retiredSubjects.has(terminal.subjectId) && !retiredElements.has(terminal.elementId))
  network.connections = network.connections.filter(route => !retiredSubjects.has(route.graphConnectionId))
  for (let index = bindings.length - 1; index >= 0; index--) if (retiredSubjects.has(bindings[index]!.elementId)) bindings.splice(index, 1)
  coverage.dispositions = coverage.dispositions.filter(row => !retiredSubjects.has(row.subjectId))
  const added = new Set<string>(), sumpPenetrations = new Map<string, RoutingTerminal>()
  const register = (subject: string, body: Element, label: string) => {
    if (!subjects.has(subject)) throw Error(`No exact recirculation graph subject: ${subject}`)
    if (source.elements.some(element => element.id === body.id)) throw Error(`Duplicate recirculation installation: ${body.id}`)
    source.elements.push(body)
    // As in the retained manifold installations, pipe hardware belongs to
    // the network itself. Reserved routing solids are machinery/civil bodies;
    // a terminal on its manifold nozzle is not an unrelated obstacle.
    if (body.kind === 'equipment') added.add(body.id)
    bindings.push({ physicalElementId: body.id, elementId: subject, relation: 'represents' })
    coverage.dispositions.push({ subjectId: subject, disposition: 'direct', reason: 'Graph-owned per-train source-transfer hardware with exact port identity. Physical envelope, mounting and civil penetrations are illustrative installation assumptions; observations and controls come from this exact native subject.', physicalElementIds: [body.id] })
    source.planAnnotations!.push({ id: `annotation/label/${subject}`, kind: 'label', role: 'equipment', text: label, levelIds: ['lower'], scopeIds: [source.rootScope.id, body.buildingId!, ...body.spaceIds!], layerId: 'plan-labels', anchor: { elementId: body.id, local: body.kind === 'pipe' ? body.path![0]! : [.9, 2, 2.5] }, rotation: 0 })
  }
  const valve = (subject: string, label: string, position: V3, train: string) => register(subject, {
    id: `equipment/${subject}`, label, kind: 'equipment', equipmentKind: 'valve', typeId: 'type/campus/valve/1.8x1.4x2.5',
    levelId: 'lower', pose: { position, yaw: 0 }, buildingId: 'building/auxiliary', spaceIds: [`space/aux-${train.toLowerCase()}-si`], disposition: 'installed',
  }, label)
  const tube = (subject: string, id: string, label: string, from: V3, to: V3, radius: number, train: string): Element => {
    const position = from.map((value, axis) => Math.min(value, to[axis]!)) as V3, delta = to.map((value, axis) => value - from[axis]!) as V3
    const body: Element = { id, label, kind: 'support', levelId: 'lower', disposition: 'installed', pose: { position, yaw: 0 }, dimensions: { length: Math.max(Math.abs(delta[0]), radius * 2), width: Math.max(Math.abs(delta[1]), radius * 2), height: Math.max(Math.abs(delta[2]), radius * 2) }, member: { kind: 'tube', points: [from.map((value, axis) => value - position[axis]!) as V3, to.map((value, axis) => value - position[axis]!) as V3], radius }, material: 'pipe', layerId: 'utility-routes', buildingId: 'building/auxiliary', spaceIds: [`space/aux-${train.toLowerCase()}-si`], planDisplay: 'projection' }
    source.elements.push(body); bindings.push({ physicalElementId: id, elementId: subject, relation: 'partOf' })
    coverage.dispositions.find(row => row.subjectId === subject)!.physicalElementIds.push(id)
    source.planIntent!.strokes.push({ elementId: id, levelIds: ['lower'], width: radius * 2, material: 'pipe' })
    return body
  }
  const manifold = (subject: string, label: string, from: V3, length: number, taps: ReadonlyArray<{ port: string; at: number; outward: Axis }>, train: string) => {
    const id = `equipment/${subject}`, to: V3 = [from[0] + length, from[1], from[2]]
    register(subject, { id, label, kind: 'pipe', levelId: 'lower', pose: { position: [0, 0, 0], yaw: 0 }, dimensions: { length: 1, width: .4, height: .4 }, path: [from, to], material: 'pipe', layerId: 'utility-routes', buildingId: 'building/auxiliary', spaceIds: [`space/aux-${train.toLowerCase()}-si`], disposition: 'installed' }, label)
    for (const [name, point] of [['first', from], ['last', to]] as const) tube(subject, `${id}/blind-${name}`, `${label} blind end plate`, [point[0] - .06, point[1], point[2]], [point[0] + .06, point[1], point[2]], .28, train)
    for (const tap of taps) {
      const center: V3 = [from[0] + tap.at, from[1], from[2]], end = center.map((value, axis) => value + tap.outward[axis]! * .7) as V3
      const nozzle = tube(subject, `${id}/nozzle/${tap.port}`, `${label} ${tap.port} nozzle`, center, end, .14, train)
      tube(subject, `${id}/flange/${tap.port}`, `${label} ${tap.port} flange`, end.map((value, axis) => value - tap.outward[axis]! * .1) as V3, end, .23, train)
      network.terminals.push({ id: `port/${subject}.${tap.port}`, subjectId: subject, port: tap.port, elementId: nozzle.id, local: end.map((value, axis) => value - nozzle.pose.position[axis]!) as V3, outward: tap.outward })
    }
  }
  for (const [train, offset] of [['A', 0], ['B', 47]] as const) {
    // The containment volume has one functional sump outlet. Its two train
    // takeoffs are separate physical occurrences of that same port, so two
    // pipes do not share coincident swept geometry at a guessed wall point.
    const x = train === 'A' ? -60 : -40, id = `nozzle/containment/sumpOut/${train}`
    source.elements.push({ id, label: `Illustrative sump outlet ${train} penetration`, kind: 'support', levelId: 'lower', disposition: 'installed', pose: { position: [x, 34.8, .8], yaw: 0 }, dimensions: { length: .28, width: 3.7, height: .28 }, member: { kind: 'tube', points: [[0, 0, 0], [0, 3.7, 0]], radius: .14 }, material: 'pipe', layerId: 'utility-routes', buildingId: 'building/containment', planDisplay: 'projection' })
    bindings.push({ physicalElementId: id, elementId: 'containment', relation: 'partOf' })
    coverage.dispositions.find(row => row.subjectId === 'containment')!.physicalElementIds.push(id)
    source.planIntent!.strokes.push({ elementId: id, levelIds: ['lower'], width: .28, material: 'pipe' })
    const terminal: RoutingTerminal = { id: `port/containment.sumpOut/${train}`, subjectId: 'containment', port: 'sumpOut', elementId: id, local: [0, 3.7, 0], outward: [0, 1, 0] }
    network.terminals.push(terminal); sumpPenetrations.set(`rhrSumpSuctionValve${train}.inlet`, terminal)
    valve(`rhrRwstSuctionValve${train}`, `RHR ${train} RWST isolation`, [-90.5 + offset, 44.5, 0], train)
    valve(`rhrSumpSuctionValve${train}`, `RHR ${train} sump isolation`, [-90.5 + offset, 47, 0], train)
    valve(`rhrInjectionValve${train}`, `RHR ${train} injection isolation`, [-74 + offset, 58.3, 0], train)
    valve(`siPiggybackValve${train}`, `SI ${train} RHR isolation`, [-69 + offset, 55.5, 0], train)
    valve(`siRwstSuctionValve${train}`, `SI ${train} RWST isolation`, [-56.5 + offset, 47, 0], train)
    manifold(`rhrSuctionHeader${train}`, `RHR ${train} suction`, [-81.5 + offset, 46.8, 1.7], 4.5, [{ port: 'inletA', at: .9, outward: [0, -1, 0] }, { port: 'inletB', at: 2.8, outward: [0, -1, 0] }, { port: 'outletA', at: 1.85, outward: [0, 1, 0] }], train)
    manifold(`rhrDischargeHeader${train}`, `RHR ${train} cooled discharge`, [-79 + offset, 57, 3.8], 5, [{ port: 'inletA', at: .8, outward: [0, -1, 0] }, { port: 'outletA', at: 2.5, outward: [0, 1, 0] }, { port: 'outletB', at: 4, outward: [0, -1, 0] }], train)
    manifold(`siSuctionHeader${train}`, `SI ${train} suction`, [-65 + offset, 55.2, 1.7], 4, [{ port: 'inletA', at: .7, outward: [0, 1, 0] }, { port: 'inletB', at: 2.6, outward: [0, 1, 0] }, { port: 'outletA', at: 1.6, outward: [0, -1, 0] }], train)
  }
  return { source, bindings, coverage, retiredElements: [...retiredElements], added, sumpPenetrations }
}

export const createPwrRecirculationUnitArtifacts = () => {
  const { source, bindings, coverage, retiredElements, added, sumpPenetrations } = createPwrRecirculationUnitInstallation()
  const network = source.routing!, graph = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'authoring:recirculation' })).sourceGraph
  const terminalMap = new Map(network.terminals.map(terminal => [terminal.id, terminal]))
  const objects = compilePhysicalObjects({ source, bindings }), roster = new Map(objects.map(object => [object.id, object]))
  network.obstacleElementIds.push(...added)
  const terminal = (ref: string, peer: string): RoutingTerminal => {
    const sump = ref === 'containment.sumpOut' ? sumpPenetrations.get(peer) : undefined
    if (sump) return sump
    const id = `port/${ref}`, retained = terminalMap.get(id); if (retained) return retained
    const endpoint = parsePort(ref), peerSubject = parsePort(peer).subject
    const element = source.elements.find(element => element.id === `equipment/${endpoint.subject}`), peerElement = source.elements.find(element => element.id === `equipment/${peerSubject}`)
    if (!element) throw Error(`No physical source-transfer endpoint: ${ref}`)
    const peerTerminal = peer === 'containment.sumpOut' ? sumpPenetrations.get(ref) : terminalMap.get(`port/${peer}`)
    const peerObject = peerElement ? roster.get(peerElement.id)! : peerTerminal ? roster.get(peerTerminal.elementId)! : undefined
    if (!peerObject) throw Error(`No installed physical peer for source transfer: ${peer}`)
    const toward = peerObject.bounds!.min.map((value, axis) => (value + peerObject.bounds!.max[axis]!) / 2) as V3
    const candidates = physicalTerminalCandidates(source, element, roster.get(element.id)!, endpoint.port, 'pipe', toward)
    const chosen = candidates.sort((a, b) => Math.hypot(...a.point.map((value, axis) => value - toward[axis]!)) - Math.hypot(...b.point.map((value, axis) => value - toward[axis]!)))[0]
    if (!chosen) throw Error(`No explicit surface terminal for source transfer: ${ref}`)
    const value: RoutingTerminal = { id, subjectId: endpoint.subject, port: endpoint.port, elementId: element.id, local: chosen.local, outward: chosen.outward }
    network.terminals.push(value); terminalMap.set(id, value); return value
  }
  const existing = new Set(coverage.dispositions.map(row => row.subjectId))
  for (const edge of graph.connections) {
    if (existing.has(String(edge.id))) continue
    if (edge.connectionKind !== 'fluidFlow') throw Error(`Unexpected new recirculation relationship: ${edge.id}`)
    const from = terminal(edge.from, edge.to), to = terminal(edge.to, edge.from), diameter = edge.physical?.diameterM ?? .28, bendRadius = diameter * 3
    const endpoints = [roster.get(from.elementId)!, roster.get(to.elementId)!], margin = diameter + bendRadius + .15
    const min = [0, 1, 2].map(axis => Math.min(...endpoints.map(object => object.bounds!.min[axis]! + source.origin[axis]!)) - margin) as V3
    const max = [0, 1, 2].map(axis => Math.max(...endpoints.map(object => object.bounds!.max[axis]! + source.origin[axis]!)) + margin) as V3
    // The new suction-isolation branches use the room's overhead service
    // corridor. This is installation guidance, retained with the accepted
    // route; the live renderer performs no path search or ID-based repair.
    const suctionIsolation = /^rhr-(rwst|sump)-suction-valve-[ab]-to-suction-header$/.test(String(edge.id))
    const via: V3[] = suctionIsolation ? [[(endpoints[0]!.bounds!.min[0] + endpoints[1]!.bounds!.min[0]) / 2 + source.origin[0], endpoints[0]!.bounds!.min[1] + source.origin[1], 4.5]] : []
    for (const point of via) for (const axis of [0, 1, 2]) { min[axis] = Math.min(min[axis]!, point[axis]! - margin); max[axis] = Math.max(max[axis]!, point[axis]! + margin) }
    const route: PhysicalRouting['connections'][number] = { id: `connection/${edge.id}`, graphConnectionId: String(edge.id), from: from.id, to: to.id, kind: 'pipe', diameter, clearance: .15, bendRadius, envelope: { min, max }, ...(via.length ? { via } : {}), material: 'pipe', layerId: 'utility-routes' }
    const solved = solvePhysicalRoutingNetwork({ ...source, routing: { ...network, connections: [route] } }, objects)!.connections[0]!
    network.connections.push(solved)
    bindings.push({ physicalElementId: solved.id, elementId: String(edge.id), relation: 'represents' })
    coverage.dispositions.push({ subjectId: String(edge.id), disposition: 'direct', reason: 'Exact graph-port per-train source-transfer or injection relationship, accepted by offline 3D obstacle and bend-clearance routing. Installation dimensions and penetrations are illustrative; this is not a pressure-network, NPSH or reverse-flow qualification.', physicalElementIds: [solved.id] })
  }
  const used = new Set(network.connections.flatMap(route => [route.from, route.to])); network.terminals = network.terminals.filter(terminal => used.has(terminal.id))
  source.evidence.origin = 'Illustrative native recirculation installation authored 30 October 2026 over the exact retained R8 source. Only retired common RHR hardware is replaced by per-train suction/discharge manifolds, source/injection isolation valves and exact accepted 3D routes. Two physical sump penetrations represent takeoffs from the same existing containment sump port. Turbine architecture, receiving-water equipment and unrelated routes remain exact. Dimensions, mounting and civil penetrations are installation assumptions, not OEM, as-built or safety qualification.'
  coverage.evidence.origin = 'Graph-exact native recirculation installation over retained R8/R10 history. Train-local source valves, suction/discharge manifolds, injection valves and SI piggyback routes represent their canonical graph subjects. Only retired common RHR subjects are removed. Sump takeoffs are physical parts of containment. This correspondence does not certify strainers, NPSH, reverse pressure, adequate cooling capacity or hot-leg service.'
  return { source: physicalSourceSchema.parse(source), bindings, coverage: physicalCoverageEvidenceSchema.parse(coverage), retiredElements }
}

export const createPwrRecirculationCampusArtifacts = (unit: ReturnType<typeof createPwrRecirculationUnitArtifacts>) => {
  const source = physicalSourceSchema.parse(structuredClone(campusSource)), bindings = physicalCorrespondenceSchema.array().parse(structuredClone(campusBindings)), coverage = physicalCoverageEvidenceSchema.parse(structuredClone(campusCoverage))
  const objects = compilePhysicalObjects({ source: unit.source, bindings: unit.bindings })
  const routes = compilePhysicalRoutes(unit.source, objects)
  const bounds = physicalDraftingAuthoringBounds(physicalObjectsBounds([...objects, ...routes.map(route => route.object)]), unit.source.northAxis)
  const scene = compilePhysicalScene('recirculation:dependency', { ...unit, design: { digest: 'authoring' }, owner: { objectId: 'authoring' }, placement: { anchor: [0, 0], bearing: 0 }, bounds })
  const physicalSourceDigest = hash(physicalSourceFacts(unit.source)), physicalShapeDigest = hash(physicalSceneShapeFacts(scene.objects))
  source.sourceDependencies = source.sourceDependencies!.map(witness => ({ ...witness, physicalSourceDigest, physicalShapeDigest }))
  return { source, bindings, coverage }
}
