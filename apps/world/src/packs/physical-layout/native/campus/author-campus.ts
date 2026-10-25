import { z } from 'zod'
import { MercatorCoordinate } from 'maplibre-gl'
import { physicalSourceSchema, type Element, type Source, type V3 } from './source.ts'

const id = z.string().min(1).max(200), point = z.tuple([z.number().finite(), z.number().finite()]), vector = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()])
const anchor = z.tuple([z.number().finite().min(-180).max(180), z.number().finite().min(-85).max(85)])
const positive = z.number().finite().positive()
export const campusArrangementSchema = z.object({
  id, title: z.string().min(1).max(300), siteAnchor: anchor,
  modelRequirement: z.object({ modelRef: id, modelDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  unitTerminal: vector,
  unitServiceSetback: positive,
  units: z.array(z.object({ role: id, label: id, anchor, subjectId: id, bayX: z.number().finite() }).strict()).min(1).max(16),
  buildings: z.array(z.object({ id, label: z.string().min(1).max(300), position: point, length: positive, width: positive, storeys: z.number().int().min(1).max(2), storeyHeight: positive, roomWidths: z.array(positive).min(1).max(32) }).strict()).min(1).max(100),
  parking: z.object({ position: point, columns: z.number().int().min(1).max(200), rows: z.number().int().min(1).max(20), bayWidth: positive, bayLength: positive, aisle: positive }).strict(),
  switchyard: z.object({
    busSubjectId: id, position: point, length: positive, width: positive,
    firstSupports: z.array(z.object({ id, label: z.string().min(1).max(300), position: point, length: positive, width: positive, height: positive }).strict()).min(1).max(50),
    circuits: z.array(z.object({ id, label: id, subjectId: id, bayX: z.number().finite(), supportId: id, side: z.enum(['left', 'right']) }).strict()).min(1).max(100),
  }).strict(),
  roadPaths: z.array(z.array(vector).min(2).max(100)).max(100), siteBoundary: z.array(vector).min(4).max(500),
  entrance: z.object({ position: point, width: positive }).strict(),
  evidence: z.object({ accuracy: z.literal('illustrative'), origin: z.string().min(1).max(1000) }).strict(),
  references: z.array(z.url()).max(30),
}).strict().superRefine((value, context) => {
  const issue = (message: string): void => context.addIssue({ code: 'custom', message })
  const supports = new Set(value.switchyard.firstSupports.map(support => support.id))
  if (new Set(value.switchyard.circuits.map(circuit => circuit.subjectId)).size !== value.switchyard.circuits.length) issue('Each authored circuit needs a unique graph subject')
  for (const circuit of value.switchyard.circuits) if (!supports.has(circuit.supportId)) issue(`Unknown first support: ${circuit.id}`)
  for (const building of value.buildings) if (building.roomWidths.reduce((sum, width) => sum + width, 0) > building.length - 2) issue(`Rooms exceed the authored building: ${building.id}`)
  if (JSON.stringify(value.siteBoundary[0]) !== JSON.stringify(value.siteBoundary.at(-1))) issue('Site boundary must close explicitly')
  const lastSideStart = value.siteBoundary.at(-2)!, lastSideEnd = value.siteBoundary.at(-1)!
  if (lastSideStart[0] !== lastSideEnd[0] || value.entrance.position[0] !== lastSideStart[0] || value.entrance.position[1] - value.entrance.width / 2 <= Math.min(lastSideStart[1], lastSideEnd[1]) || value.entrance.position[1] + value.entrance.width / 2 >= Math.max(lastSideStart[1], lastSideEnd[1])) issue('Campus entrance must fit within the last vertical boundary segment')
})
export type CampusArrangement = z.infer<typeof campusArrangementSchema>
type Correspondence = { physicalElementId: string; elementId: string; relation: 'represents' | 'partOf' }

/** Same public geographic projection used by the map, applied only while authoring accepted source. */
export const geographicOffset = (origin: readonly [number, number], target: readonly [number, number]): [number, number] => {
  const from = MercatorCoordinate.fromLngLat([origin[0], origin[1]], 0), to = MercatorCoordinate.fromLngLat([target[0], target[1]], 0), scale = from.meterInMercatorCoordinateUnits()
  return [(to.x - from.x) / scale, -(to.y - from.y) / scale]
}
export const localPointAtAnchor = (origin: readonly [number, number], target: readonly [number, number], local: readonly [number, number, number]): V3 => {
  const offset = geographicOffset(origin, target), from = MercatorCoordinate.fromLngLat([origin[0], origin[1]], 0), to = MercatorCoordinate.fromLngLat([target[0], target[1]], 0), ratio = to.meterInMercatorCoordinateUnits() / from.meterInMercatorCoordinateUnits()
  return [offset[0] + local[0] * ratio, offset[1] + local[1] * ratio, local[2] * ratio]
}
const round = (value: number): number => Math.round(value * 1_000_000) / 1_000_000
const element = (id: string, label: string, kind: Element['kind'], position: V3, dimensions: NonNullable<Element['dimensions']>, extra: Partial<Element> = {}): Element => ({ id, label, kind, levelId: 'site', pose: { position, yaw: 0 }, dimensions, disposition: 'installed', ...extra })
const dims = (length: number, width: number, height: number) => ({ length, width, height })

export const composeCampus = (input: unknown) => {
  const arrangement = campusArrangementSchema.parse(input), elements: Element[] = [], bindings: Correspondence[] = []
  const append = (value: Element, subject?: string): void => { elements.push(value); if (subject) bindings.push({ physicalElementId: value.id, elementId: subject, relation: 'partOf' }) }
  const types: Source['types'] = [
    { id: 'yard/breaker', kind: 'breaker', parameters: dims(15, 8, 7) },
    { id: 'yard/disconnector', kind: 'disconnector', parameters: dims(15, 8, 6) },
    { id: 'yard/cabinet', kind: 'cabinet', parameters: dims(4, 1.2, 2.6) },
    { id: 'yard/bus-support', kind: 'bus-support', parameters: dims(1.2, 1.2, 12) },
  ]
  const equipment = (id: string, label: string, typeId: string, position: V3, subject?: string, extra: Partial<Element> = {}): void => {
    const type = types.find(type => type.id === typeId)
    if (!type) throw new Error(`Unknown authoring equipment type: ${typeId}`)
    append({ id, label, kind: 'equipment', levelId: 'site', typeId, equipmentKind: type.kind, pose: { position, yaw: 0 }, disposition: 'installed', ...extra }, subject)
  }
  const line = (id: string, label: string, path: V3[], width: number, kind: 'road' | 'fence' | 'conductor', subject?: string, extra: Partial<Element> = {}): void => {
    append(element(id, label, kind, [0, 0, 0], dims(1, width, kind === 'fence' ? 2.4 : .04), { path, ...extra }), subject)
  }

  for (const building of arrangement.buildings) {
    const [x, y] = building.position, totalHeight = building.storeys * building.storeyHeight
    append(element(`building/${building.id}`, building.label, 'building', [x, y, 0], dims(building.length, building.width, totalHeight + .3)))
    for (let floor = 0; floor < building.storeys; floor++) {
      const z = floor * building.storeyHeight, prefix = `${building.id}/${floor}`, levelId = floor === 0 ? 'campus-ground' : 'admin-upper', buildingId = `building/${building.id}`
      const common = { levelId, buildingId }
      append(element(`${prefix}/floor`, `${building.label} floor`, 'slab', [x, y, z - .2], dims(building.length, building.width, .2), { ...common, ...(floor > 0 ? { holes: [{ x: building.length - 6, y: building.width - 9, length: 4.6, width: 7.8 }] } : {}) }))
      const walls = [
        { suffix: 'south', position: [x, y, z] as V3, length: building.length, yaw: 0 },
        { suffix: 'north', position: [x, y + building.width, z] as V3, length: building.length, yaw: 0 },
        { suffix: 'west', position: [x, y, z] as V3, length: building.width, yaw: Math.PI / 2 },
        { suffix: 'east', position: [x + building.length, y, z] as V3, length: building.width, yaw: Math.PI / 2 },
      ]
      for (const wall of walls) {
        const wallId = `${prefix}/wall-${wall.suffix}`
        append(element(wallId, `${building.label} ${wall.suffix} wall`, 'wall', wall.position, dims(wall.length, .28, building.storeyHeight), { ...common, pose: { position: wall.position, yaw: wall.yaw } }))
        if (wall.suffix === 'south' && floor === 0) {
          const openingId = `${prefix}/entry`
          append(element(openingId, `${building.label} entry opening`, 'opening', [3, 0, 0], dims(1.8, .3, 2.4), { ...common, hostId: wallId }))
          append(element(`${prefix}/entry-door`, `${building.label} entry door`, 'door', [0, 0, 0], dims(1.8, .06, 2.3), { ...common, fillsId: openingId, pose: { position: [x + 3, y, z], yaw: Math.PI / 2 }, door: { swing: -Math.PI / 2 } }))
        }
        for (let window = 8; window < wall.length - 2; window += 6) {
          const openingId = `${prefix}/${wall.suffix}-window-${window}`
          append(element(openingId, `${building.label} window opening`, 'opening', [window, 0, 1.1], dims(2.4, .3, 1.5), { ...common, hostId: wallId }))
          append(element(`${openingId}/glass`, `${building.label} window glazing`, 'context', [wall.position[0] + Math.cos(wall.yaw) * window, wall.position[1] + Math.sin(wall.yaw) * window, z + 1.1], dims(2.4, .04, 1.5), { ...common, material: 'glass', pose: { position: [wall.position[0] + Math.cos(wall.yaw) * window, wall.position[1] + Math.sin(wall.yaw) * window, z + 1.1], yaw: wall.yaw } }))
        }
      }
      const corridorY = building.width / 2 - 1.5
      append(element(`${prefix}/corridor-wall-south`, `${building.label} corridor wall`, 'wall', [x + 1, y + corridorY, z], dims(building.length - 2, .18, building.storeyHeight), common))
      append(element(`${prefix}/corridor-wall-north`, `${building.label} corridor wall`, 'wall', [x + 1, y + corridorY + 3, z], dims(building.length - 2, .18, building.storeyHeight), common))
      let roomX = 1
      for (let room = 0; room < building.roomWidths.length; room++) {
        const width = building.roomWidths[room]!, roomPrefix = `${prefix}/room-${room}`
        for (const side of ['south', 'north'] as const) {
          const roomY = side === 'south' ? .3 : corridorY + 3.2, depth = side === 'south' ? corridorY - .5 : building.width - roomY - .3
          append(element(`${roomPrefix}-${side}`, `${building.label} ${side} room ${room + 1}`, 'space', [x + roomX, y + roomY, z], dims(width - .2, depth, building.storeyHeight), common))
          if (room > 0) append(element(`${roomPrefix}-${side}-partition`, `${building.label} room partition`, 'wall', [x + roomX, y + roomY, z], dims(depth, .18, building.storeyHeight), { ...common, pose: { position: [x + roomX, y + roomY, z], yaw: Math.PI / 2 } }))
          const hostId = `${prefix}/corridor-wall-${side}`, openingId = `${roomPrefix}-${side}-opening`, openingX = roomX + Math.min(2, width / 3) - 1
          append(element(openingId, `${building.label} room door opening`, 'opening', [openingX, 0, 0], dims(1.2, .2, 2.2), { ...common, hostId }))
          append(element(`${roomPrefix}-${side}-door`, `${building.label} room door`, 'door', [0, 0, 0], dims(1.2, .06, 2.15), { ...common, fillsId: openingId, pose: { position: [x + 1 + openingX, y + corridorY + (side === 'south' ? 0 : 3), z], yaw: side === 'south' ? -Math.PI / 2 : Math.PI / 2 }, door: { swing: Math.PI / 2 } }))
        }
        roomX += width
      }
      if (floor === 0 && building.storeys > 1) append(element(`${prefix}/stair`, `${building.label} internal stair`, 'stair', [x + building.length - 6, y + building.width - 9, z], dims(4.6, 7.8, building.storeyHeight), { ...common,
        stair: { landings: [0, building.storeyHeight], maxFlightRise: 2, maxRiser: .175, minTread: .28, flightWidth: 1.4, landingDepth: 1.5 },
      }))
    }
    append(element(`${building.id}/roof`, `${building.label} roof`, 'roof', [x, y, totalHeight], dims(building.length, building.width, .3), { levelId: 'campus-ground', buildingId: `building/${building.id}` }))
  }

  const parking = arrangement.parking, [px, py] = parking.position, parkingWidth = parking.columns * parking.bayWidth
  const parkingDepth = parking.rows * parking.bayLength + Math.ceil(parking.rows / 2) * parking.aisle
  append(element('parking/pavement', 'Staff and visitor car park', 'context', [px - 1, py - 1, -.08], dims(parkingWidth + 2, parkingDepth + 2, .08)))
  for (let row = 0; row < parking.rows; row++) {
    const y = py + row * parking.bayLength + Math.floor(row / 2) * parking.aisle
    for (let column = 0; column <= parking.columns; column++) append(element(`parking/line-${row}-${column}`, 'Marked parking bay', 'context', [px + column * parking.bayWidth, y, .012], dims(.08, parking.bayLength, .018), { material: 'line' }))
    append(element(`parking/row-${row}-end`, 'Parking row end marking', 'context', [px, y, .012], dims(parkingWidth, .08, .018), { material: 'line' }))
  }
  append(element('parking/pedestrian-strip', 'Pedestrian route to reception', 'context', [px - 6, py, .025], dims(3, parkingDepth + 40, .08), { material: 'floor' }))
  for (let path = 0; path < arrangement.roadPaths.length; path++) line(`road/common-${path}`, 'Shared campus access road', arrangement.roadPaths[path]!, 8, 'road')

  const units = arrangement.units.map(unit => ({ ...unit, local: geographicOffset(arrangement.siteAnchor, unit.anchor).map(round) as [number, number] }))
  line('road/unit-spine', 'Plant service road connecting all four unit compounds', units.map(unit => [unit.local[0], unit.local[1] - arrangement.unitServiceSetback, .04]), 9, 'road')
  for (const unit of units) {
    const [x, y] = unit.local
    line(`road/${unit.role}`, `${unit.label} service entry road`, [[x, y - arrangement.unitServiceSetback, .04], [x + 175, y - arrangement.unitServiceSetback, .04], [x + 175, y + 110, .04], [x + 50, y + 110, .04]], 7, 'road')
    // The corridor is a conceptual electrical route, not a claim of qualified 420 kV cable construction.
    for (let phase = 0; phase < 3; phase++) {
      const shift = (phase - 1) * .35, [tx, ty, tz] = localPointAtAnchor(arrangement.siteAnchor, unit.anchor, arrangement.unitTerminal)
      line(`conductor/${unit.role}-phase-${phase + 1}`, `${unit.label} 420 kV unit connection phase ${phase + 1}`, [[unit.bayX + (phase - 1) * 5, -100, 18], [unit.bayX + shift, -125, .4], [-165 + shift, -125, .4], [-165 + shift, 145, .4], [x + 175 + shift, y - arrangement.unitServiceSetback, .4], [x + 175 + shift, y + 24, .4], [round(tx), round(ty + shift), round(tz)]], .12, 'conductor', unit.subjectId, { terminatesBeyond: false, installation: 'cable-corridor' })
    }
  }
  const [gateX, gateY] = arrangement.entrance.position, halfGate = arrangement.entrance.width / 2
  line('fence/campus', 'Conceptual plant campus perimeter fence', [...arrangement.siteBoundary.slice(0, -1), [gateX, gateY + halfGate, 0]], .12, 'fence')
  line('fence/campus-entrance-return', 'Perimeter fence beside the vehicle entrance', [[gateX, gateY - halfGate, 0], arrangement.siteBoundary[0]!], .12, 'fence')
  for (const offset of [-halfGate, halfGate]) append(element(`gate/post-${offset}`, 'Site entrance gatepost', 'support', [gateX - .15, gateY + offset - .15, 0], dims(.3, .3, 3)))

  const yard = arrangement.switchyard, [yx, yy] = yard.position
  append(element('yard/gravel', '420 kV switchyard equipment yard', 'context', [yx, yy, -.06], dims(yard.length, yard.width, .06)))
  line('fence/switchyard', 'Switchyard perimeter fence', [[yx, yy, 0], [yx + yard.length, yy, 0], [yx + yard.length, yy + yard.width, 0], [yx, yy + yard.width, 0], [yx, yy, 0]], .1, 'fence')
  line('road/yard', 'Switchyard maintenance lane', [[yx + 5, -10, .04], [yx + yard.length - 5, -10, .04]], 5, 'road')
  for (const row of [-20, 20]) for (let phase = 0; phase < 3; phase++) {
    const y = row + (phase - 1) * 5
    line(`yard/bus-${row}-${phase + 1}`, `420 kV common busbar phase ${phase + 1}`, [[-135, y, 12], [135, y, 12]], .2, 'conductor', yard.busSubjectId, { installation: 'busbar' })
    for (const x of [-130, -65, 0, 65, 130]) equipment(`yard/bus-support-${row}-${phase}-${x}`, 'Insulated busbar support pedestal', 'yard/bus-support', [x - .6, y - .6, 0])
  }
  const bay = (id: string, label: string, x: number, north: boolean, subject: string): void => {
    const direction = north ? 1 : -1
    equipment(`yard/${id}/breaker`, `${label} circuit-breaker assembly`, 'yard/breaker', [x - 7.5, direction * 52 - 4, 0], subject)
    equipment(`yard/${id}/disconnector`, `${label} disconnector assembly`, 'yard/disconnector', [x - 7.5, direction * 77 - 4, 0], subject)
    for (let phase = 0; phase < 3; phase++) {
      const phaseX = x + (phase - 1) * 5, busY = direction * 20 + (phase - 1) * 5, takeoff = 24 + phase * 5
      line(`yard/${id}/phase-${phase + 1}`, `${label} bay conductor phase ${phase + 1}`, [[phaseX, busY, 12], [phaseX, busY, takeoff], [phaseX, direction * 35, takeoff], [phaseX, direction * 52, 6], [phaseX, direction * 77, 6], [phaseX, direction * 100, 18]], .14, 'conductor', subject, { installation: 'overhead' })
    }
    for (const dx of [-10, 10]) append(element(`yard/${id}/portal-${dx}`, `${label} terminal portal column`, 'support', [x + dx - .25, direction * 100, 0], dims(.5, .5, 20)))
    append(element(`yard/${id}/portal-top`, `${label} terminal portal crossbeam`, 'support', [x - 10, direction * 100, 19.5], dims(20.5, .5, .5)))
  }
  for (const unit of units) bay(unit.role, `${unit.label} connection bay`, unit.bayX, false, unit.subjectId)
  for (const circuit of yard.circuits) bay(circuit.id, circuit.label, circuit.bayX, true, circuit.subjectId)
  for (const support of yard.firstSupports) {
    const typeId = `yard/support-type-${support.id}`
    types.push({ id: typeId, kind: 'pylon', parameters: dims(support.length, support.width, support.height) })
    equipment(`pylon/${support.id}`, support.label, typeId, [support.position[0], support.position[1], 0])
  }
  for (const circuit of yard.circuits) {
    const support = yard.firstSupports.find(support => support.id === circuit.supportId)!
    for (let phase = 0; phase < 3; phase++) {
      const start: V3 = [circuit.bayX + (phase - 1) * 5, 100, 18]
      const end: V3 = [support.position[0] + support.length * (circuit.side === 'left' ? .03 : .97), support.position[1] + support.width / 2, support.height * ([.46, .62, .77][phase]!)]
      const path = Array.from({ length: 13 }, (_, index): V3 => {
        const t = index / 12
        return [round(start[0] + (end[0] - start[0]) * t), round(start[1] + (end[1] - start[1]) * t), round(start[2] + (end[2] - start[2]) * t - 3.5 * 4 * t * (1 - t))]
      })
      line(`conductor/${circuit.id}-phase-${phase + 1}`, `${circuit.label} to first support, phase ${phase + 1}`, path, .08, 'conductor', circuit.subjectId, { supportIds: [`pylon/${support.id}`], terminatesBeyond: true, installation: 'overhead' })
    }
  }
  for (let index = 0; index < 4; index++) equipment(`yard/control-cabinet-${index}`, 'Switchyard local protection cabinet', 'yard/cabinet', [-186 + index * 5.2, -15, 0], undefined, { buildingId: 'building/yard-control', levelId: 'campus-ground' })

  const source = physicalSourceSchema.parse({ id: arrangement.id, title: arrangement.title, units: 'm', axes: 'Z-up', origin: [0, 0, 0], siteAnchor: arrangement.siteAnchor,
    levels: [{ id: 'campus-ground', label: 'Site buildings ground floor', elevation: 0, cutHeight: 1.2 }, { id: 'admin-upper', label: 'Administration first floor', elevation: 4, cutHeight: 1.2 }], types, elements, evidence: arrangement.evidence })
  const represented = [...new Set(bindings.map(binding => binding.elementId))].sort()
  const bound = new Set(bindings.map(binding => binding.physicalElementId))
  const coverage = {
    modelRequirement: arrangement.modelRequirement, scope: 'site-subset' as const,
    dispositions: represented.map(subjectId => ({ subjectId, disposition: 'assembly' as const, reason: subjectId === yard.busSubjectId ? 'The one graph bus is represented through its three-phase physical busbar assemblies.' : subjectId.startsWith('unit-') ? 'The graph unit connection point is represented through its yard bay and authored connection corridor; the unit-owned transformer remains in the unit design.' : 'The graph AC circuit is represented through its yard bay and three phase conductors through the first authored physical support.', physicalElementIds: bindings.filter(binding => binding.elementId === subjectId).map(binding => binding.physicalElementId) })),
    contextElements: source.elements.filter(element => !bound.has(element.id)).map(element => ({ physicalElementId: element.id, reason: element.kind === 'equipment' && element.equipmentKind === 'pylon' ? 'Authored physical support. Circuit membership is derived from conductor supportIds and correspondence; the support has no independent operational subject.' : 'Authored architectural or site context, without an invented process component or live state.' })),
    evidence: arrangement.evidence,
  }
  return { source, bindings, coverage }
}
