import type {
  CompiledPlantGraph,
  CompiledProcessLink,
  ComponentId,
  ConnectionId,
  ConnectionService,
} from './model.ts'

export type ProcessGraphLensMode =
  | 'selected-only'
  | 'direct-neighborhood'
  | 'path-to-visible'
  | 'service-layer'

export type ProcessGraphProjectionReason =
  | 'selected'
  | 'selected-connection'
  | 'connection-endpoint'
  | 'direct-link'
  | 'direct-neighbor'
  | 'visible-anchor'
  | 'path-link'
  | 'path-neighbor'
  | 'service-link'
  | 'service-neighbor'

export interface ProcessGraphLensConfig {
  readonly graph: CompiledPlantGraph
  readonly mode: ProcessGraphLensMode
  readonly selectedComponentIds?: ReadonlyArray<ComponentId>
  readonly selectedConnectionIds?: ReadonlyArray<ConnectionId>
  readonly visibleComponentIds?: ReadonlyArray<ComponentId>
  readonly service?: ConnectionService
}

export interface ProcessGraphProjection {
  readonly componentIds: ReadonlyArray<ComponentId>
  readonly connectionIds: ReadonlyArray<ConnectionId>
  readonly componentReasons: ReadonlyMap<ComponentId, ReadonlyArray<ProcessGraphProjectionReason>>
  readonly connectionReasons: ReadonlyMap<ConnectionId, ReadonlyArray<ProcessGraphProjectionReason>>
}

interface MutableProjection {
  readonly componentIndexes: Set<number>
  readonly connectionIndexes: Set<number>
  readonly componentReasons: Map<ComponentId, ProcessGraphProjectionReason[]>
  readonly connectionReasons: Map<ConnectionId, ProcessGraphProjectionReason[]>
}

interface LinkStep {
  readonly previousComponentIndex: number
  readonly linkIndex: number
}

const createMutableProjection = (): MutableProjection => ({
  componentIndexes: new Set<number>(),
  connectionIndexes: new Set<number>(),
  componentReasons: new Map<ComponentId, ProcessGraphProjectionReason[]>(),
  connectionReasons: new Map<ConnectionId, ProcessGraphProjectionReason[]>(),
})

const addReason = <TKey>(
  reasons: Map<TKey, ProcessGraphProjectionReason[]>,
  key: TKey,
  reason: ProcessGraphProjectionReason,
): void => {
  const existing = reasons.get(key)
  if (existing) {
    if (!existing.includes(reason)) existing.push(reason)
    return
  }
  reasons.set(key, [reason])
}

const requireComponentIndex = (graph: CompiledPlantGraph, componentId: ComponentId): number => {
  const index = graph.componentIndexById.get(componentId)
  if (index === undefined) {
    throw new Error(`process graph lens references unknown component: ${componentId}`)
  }
  return index
}

const connectionIndexById = (graph: CompiledPlantGraph): ReadonlyMap<ConnectionId, number> =>
  new Map<ConnectionId, number>(graph.links.map(link => [link.id, link.index]))

const requireConnectionIndex = (
  indexes: ReadonlyMap<ConnectionId, number>,
  connectionId: ConnectionId,
): number => {
  const index = indexes.get(connectionId)
  if (index === undefined) {
    throw new Error(`process graph lens references unknown connection: ${connectionId}`)
  }
  return index
}

const addComponent = (
  graph: CompiledPlantGraph,
  projection: MutableProjection,
  componentIndex: number,
  reason: ProcessGraphProjectionReason,
): void => {
  const component = graph.components[componentIndex]
  if (!component) throw new Error(`process graph lens found missing component index: ${componentIndex}`)
  projection.componentIndexes.add(componentIndex)
  addReason(projection.componentReasons, component.id, reason)
}

const addConnection = (
  graph: CompiledPlantGraph,
  projection: MutableProjection,
  linkIndex: number,
  connectionReason: ProcessGraphProjectionReason,
  endpointReason: ProcessGraphProjectionReason,
): void => {
  const link = graph.links[linkIndex]
  if (!link) throw new Error(`process graph lens found missing link index: ${linkIndex}`)
  projection.connectionIndexes.add(linkIndex)
  addReason(projection.connectionReasons, link.id, connectionReason)
  addComponent(graph, projection, link.fromComponentIndex, endpointReason)
  addComponent(graph, projection, link.toComponentIndex, endpointReason)
}

const adjacentLinkIndexes = (graph: CompiledPlantGraph, componentIndex: number): ReadonlyArray<number> => [
  ...(graph.incomingLinksByComponent[componentIndex] ?? []),
  ...(graph.outgoingLinksByComponent[componentIndex] ?? []),
]

const otherEndpointIndex = (link: CompiledProcessLink, componentIndex: number): number =>
  link.fromComponentIndex === componentIndex ? link.toComponentIndex : link.fromComponentIndex

const addDirectNeighborhood = (
  graph: CompiledPlantGraph,
  projection: MutableProjection,
  componentIndex: number,
): void => {
  addComponent(graph, projection, componentIndex, 'selected')
  for (const linkIndex of adjacentLinkIndexes(graph, componentIndex)) {
    addConnection(graph, projection, linkIndex, 'direct-link', 'direct-neighbor')
  }
}

const shortestPathToAnyAnchor = (
  graph: CompiledPlantGraph,
  startComponentIndex: number,
  anchorIndexes: ReadonlySet<number>,
): ReadonlyArray<number> | null => {
  if (anchorIndexes.has(startComponentIndex)) return []

  const queue: number[] = [startComponentIndex]
  const previousByComponent = new Map<number, LinkStep | null>([[startComponentIndex, null]])

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const componentIndex = queue[cursor]
    if (componentIndex === undefined) continue

    for (const linkIndex of adjacentLinkIndexes(graph, componentIndex)) {
      const link = graph.links[linkIndex]
      if (!link) continue
      const nextComponentIndex = otherEndpointIndex(link, componentIndex)
      if (previousByComponent.has(nextComponentIndex)) continue

      previousByComponent.set(nextComponentIndex, { previousComponentIndex: componentIndex, linkIndex })
      if (anchorIndexes.has(nextComponentIndex)) {
        const path: number[] = []
        let currentIndex = nextComponentIndex
        while (currentIndex !== startComponentIndex) {
          const previous = previousByComponent.get(currentIndex)
          if (!previous) break
          path.push(previous.linkIndex)
          currentIndex = previous.previousComponentIndex
        }
        return path.reverse()
      }
      queue.push(nextComponentIndex)
    }
  }

  return null
}

const addPathToVisibleAnchors = (
  graph: CompiledPlantGraph,
  projection: MutableProjection,
  selectedIndexes: ReadonlyArray<number>,
  anchorIndexes: ReadonlySet<number>,
): void => {
  for (const anchorIndex of anchorIndexes) addComponent(graph, projection, anchorIndex, 'visible-anchor')

  for (const selectedIndex of selectedIndexes) {
    addComponent(graph, projection, selectedIndex, 'selected')
    const path = shortestPathToAnyAnchor(graph, selectedIndex, anchorIndexes)
    if (!path) continue
    for (const linkIndex of path) {
      addConnection(graph, projection, linkIndex, 'path-link', 'path-neighbor')
    }
  }
}

const finalizeProjection = (
  graph: CompiledPlantGraph,
  projection: MutableProjection,
): ProcessGraphProjection => {
  const componentIds = graph.components
    .filter(component => projection.componentIndexes.has(component.index))
    .map(component => component.id)
  const connectionIds = graph.links
    .filter(link => projection.connectionIndexes.has(link.index))
    .map(link => link.id)
  return {
    componentIds,
    connectionIds,
    componentReasons: new Map(
      componentIds.map(componentId => [componentId, [...(projection.componentReasons.get(componentId) ?? [])]]),
    ),
    connectionReasons: new Map(
      connectionIds.map(connectionId => [connectionId, [...(projection.connectionReasons.get(connectionId) ?? [])]]),
    ),
  }
}

export const projectProcessGraph = (config: ProcessGraphLensConfig): ProcessGraphProjection => {
  const { graph } = config
  const projection = createMutableProjection()
  const connectionIndexes = connectionIndexById(graph)
  const selectedComponentIndexes = (config.selectedComponentIds ?? [])
    .map(componentId => requireComponentIndex(graph, componentId))
  const selectedConnectionIndexes = (config.selectedConnectionIds ?? [])
    .map(connectionId => requireConnectionIndex(connectionIndexes, connectionId))

  for (const linkIndex of selectedConnectionIndexes) {
    addConnection(graph, projection, linkIndex, 'selected-connection', 'connection-endpoint')
  }

  if (config.mode === 'selected-only') {
    for (const componentIndex of selectedComponentIndexes) {
      addComponent(graph, projection, componentIndex, 'selected')
    }
    return finalizeProjection(graph, projection)
  }

  if (config.mode === 'direct-neighborhood') {
    for (const componentIndex of selectedComponentIndexes) {
      addDirectNeighborhood(graph, projection, componentIndex)
    }
    return finalizeProjection(graph, projection)
  }

  if (config.mode === 'path-to-visible') {
    const visibleAnchorIndexes = new Set<number>(
      (config.visibleComponentIds ?? []).map(componentId => requireComponentIndex(graph, componentId)),
    )
    addPathToVisibleAnchors(graph, projection, selectedComponentIndexes, visibleAnchorIndexes)
    return finalizeProjection(graph, projection)
  }

  if (config.service === undefined) {
    throw new Error('process graph service-layer lens requires a service')
  }
  const serviceLinkIndexes = graph.linksByService.get(config.service) ?? []
  for (const linkIndex of serviceLinkIndexes) {
    addConnection(graph, projection, linkIndex, 'service-link', 'service-neighbor')
  }
  return finalizeProjection(graph, projection)
}
