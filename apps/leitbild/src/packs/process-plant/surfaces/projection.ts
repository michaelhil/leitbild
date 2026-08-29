import type { ComponentId, ConnectionId, ProcessGraphProjection } from '../graph/index.ts'
import type {
  CompiledProcessSurface,
  CompiledProcessSurfacePath,
  CompiledProcessSurfaceWidget,
} from './model.ts'

export interface ProcessSurfaceProjectionOptions {
  readonly includeAmbientWidgets?: boolean
  readonly includeAmbientPaths?: boolean
}

export interface ProcessSurfaceProjection {
  readonly visibleWidgets: ReadonlyArray<CompiledProcessSurfaceWidget>
  readonly visiblePaths: ReadonlyArray<CompiledProcessSurfacePath>
  readonly hiddenWidgets: ReadonlyArray<CompiledProcessSurfaceWidget>
  readonly hiddenPaths: ReadonlyArray<CompiledProcessSurfacePath>
}

const endpointWidgetIdsFor = (path: CompiledProcessSurfacePath): ReadonlyArray<string> => [
  path.from.widgetId,
  path.to.widgetId,
]

const widgetIsVisible = (
  widget: CompiledProcessSurfaceWidget,
  componentIds: ReadonlySet<ComponentId>,
  includeAmbient: boolean,
): boolean => {
  if (widget.source === undefined) return includeAmbient
  return widget.source.componentIds.some(componentId => componentIds.has(componentId))
}

const pathIsVisible = (config: {
  readonly path: CompiledProcessSurfacePath
  readonly connectionIds: ReadonlySet<ConnectionId>
  readonly visibleWidgetIds: ReadonlySet<string>
  readonly includeAmbient: boolean
}): boolean => {
  const endpointsVisible = endpointWidgetIdsFor(config.path)
    .every(widgetId => config.visibleWidgetIds.has(widgetId))
  if (!endpointsVisible) return false
  if (config.path.source === undefined) return config.includeAmbient
  return config.connectionIds.has(config.path.source.connectionId)
}

export const projectCompiledProcessSurface = (config: {
  readonly surface: CompiledProcessSurface
  readonly graphProjection: ProcessGraphProjection
  readonly options?: ProcessSurfaceProjectionOptions
}): ProcessSurfaceProjection => {
  const includeAmbientWidgets = config.options?.includeAmbientWidgets ?? true
  const includeAmbientPaths = config.options?.includeAmbientPaths ?? true
  const componentIds = new Set<ComponentId>(config.graphProjection.componentIds)
  const connectionIds = new Set<ConnectionId>(config.graphProjection.connectionIds)

  const visibleWidgets = config.surface.widgets.filter(widget => widgetIsVisible(widget, componentIds, includeAmbientWidgets))
  const visibleWidgetIds = new Set<string>(visibleWidgets.map(widget => widget.id))
  const visiblePaths = config.surface.paths.filter(path => pathIsVisible({
    path,
    connectionIds,
    visibleWidgetIds,
    includeAmbient: includeAmbientPaths,
  }))
  const visiblePathIds = new Set<string>(visiblePaths.map(path => path.id))

  return {
    visibleWidgets,
    visiblePaths,
    hiddenWidgets: config.surface.widgets.filter(widget => !visibleWidgetIds.has(widget.id)),
    hiddenPaths: config.surface.paths.filter(path => !visiblePathIds.has(path.id)),
  }
}
