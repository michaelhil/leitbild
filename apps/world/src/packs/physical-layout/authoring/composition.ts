import type { Source, Element } from '../native/campus/source.ts'

type V3 = [number, number, number]
type Dimensions = { length: number; width: number; height: number }
export type Binding = { physicalElementId: string; elementId: string; relation: 'represents' | 'partOf' }
export type CoverageDisposition = { subjectId: string; disposition: 'direct' | 'assembly' | 'internal' | 'functional' | 'boundary' | 'unresolved'; reason: string; physicalElementIds: string[] }
export type ContextElement = { physicalElementId: string; reason: string }
type Kind = Element['kind']

export interface RoomSpec {
  id: string
  label: string
  levelId: string
  position: V3
  dimensions: Dimensions
}
export interface PartitionSpec {
  id: string
  levelId: string
  position: V3
  length: number
  yaw: number
  height: number
  doorAt?: number | undefined
  doorWidth?: number | undefined
}
export interface BuildingSpec {
  id: string
  label: string
  levelId: string
  position: V3
  dimensions: Dimensions
  footprint?: 'ellipse' | 'rectangle' | undefined
  floors: Array<{ levelId: string; elevation: number }>
  rooms: RoomSpec[]
  partitions: PartitionSpec[]
}
export interface EquipmentSpec {
  id: string
  label: string
  family: NonNullable<Element['equipmentKind']>
  levelId: string
  position: V3
  dimensions: Dimensions
  buildingId?: string | undefined
  spaceId?: string | undefined
  yaw?: number | undefined
  subjects: Array<{ id: string; relation: Binding['relation'] }>
  reason: string
}
export interface RouteSpec {
  id: string
  label: string
  levelId: string
  width: number
  path: V3[]
  buildingId?: string | undefined
  subjectId?: string | undefined
  reason: string
}

/** Offline authoring helpers. Output is retained native source, never Run state or physics. */
export const createPhysicalComposition = (initial: Source, initialBindings: readonly Binding[]) => {
  const source = structuredClone(initial)
  const bindings = structuredClone([...initialBindings])
  const reasons = new Map<string, string>()
  const add = (element: Element, reason: string): Element => {
    if (source.elements.some(candidate => candidate.id === element.id)) throw new Error(`Duplicate authored identity: ${element.id}`)
    source.elements.push(element); reasons.set(element.id, reason)
    return element
  }
  const element = (id: string, label: string, kind: Kind, levelId: string, position: V3, dimensions: Dimensions, extra: Partial<Element> = {}): Element => ({
    id, label, kind, levelId, pose: { position, yaw: 0 }, dimensions, disposition: 'installed', ...extra,
  })
  const wall = (id: string, label: string, levelId: string, position: V3, length: number, height: number, yaw: number, buildingId: string, doorAt?: number, doorWidth = 1.4): void => {
    const thickness = 0.25
    add(element(id, label, 'wall', levelId, position, { length, width: thickness, height }, { pose: { position, yaw }, buildingId }), 'Authored architectural enclosure or partition, not an operational component.')
    if (doorAt === undefined) return
    const openingId = `${id}/opening`, width = Math.min(doorWidth, length - doorAt)
    add(element(openingId, `${label} access opening`, 'opening', levelId, [doorAt, 0, 0], { length: width, width: thickness, height: Math.min(2.7, height) }, { hostId: id, buildingId }), 'A hosted civil access opening; no live state is inferred.')
    const c = Math.cos(yaw), s = Math.sin(yaw)
    const doorPosition: V3 = [position[0] + c * doorAt - s * thickness, position[1] + s * doorAt + c * thickness, position[2]]
    add(element(`${id}/door`, `${label} access door`, 'door', levelId, doorPosition, { length: width, width: 0.07, height: Math.min(2.7, height) }, {
      fillsId: openingId, buildingId, pose: { position: doorPosition, yaw }, door: { swing: Math.PI / 2 },
    }), 'Illustrative architectural door and swing; no door actuator is present in the operational graph.')
  }
  const building = (spec: BuildingSpec): void => {
    const { id, label, levelId, position, dimensions: d } = spec
    add(element(id, label, 'building', levelId, position, d, { footprint: spec.footprint ?? 'rectangle' }), 'Physical building container; operational components bind to installed equipment rather than the building identity.')
    if (spec.footprint === 'ellipse') {
      add(element(`${id}/shell`, `${label} concrete shell`, 'wall', levelId, position, { ...d, height: d.height - 12 }, { buildingId: id, shape: { kind: 'cylindrical-shell', thickness: 1.1 } }), 'Illustrative containment enclosure; civil dimensions are authored, not recovered from the process graph.')
      add(element(`${id}/roof`, `${label} dome`, 'roof', levelId, [position[0], position[1], position[2] + d.height - 12], { ...d, height: 12 }, { buildingId: id, shape: { kind: 'dome-shell', thickness: 0.8 } }), 'Illustrative containment dome, shown when cutaway is disabled.')
    } else {
      wall(`${id}/south`, `${label} south wall`, levelId, position, d.length, d.height, 0, id, 3, 2.4)
      wall(`${id}/east`, `${label} east wall`, levelId, [position[0] + d.length, position[1], position[2]], d.width, d.height, Math.PI / 2, id, Math.max(3, d.width / 2), 2.4)
      wall(`${id}/north`, `${label} north wall`, levelId, [position[0], position[1] + d.width, position[2]], d.length, d.height, 0, id, Math.max(3, d.length / 2), 2.4)
      wall(`${id}/west`, `${label} west wall`, levelId, position, d.width, d.height, Math.PI / 2, id, 3, 1.4)
      add(element(`${id}/roof`, `${label} roof`, 'roof', levelId, [position[0], position[1], position[2] + d.height], { ...d, height: 0.3 }, { buildingId: id }), 'Authored roof, omitted by the cutaway view.')
    }
    for (const floor of spec.floors) add(element(`${id}/floor/${floor.levelId}`, `${label} ${floor.levelId} floor`, 'slab', floor.levelId, [position[0], position[1], floor.elevation - 0.35], { length: d.length, width: d.width, height: 0.35 }, {
      buildingId: id, ...(spec.footprint === 'ellipse' ? { shape: { kind: 'elliptical-plate' as const } } : {}),
    }), 'Civil floor slab. Floor elevations are local design datums, not surveyed site heights.')
    for (const room of spec.rooms) add(element(room.id, room.label, 'space', room.levelId, room.position, room.dimensions, { buildingId: id }), 'Architectural room or corridor. Room membership does not create an operational asset.')
    for (const partition of spec.partitions) wall(partition.id, `${label} room partition`, partition.levelId, partition.position, partition.length, partition.height, partition.yaw, id, partition.doorAt, partition.doorWidth)
  }
  const equipment = (spec: EquipmentSpec): void => {
    const typeId = `type/campus/${spec.family}/${spec.dimensions.length}x${spec.dimensions.width}x${spec.dimensions.height}`
    if (!source.types.some(type => type.id === typeId)) source.types.push({ id: typeId, kind: spec.family, parameters: spec.dimensions })
    add({ id: spec.id, label: spec.label, kind: 'equipment', levelId: spec.levelId, typeId, equipmentKind: spec.family,
      pose: { position: spec.position, yaw: spec.yaw ?? 0 }, disposition: 'installed',
      ...(spec.buildingId ? { buildingId: spec.buildingId } : {}), ...(spec.spaceId ? { spaceIds: [spec.spaceId] } : {}),
    }, spec.reason)
    for (const subject of spec.subjects) bindings.push({ physicalElementId: spec.id, elementId: subject.id, relation: subject.relation })
  }
  const route = (spec: RouteSpec): void => {
    add(element(spec.id, spec.label, 'pipe', spec.levelId, [0, 0, 0], { length: 1, width: spec.width, height: spec.width }, { path: spec.path, ...(spec.buildingId ? { buildingId: spec.buildingId } : {}) }), spec.reason)
    if (spec.subjectId) bindings.push({ physicalElementId: spec.id, elementId: spec.subjectId, relation: 'represents' })
  }
  return { source, bindings, add, element, wall, building, equipment, route, reasons }
}
