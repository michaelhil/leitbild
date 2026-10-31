import unitSource from '../pwr-full-unit-explorer.source.json'
import unitBindings from '../pwr-full-unit-explorer.bindings.json'
import unitCoverage from '../pwr-full-unit-explorer.coverage.json'
import campusSource from '../pwr-campus-explorer.source.json'
import campusBindings from '../pwr-campus-explorer.bindings.json'
import campusCoverage from '../pwr-campus-explorer.coverage.json'
import { architectureLayers, physicalSourceSchema, elementWorld, parameters, type Source, type Element, type V3 } from '../native/architecture/source.ts'
import { physicalStairFlights } from '../native/explorer/source.ts'

/** Authoring restoration from the retained browser study, not runtime drawing by plant ID.
 * Dimensions remain illustrative; no structural, access or lifting qualification is implied. */
export const createPwrArchitectureUnitArtifacts = () => {
  const source = physicalSourceSchema.parse(structuredClone(unitSource)), bindings = structuredClone(unitBindings), coverage = structuredClone(unitCoverage)
  for (const element of source.elements) if (element.kind === 'support') element.planDisplay = 'section'
  const hallId = 'building/turbine-hall', hallSpace = 'space/turbine-hall'
  source.layers = structuredClone(architectureLayers)
  source.viewAreas = [{ id: 'area/turbine-island', label: 'Turbine hall and feedwater pump annex', members: [hallId, 'building/feedwater-annex'], inspectionView: { bearing: 139.893, pitch: 57.914, target: [44.4, 24, 11.5] } }]
  for (const element of source.elements) if (element.kind === 'pipe') element.layerId = 'utility-routes'
  // Capture each enclosure's actual authored slabs/platforms. Global level
  // names shared across the site do not create floors in unrelated buildings.
  for (const building of source.elements.filter(element => element.kind === 'building')) {
    const floors = [...new Map(source.elements.filter(element => element.kind === 'slab' && element.buildingId === building.id).map(element => [element.levelId, { levelId: element.levelId, low: element.pose.position[2] + parameters(source, element).height }])).values()].sort((a, b) => a.low - b.low)
    const top = building.pose.position[2] + parameters(source, building).height
    building.inspectionLevels = floors.map((floor, index) => ({ ...floor, high: floors[index + 1]?.low ?? top }))
    for (const space of source.elements.filter(element => element.kind === 'space' && element.buildingId === building.id)) {
      const low = space.pose.position[2], high = low + parameters(source, space).height
      space.inspectionLevels = building.inspectionLevels.filter(volume => volume.high > low && volume.low < high).map(volume => ({ levelId: volume.levelId, low: Math.max(volume.low, low), high: Math.min(volume.high, high) }))
    }
  }
  const add = (element: Omit<Element, 'disposition' | 'buildingId'> & { buildingId?: string | undefined }): Element => {
    const authored: Element = { disposition: 'installed', buildingId: hallId, ...(element.kind === 'pipe' ? { layerId: 'utility-routes' } : {}), ...element }
    source.elements.push(authored); return authored
  }
  const box = (id: string, label: string, position: V3, size: V3, material: Element['material'] = 'steel', levelId = 'operating', extra: Partial<Element> = {}): Element => add({ id, label, kind: 'support', levelId, pose: { position, yaw: 0 }, dimensions: { length: size[0], width: size[1], height: size[2] }, material, planDisplay: 'section', ...extra })
  const tube = (id: string, label: string, points: V3[], radius: number, material: Element['material'] = 'steel', extra: Partial<Element> = {}): Element => {
    const min = [0, 1, 2].map(axis => Math.min(...points.map(point => point[axis]!))) as V3, max = [0, 1, 2].map(axis => Math.max(...points.map(point => point[axis]!))) as V3
    return box(id, label, min, max.map((value, axis) => Math.max(radius * 2, value - min[axis]!)) as V3, material, 'operating', { member: { kind: 'tube', points: points.map(point => point.map((value, axis) => value - min[axis]!) as V3), radius }, planDisplay: 'projection', ...extra })
  }
  const bindTurbine = (element: Element): void => {
    element.planDisplay = 'projection'
    bindings.push({ physicalElementId: element.id, elementId: 'turbine', relation: 'partOf' })
    coverage.dispositions.find(disposition => disposition.subjectId === 'turbine')!.physicalElementIds.push(element.id)
  }
  const guard = (id: string, points: V3[], levelId = 'operating'): void => {
    const min = [0, 1, 2].map(axis => Math.min(...points.map(point => point[axis]!))) as V3, max = [0, 1, 2].map(axis => Math.max(...points.map(point => point[axis]!))) as V3
    box(id, 'Stair opening and landing guardrail, illustrative', min, [Math.max(.07, max[0] - min[0]), Math.max(.07, max[1] - min[1]), max[2] - min[2] + 1.1], 'crane', levelId,
      { member: { kind: 'guardrail', points: points.map(point => point.map((value, axis) => value - min[axis]!) as V3), height: 1.1, postSpacing: 1.6, railRadius: .035, postRadius: .025 }, dependsOn: ['stair/main'] })
  }
  // The old bootstrap discarded I sections and kept their rectangular envelopes.
  for (const element of [...source.elements]) {
    if (element.id.startsWith('column/')) {
      element.member = { kind: 'i-section', axis: 'z', flange: .12, web: .12 }; element.material = 'steel'
      const [x, y] = element.pose.position
      box(`structure/base/${element.id}`, 'Structural column base plate', [x - .1, y - .1, 0], [1, 1, .16], 'dark', 'lower')
      box(`structure/operating-plate/${element.id}`, 'Illustrative operating-deck column connection plate', [x - .1, y - .1, 15], [1, 1, .16], 'dark', 'operating')
    }
    if (element.id.startsWith('pier/')) element.material = 'plinth'
  }
  for (const y of [2.5, 34.2]) {
    const boundary = { outward: [0, y < 18.4 ? -1 : 1, 0] as V3 & [number, number, 0] }
    box(`structure/runway/${y}`, 'Overhead crane runway beam', [.4, y - .16, 27.5], [88, .32, .8], 'steel', 'operating', { member: { kind: 'i-section', axis: 'x', flange: .10, web: .08 }, inspectionBoundary: boundary })
    box(`structure/runway-rail/${y}`, 'Overhead crane runway rail', [.4, y - .07, 28.3], [88, .14, .1], 'dark', 'operating', { inspectionBoundary: boundary })
  }
  for (let bay = 0; bay < 9; bay++) box(`structure/roof-beam/${bay}`, 'Turbine hall transverse roof beam', [bay * 11 + .24, .4, 30.4], [.32, 36, .8], 'steel', 'refuelling', { member: { kind: 'i-section', axis: 'y', flange: .10, web: .08 }, layerId: 'roof-structure' })
  const craneId = 'assembly/turbine-hall-crane'
  add({ id: craneId, label: 'Illustrative overhead bridge crane', kind: 'assembly', levelId: 'operating', pose: { position: [79.7, 2.5, 23.4], yaw: 0 }, dimensions: { length: 2.2, width: 31.7, height: 6.9 } })
  for (const x of [80, 81.1]) box(`structure/crane/bridge-${x}`, 'Bridge crane girder', [x, 2.5, 28.4], [.3, 31.7, 1.1], 'crane', 'operating', { assemblyId: craneId, member: { kind: 'i-section', axis: 'y', flange: .12, web: .08 } })
  box('structure/crane/trolley', 'Bridge crane trolley', [79.7, 17, 29.5], [2.2, 2.8, .8], 'dark', 'operating', { assemblyId: craneId })
  tube('structure/crane/hoist', 'Bridge crane hoist cable', [[80.7, 18.4, 29.5], [80.7, 18.4, 24]], .045, 'dark', { assemblyId: craneId, planDisplay: 'section' })
  tube('structure/crane/hook', 'Bridge crane hook block', [[80.7, 18.4, 24], [80.7, 18.4, 23.4]], .18, 'crane', { assemblyId: craneId, planDisplay: 'section' })
  bindTurbine(tube('structure/shaftline', 'Common turbine-generator shaft', [[8.3, 18.4, 17.2], [75.7, 18.4, 17.2]], .23, 'dark', { spaceIds: [hallSpace] }))
  for (const x of [8.6, 18.4, 30, 41, 52.6, 69, 75.7]) {
    bindTurbine(box(`structure/bearing/${x}/base`, 'Turbine-generator bearing pedestal base', [x - .6, 17.5, 15], [1.2, 1.8, .35], 'plinth'))
    bindTurbine(box(`structure/bearing/${x}/pedestal`, 'Turbine-generator bearing pedestal', [x - .4, 17.8, 15.35], [.8, 1.2, 1.5], 'dark'))
    bindTurbine(tube(`structure/bearing/${x}/housing`, 'Turbine-generator shaft bearing housing', [[x - .4, 18.4, 17.2], [x + .4, 18.4, 17.2]], .65, 'light'))
  }
  for (const condenser of source.elements.filter(element => element.equipmentKind === 'condenser')) {
    const d = parameters(source, condenser), [x, y] = condenser.pose.position
    bindTurbine(box(`structure/exhaust-transition/${condenser.id}`, 'LP exhaust transition through operating deck', [x + 1.3, y + 3.6, 14.6], [d.length - 2.6, d.width - 7.2, 1.1], 'hood', 'operating', { member: { kind: 'transition', topLength: d.length - 3.2, topWidth: d.width - 7.8 } }))
  }
  const stair = source.elements.find(element => element.id === 'stair/main')!, d = parameters(source, stair), [sx, sy] = stair.pose.position
  stair.stair = { landings: [0, 15], maxFlightRise: 2.5, maxRiser: .17, minTread: .275, flightWidth: 1.6, landingDepth: 1.6 }
  const flights = physicalStairFlights(d, stair.stair)
  for (const [index, flight] of flights.entries()) {
    const x = flight.forward ? sx + .15 : sx + d.length - .15 - stair.stair.flightWidth
    for (const [side, sideX] of [x + .06, x + stair.stair.flightWidth - .06].entries()) guard(`structure/stair/flight-${index}-${side}`, [[sideX, sy + (flight.forward ? stair.stair.landingDepth : d.width - stair.stair.landingDepth), flight.base], [sideX, sy + (flight.forward ? d.width - stair.stair.landingDepth : stair.stair.landingDepth), flight.base + flight.rise]], 'lower')
  }
  guard('structure/stair/upper-west', [[sx, sy, 15], [sx, sy + d.width, 15]])
  guard('structure/stair/upper-east', [[sx + d.length, sy, 15], [sx + d.length, sy + d.width, 15]])
  guard('structure/stair/upper-north', [[sx, sy, 15], [sx + d.length, sy, 15]])
  // Boundary normals are explicit authored representation facts in source XY.
  // Internal partitions and curved containment shells keep ordinary section behaviour.
  for (const wall of source.elements.filter(element => element.kind === 'wall' && element.buildingId && !element.shape && (element.id.startsWith(`${element.buildingId}/`) || /^wall\/(hall|annex|containment\/facet|vestibule\/)/.test(element.id)))) {
    const dim = parameters(source, wall), pose = wall.pose, c = Math.cos(pose.yaw), s = Math.sin(pose.yaw)
    const building = source.elements.find(element => element.id === wall.buildingId)!, size = parameters(source, building)
    const bc = Math.cos(building.pose.yaw), bs = Math.sin(building.pose.yaw), centre = [building.pose.position[0] + bc * size.length / 2 - bs * size.width / 2, building.pose.position[1] + bs * size.length / 2 + bc * size.width / 2]
    const middle: V3 = [pose.position[0] + c * dim.length / 2, pose.position[1] + s * dim.length / 2, 0]
    const normal: [number, number, 0] = [-s, c, 0], dot = normal[0] * (middle[0] - centre[0]!) + normal[1] * (middle[1] - centre[1]!)
    wall.inspectionBoundary = { outward: dot >= 0 ? normal : [-normal[0], -normal[1], 0] }
  }
  for (const opening of [...source.elements].filter(element => element.kind === 'opening' && element.label.startsWith('W-'))) {
    const pose = elementWorld(source, opening), dims = parameters(source, opening), host = source.elements.find(element => element.id === opening.hostId)!, frameId = `structure/glazing/${opening.id}`
    const localBox = (suffix: string, position: V3, size: V3, material: Element['material']): void => {
      const c = Math.cos(pose.yaw), s = Math.sin(pose.yaw)
      box(`${frameId}/${suffix}`, 'Clerestory glazing frame and mullions', [pose.position[0] + c * position[0] - s * position[1], pose.position[1] + s * position[0] + c * position[1], pose.position[2] + position[2]], size, material, opening.levelId,
        { pose: { position: [pose.position[0] + c * position[0] - s * position[1], pose.position[1] + s * position[0] + c * position[1], pose.position[2] + position[2]], yaw: pose.yaw }, buildingId: host.buildingId ?? hallId, ...(host.inspectionBoundary ? { inspectionBoundary: host.inspectionBoundary } : {}), dependsOn: [opening.id] })
    }
    localBox('sill', [0, dims.width / 2 - .05, 0], [dims.length, .1, .08], 'steel')
    localBox('head', [0, dims.width / 2 - .05, dims.height - .08], [dims.length, .1, .08], 'steel')
    const bays = Math.ceil(dims.length / 1.4), bayWidth = dims.length / bays
    for (let index = 0; index <= bays; index++) localBox(`mullion-${index}`, [Math.min(index * bayWidth, dims.length - .07), dims.width / 2 - .05, .08], [.07, .1, dims.height - .16], 'steel')
    // This illustrative LOD captures the opening and its frames. The accepted
    // reference did not model panes; opaque pane solids incorrectly close the
    // clear clerestory in the current material pass.
  }
  // Restore the original illustrative reheated-steam header/branches. All map
  // to the existing lumped turbine; no component or live state is fabricated.
  for (const y of [10.4, 26.6]) {
    const route = (id: string, points: V3[], diameter: number): void => {
      const element = add({ id, label: 'Illustrative turbine reheat steam distribution', kind: 'pipe', levelId: 'operating', pose: { position: [0, 0, 0], yaw: 0 }, dimensions: { length: 1, width: diameter, height: diameter }, path: points, material: 'steam', spaceIds: [hallSpace] })
      bindTurbine(element)
    }
    route(`route/turbine-reheat-${y}`, [[15.7, y, 23], [46.5, y, 23]], .84)
    for (const x of [24.5, 35.5, 46.5]) route(`route/turbine-admission-${x}-${y}`, [[x, y, 23], [x, y < 18.4 ? 12.8 : 24, 23], [x, y < 18.4 ? 12.8 : 24, 19.6]], .64)
  }
  source.elements.find(element => element.id === 'hatch-cover')!.surfaceJoints = { axis: 'length', offsets: [2, 4, 6] }
  source.planAnnotations = createAnnotations(source)
  const bound = new Set(bindings.map(binding => binding.physicalElementId)), oldReasons = new Map(coverage.contextElements.map(element => [element.physicalElementId, element.reason]))
  coverage.contextElements = source.elements.filter(element => !bound.has(element.id)).map(element => ({ physicalElementId: element.id, reason: oldReasons.get(element.id) ?? 'Illustrative authored architecture, structural framing, glazing, crane or stair protection restored from the retained browser study. It has no separate operational state or qualified load/access claim.' }))
  return { source: physicalSourceSchema.parse(source), bindings, coverage }
}

const createAnnotations = (source: Source): NonNullable<Source['planAnnotations']> => {
  const annotations: NonNullable<Source['planAnnotations']> = []
  // Authored drawing designations from the accepted conventional-island study.
  // These label physical parts; they do not create graph aliases or I&C tags.
  const designations: Readonly<Record<string, string>> = { 'tg-hp': 'HP', 'tg-lp-1': 'LP 1', 'tg-lp-2': 'LP 2', 'tg-lp-3': 'LP 3', 'tg-generator': 'GEN', 'tg-exciter': 'EXC', 'msr-1': 'MSR 1', 'msr-2': 'MSR 2', 'stop-valve': 'TSV', 'condenser-1': 'COND 1', 'condenser-2': 'COND 2', 'condenser-3': 'COND 3', 'cp-a': 'CP A', 'cp-b': 'CP B', 'mfw-a': 'MFW A', 'mfw-b': 'MFW B' }
  const membership = (element: Element) => ({ levelIds: element.inspectionLevels?.map(value => value.levelId) ?? [element.levelId], scopeIds: [source.rootScope.id, ...(element.buildingId ? [element.buildingId] : []), ...(element.kind === 'space' ? [element.id] : element.spaceIds ?? [])] })
  for (const element of source.elements.filter(element => element.kind === 'space' || element.kind === 'equipment')) {
    const d = parameters(source, element), room = element.kind === 'space'
    annotations.push({ id: `annotation/label/${element.id}`, kind: 'label', role: room ? 'space' : 'equipment', ...membership(element), ...(room ? {} : { occurrenceId: element.id }), ...(designations[element.id] ? { text: designations[element.id] } : {}), layerId: 'plan-labels', anchor: { elementId: element.id, local: [d.length / 2, room ? d.width * .15 : d.width / 2, room ? 0 : d.height] }, rotation: element.pose.yaw * 180 / Math.PI })
    if (room) for (const axis of ['length', 'width'] as const) annotations.push({ id: `annotation/dimension/${element.id}/${axis}`, kind: 'dimension', ...membership(element), layerId: 'plan-dimensions', measure: { elementId: element.id, axis, start: [0, 0, 0] }, offset: axis === 'length' ? [0, -1, 0] : [-1, 0, 0], unit: 'm' })
  }
  const hatch = (id: string, label: string, role: 'laydown' | 'withdrawal', x: number, y: number, length: number, width: number, levelId: string): void => {
    const z = source.levels.find(level => level.id === levelId)!.elevation
    annotations.push({ id, kind: 'hatch', levelIds: [levelId], scopeIds: [source.rootScope.id, 'building/turbine-hall', 'space/turbine-hall'], layerId: 'plan-allowances', role, label, basis: 'illustrative', outline: [[x, y, z], [x + length, y, z], [x + length, y + width, z], [x, y + width, z], [x, y, z]] })
  }
  hatch('annotation/laydown', 'Illustrative rotor laydown allowance', 'laydown', 20, 3.6, 32, 6.4, 'operating')
  hatch('annotation/withdrawal', 'Illustrative generator withdrawal allowance', 'withdrawal', 68, 14.2, 18.5, 8.4, 'operating')
  const cover = source.elements.find(element => element.id === 'hatch-cover')!, d = parameters(source, cover), [x, y] = cover.pose.position
  annotations.push({ id: 'annotation/hatch-cover', kind: 'hatch', role: 'laydown', levelIds: ['operating'], scopeIds: [source.rootScope.id, 'building/turbine-hall'], occurrenceId: cover.id, layerId: 'plan-labels', label: 'REMOVABLE EQUIPMENT HATCH', basis: 'illustrative', outline: [[x, y, 15], [x + d.length, y, 15], [x + d.length, y + d.width, 15], [x, y + d.width, 15], [x, y, 15]] })
  return annotations
}

export const createPwrArchitectureCampusArtifacts = () => {
  const source = physicalSourceSchema.parse(structuredClone(campusSource))
  source.layers = structuredClone(architectureLayers)
  source.planAnnotations = source.elements.filter(element => element.kind === 'building').map(element => ({ id: `annotation/label/${element.id}`, kind: 'label', role: 'space', levelIds: ['site'], scopeIds: [source.rootScope.id, element.id], layerId: 'plan-labels', text: element.label, anchor: { elementId: element.id, local: [parameters(source, element).length / 2, parameters(source, element).width / 2, 0] }, rotation: element.pose.yaw * 180 / Math.PI }))
  return { source: physicalSourceSchema.parse(source), bindings: structuredClone(campusBindings), coverage: structuredClone(campusCoverage) }
}
