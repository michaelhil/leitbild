import type { ComponentId, ConnectionId, ProcessGraphProjection } from '../graph/index.ts'
import type {
  CompiledProcessDisplay,
  CompiledProcessDisplayPath,
  CompiledProcessDisplayWidget,
} from './model.ts'

export interface ProcessDisplayProjectionOptions {
  readonly includeAmbientWidgets?: boolean
  readonly includeAmbientPaths?: boolean
}

export interface ProcessDisplayProjection {
  readonly visibleWidgets: ReadonlyArray<CompiledProcessDisplayWidget>
  readonly visiblePaths: ReadonlyArray<CompiledProcessDisplayPath>
  readonly hiddenWidgets: ReadonlyArray<CompiledProcessDisplayWidget>
  readonly hiddenPaths: ReadonlyArray<CompiledProcessDisplayPath>
}

const endpointWidgetIdsFor = (path: CompiledProcessDisplayPath): ReadonlyArray<string> => [
  path.from.widgetId,
  path.to.widgetId,
]

const widgetIsVisible = (
  widget: CompiledProcessDisplayWidget,
  componentIds: ReadonlySet<ComponentId>,
  includeAmbient: boolean,
): boolean => {
  if (widget.source === undefined) return includeAmbient
  return widget.source.componentIds.some(componentId => componentIds.has(componentId))
}

const pathIsVisible = (config: {
  readonly path: CompiledProcessDisplayPath
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

export const projectCompiledProcessDisplay = (config: {
  readonly display: CompiledProcessDisplay
  readonly graphProjection: ProcessGraphProjection
  readonly options?: ProcessDisplayProjectionOptions
}): ProcessDisplayProjection => {
  const includeAmbientWidgets = config.options?.includeAmbientWidgets ?? true
  const includeAmbientPaths = config.options?.includeAmbientPaths ?? true
  const componentIds = new Set<ComponentId>(config.graphProjection.componentIds)
  const connectionIds = new Set<ConnectionId>(config.graphProjection.connectionIds)

  const visibleWidgets = config.display.widgets.filter(widget => widgetIsVisible(widget, componentIds, includeAmbientWidgets))
  const visibleWidgetIds = new Set<string>(visibleWidgets.map(widget => widget.id))
  const visiblePaths = config.display.paths.filter(path => pathIsVisible({
    path,
    connectionIds,
    visibleWidgetIds,
    includeAmbient: includeAmbientPaths,
  }))
  const visiblePathIds = new Set<string>(visiblePaths.map(path => path.id))

  return {
    visibleWidgets,
    visiblePaths,
    hiddenWidgets: config.display.widgets.filter(widget => !visibleWidgetIds.has(widget.id)),
    hiddenPaths: config.display.paths.filter(path => !visiblePathIds.has(path.id)),
  }
}
