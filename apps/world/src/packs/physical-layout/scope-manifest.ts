import type { PhysicalSceneBounds, PhysicalSceneObject, PhysicalSceneScope } from '../../core/packs/scene.ts'

type V3 = readonly [number, number, number]
type Dimensions = { readonly length: number; readonly width: number; readonly height: number }
interface ScopeElement {
  readonly id: string
  readonly label: string
  readonly kind: string
  readonly pose: { readonly position: V3; readonly yaw: number }
  readonly dimensions?: Dimensions
  readonly typeId?: string
  readonly override?: Partial<Dimensions>
  readonly buildingId?: string
  readonly spaceIds?: readonly string[]
  readonly assemblyId?: string
  readonly hostId?: string
}
export interface PhysicalScopeSource {
  readonly id: string
  readonly title: string
  readonly origin: V3
  readonly rootScope: { readonly id: string; readonly label: string; readonly kind: 'site' | 'unit' }
  readonly levels: ReadonlyArray<{ readonly id: string; readonly elevation: number }>
  readonly types: ReadonlyArray<{ readonly id: string; readonly parameters: Dimensions }>
  readonly elements: readonly ScopeElement[]
}

const union = (bounds: ReadonlyArray<PhysicalSceneBounds>): PhysicalSceneBounds => {
  if (!bounds.length) throw new Error('A physical scope requires an authored or rendered envelope')
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const box of bounds) for (const axis of [0, 1, 2] as const) {
    min[axis] = Math.min(min[axis], box.min[axis]); max[axis] = Math.max(max[axis], box.max[axis])
  }
  return { min, max }
}

const positionBounds = (object: PhysicalSceneObject): PhysicalSceneBounds => {
  if (!object.positions.length) throw new Error(`An occurrence has no physical envelope: ${object.id}`)
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let index = 0; index < object.positions.length; index++) {
    const axis = index % 3
    min[axis] = Math.min(min[axis]!, object.positions[index]!); max[axis] = Math.max(max[axis]!, object.positions[index]!)
  }
  return { min, max }
}

/** Metadata is compiled from source identity, never inferred from a name or graph position. */
export const physicalScopeManifest = (source: PhysicalScopeSource, input: ReadonlyArray<PhysicalSceneObject>): {
  readonly objects: PhysicalSceneObject[]
  readonly scopes: PhysicalSceneScope[]
} => {
  const elements = new Map(source.elements.map(element => [element.id, element]))
  const types = new Map(source.types.map(type => [type.id, type.parameters]))
  const scopeElements = source.elements.filter(element => element.kind === 'building' || element.kind === 'space' || element.kind === 'assembly')
  const scopes = new Map(scopeElements.map(element => [element.id, element]))
  if (scopes.has(source.rootScope.id)) throw new Error('The physical root scope must have a distinct identity')
  const parentOf = (element: ScopeElement): string => {
    // An assembly can span several spaces. Its hierarchy parent is its building;
    // many-to-many space membership remains explicit on its occurrences.
    return element.kind !== 'building' && element.buildingId ? element.buildingId : source.rootScope.id
  }
  const membership = (element: ScopeElement): string[] => {
    const direct = [...(element.buildingId ? [element.buildingId] : []), ...(element.spaceIds ?? []), ...(element.assemblyId ? [element.assemblyId] : [])]
    const result = new Set([source.rootScope.id])
    for (const id of direct) {
      const scope = scopes.get(id)
      if (!scope) throw new Error(`Unknown physical membership ${element.id}/${id}`)
      result.add(id)
      const parent = parentOf(scope)
      if (parent !== source.rootScope.id && !scopes.has(parent)) throw new Error(`Unknown physical scope parent ${id}/${parent}`)
      result.add(parent)
    }
    return [...result]
  }
  const orderedLevels = [...source.levels].sort((a, b) => a.elevation - b.elevation)
  const levelsFor = (bounds: PhysicalSceneBounds): string[] => orderedLevels.filter((level, index) => {
    const top = orderedLevels[index + 1]?.elevation ?? Infinity
    return bounds.max[2] >= level.elevation && bounds.min[2] < top
  }).map(level => level.id)
  const authoredBounds = (element: ScopeElement): PhysicalSceneBounds => {
    const dimensions = { ...(element.typeId ? types.get(element.typeId) : element.dimensions), ...element.override }
    if (dimensions.length === undefined || dimensions.width === undefined || dimensions.height === undefined) throw new Error(`A physical scope needs dimensions: ${element.id}`)
    const c = Math.cos(element.pose.yaw), s = Math.sin(element.pose.yaw)
    const points = [[0, 0], [dimensions.length, 0], [dimensions.length, dimensions.width], [0, dimensions.width]].map(([x, y]) => [
      element.pose.position[0] + c * x! - s * y! - source.origin[0],
      element.pose.position[1] + s * x! + c * y! - source.origin[1],
    ])
    return {
      min: [Math.min(...points.map(point => point[0]!)), Math.min(...points.map(point => point[1]!)), element.pose.position[2] - source.origin[2]],
      max: [Math.max(...points.map(point => point[0]!)), Math.max(...points.map(point => point[1]!)), element.pose.position[2] + dimensions.height - source.origin[2]],
    }
  }
  const objects = input.map(object => {
    const element = elements.get(object.id)
    if (!element) throw new Error(`A rendered occurrence is absent from physical source: ${object.id}`)
    const bounds = positionBounds(object)
    return { ...object, bounds, scopeIds: membership(element), levelIds: object.levelId === 'site' ? ['site'] : levelsFor(bounds) }
  })
  const rootBounds = union(objects.map(object => object.bounds))
  const manifest: PhysicalSceneScope[] = [{ ...source.rootScope, bounds: rootBounds, levelIds: orderedLevels.map(level => level.id) }]
  for (const element of scopeElements) {
    const children = objects.filter(object => object.scopeIds.includes(element.id)).map(object => object.bounds)
    const bounds = union([authoredBounds(element), ...children])
    manifest.push({ id: element.id, label: element.label, kind: element.kind as 'building' | 'space' | 'assembly', parentId: parentOf(element), bounds, levelIds: levelsFor(bounds) })
  }
  return { objects, scopes: manifest }
}
