import type { CompiledPlantGraph, ConnectionId, VariablePath } from '../graph/index.ts'
import type {
  CompiledProcessSurface,
  CompiledProcessSurfacePath,
  CompiledProcessSurfaceWidget,
  ProcessSurfaceDefinition,
  ProcessSurfaceRegion,
  ProcessSurfaceWidget,
} from './model.ts'
import { processSurfaceDefinitionSchema } from './model.ts'

interface RegionFrame {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

const horizontalRegionRoles = new Set<ProcessSurfaceRegion['role']>(['primary-system', 'heat-transfer', 'secondary-system'])

const regionFramesFor = (surface: ProcessSurfaceDefinition): ReadonlyMap<string, RegionFrame> => {
  const margin = 42
  const statusHeight = 92
  const alarmHeight = 88
  const supportHeight = 120
  const bodyTop = margin + statusHeight
  const bodyBottom = surface.designSize.height - margin - supportHeight - alarmHeight
  const bodyHeight = Math.max(260, bodyBottom - bodyTop)
  const horizontal = surface.regions
    .filter(region => horizontalRegionRoles.has(region.role))
    .sort((left, right) => left.order - right.order)
  const columnWidth = horizontal.length === 0
    ? surface.designSize.width - margin * 2
    : (surface.designSize.width - margin * 2) / horizontal.length
  const frames = new Map<string, RegionFrame>()
  for (const [index, region] of horizontal.entries()) {
    frames.set(region.id, {
      id: region.id,
      x: margin + index * columnWidth,
      y: bodyTop,
      width: columnWidth,
      height: bodyHeight,
    })
  }
  for (const region of surface.regions) {
    if (frames.has(region.id)) continue
    if (region.role === 'unit-status') {
      frames.set(region.id, { id: region.id, x: margin, y: margin, width: surface.designSize.width - margin * 2, height: statusHeight - 18 })
    } else if (region.role === 'support-system') {
      frames.set(region.id, {
        id: region.id,
        x: margin,
        y: surface.designSize.height - margin - supportHeight - alarmHeight + 24,
        width: surface.designSize.width - margin * 2,
        height: supportHeight - 18,
      })
    } else if (region.role === 'alarms') {
      frames.set(region.id, {
        id: region.id,
        x: margin,
        y: surface.designSize.height - margin - alarmHeight + 16,
        width: surface.designSize.width - margin * 2,
        height: alarmHeight - 16,
      })
    } else {
      frames.set(region.id, { id: region.id, x: margin, y: bodyTop, width: surface.designSize.width - margin * 2, height: bodyHeight })
    }
  }
  return frames
}

const sizeFor = (widget: ProcessSurfaceWidget): { readonly width: number; readonly height: number } => {
  if (widget.type === 'statusBanner') return { width: 540, height: 62 }
  if (widget.type === 'alarmStrip') return { width: 640, height: 54 }
  if (widget.type === 'numericReadout') return { width: 240, height: 74 }
  if (widget.type === 'trendMini') return { width: 260, height: 92 }
  if (widget.type === 'pump' || widget.type === 'valve') return { width: 112, height: 112 }
  if (widget.type === 'heatExchanger') return { width: 170, height: 230 }
  if (widget.type === 'label') return { width: 200, height: 46 }
  return { width: 170, height: 260 }
}

const portPoint = (
  geometry: CompiledProcessSurfaceWidget['geometry'],
  port: ProcessSurfaceWidget['ports'][string],
): { readonly x: number; readonly y: number } => {
  if (typeof port === 'object') return { x: geometry.x + port.x, y: geometry.y + port.y }
  const side = port
  if (side === 'left') return { x: geometry.x, y: geometry.y + geometry.height / 2 }
  if (side === 'right') return { x: geometry.x + geometry.width, y: geometry.y + geometry.height / 2 }
  if (side === 'top') return { x: geometry.x + geometry.width / 2, y: geometry.y }
  return { x: geometry.x + geometry.width / 2, y: geometry.y + geometry.height }
}

const compileWidgets = (
  surface: ProcessSurfaceDefinition,
  frames: ReadonlyMap<string, RegionFrame>,
): ReadonlyArray<CompiledProcessSurfaceWidget> => {
  const widgetsByRegion = new Map<string, ProcessSurfaceWidget[]>()
  for (const widget of surface.widgets) widgetsByRegion.set(widget.region, [...(widgetsByRegion.get(widget.region) ?? []), widget])
  return [...widgetsByRegion.entries()].flatMap(([regionId, widgets]) => {
    const frame = frames.get(regionId)
    if (!frame) throw new Error(`process surface region frame not found: ${regionId}`)
    const sorted = [...widgets].sort((left, right) => left.rank - right.rank || left.stack - right.stack || left.id.localeCompare(right.id))
    const gap = 24
    const totalHeight = sorted.reduce((sum, widget) => sum + sizeFor(widget).height, 0) + Math.max(0, sorted.length - 1) * gap
    let y = frame.y + Math.max(0, (frame.height - totalHeight) / 2)
    return sorted.map(widget => {
      const size = sizeFor(widget)
      const x = frame.x + (frame.width - size.width) / 2 + (widget.stack - 1) * 44
      const geometry = widget.geometry ?? { x, y, width: size.width, height: size.height }
      y += size.height + gap
      return {
        id: widget.id,
        type: widget.type,
        label: widget.label,
        ...(widget.source === undefined ? {} : { source: widget.source }),
        ...(widget.role === undefined ? {} : { role: widget.role }),
        geometry,
        binds: widget.binds,
        ports: Object.fromEntries(Object.entries(widget.ports).map(([name, port]) => [name, portPoint(geometry, port)])),
        style: widget.style,
      } satisfies CompiledProcessSurfaceWidget
    })
  })
}

const compilePathPoints = (
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
): ReadonlyArray<{ readonly x: number; readonly y: number }> => {
  const midX = (from.x + to.x) / 2
  return [
    from,
    { x: midX, y: from.y },
    { x: midX, y: to.y },
    to,
  ]
}

const portRefFor = (ref: string): { readonly widgetId: string; readonly portName: string } => {
  const separatorIndex = ref.lastIndexOf('.')
  if (separatorIndex < 1 || separatorIndex === ref.length - 1) throw new Error(`invalid process surface port ref: ${ref}`)
  return {
    widgetId: ref.slice(0, separatorIndex),
    portName: ref.slice(separatorIndex + 1),
  }
}

const uniqueBindingPaths = (surface: ProcessSurfaceDefinition): ReadonlyArray<VariablePath> => {
  const paths = new Set<VariablePath>()
  for (const widget of surface.widgets) {
    for (const binding of Object.values(widget.binds)) paths.add(binding.path)
  }
  for (const path of surface.paths) {
    for (const binding of Object.values(path.binds)) paths.add(binding.path)
  }
  return [...paths].sort()
}

const validateGraphSources = (definition: ProcessSurfaceDefinition, graph: CompiledPlantGraph): void => {
  const linkIndexById = new Map<ConnectionId, number>(graph.links.map(link => [link.id, link.index]))
  for (const widget of definition.widgets) {
    if (widget.source === undefined) continue
    for (const componentId of widget.source.componentIds) {
      if (!graph.componentIndexById.has(componentId)) {
        throw new Error(`process surface ${definition.id} widget ${widget.id} references unknown component: ${componentId}`)
      }
    }
  }
  for (const path of definition.paths) {
    if (path.source === undefined) continue
    if (!linkIndexById.has(path.source.connectionId)) {
      throw new Error(`process surface ${definition.id} path ${path.id} references unknown connection: ${path.source.connectionId}`)
    }
  }
}

export const compileProcessSurface = (config: {
  readonly definition: ProcessSurfaceDefinition
  readonly graph: CompiledPlantGraph
}): CompiledProcessSurface => {
  const definition = processSurfaceDefinitionSchema.parse(config.definition)
  const variablePaths = new Set(config.graph.variables.map(variable => variable.path))
  for (const path of uniqueBindingPaths(definition)) {
    if (!variablePaths.has(path)) throw new Error(`process surface ${definition.id} references unknown variable path: ${path}`)
  }
  validateGraphSources(definition, config.graph)
  const frames = regionFramesFor(definition)
  const widgets = compileWidgets(definition, frames)
  const portIndex = new Map<string, { readonly x: number; readonly y: number }>()
  for (const widget of widgets) {
    for (const [portName, point] of Object.entries(widget.ports)) portIndex.set(`${widget.id}.${portName}`, point)
  }
  const paths = definition.paths.map(path => {
    const from = portIndex.get(path.from)
    const to = portIndex.get(path.to)
    if (!from || !to) throw new Error(`process surface ${definition.id} path ${path.id} references an unknown port`)
    return {
      id: path.id,
      ...(path.label === undefined ? {} : { label: path.label }),
      ...(path.source === undefined ? {} : { source: path.source }),
      from: portRefFor(path.from),
      to: portRefFor(path.to),
      points: path.waypoints.length > 0 ? [from, ...path.waypoints, to] : compilePathPoints(from, to),
      binds: path.binds,
      style: path.style,
    } satisfies CompiledProcessSurfacePath
  })
  return {
    id: definition.id,
    title: definition.title,
    ...(definition.description === undefined ? {} : { description: definition.description }),
    designSize: definition.designSize,
    lenses: definition.lenses.map(lens => ({
      id: lens.id,
      label: lens.label,
      ...(lens.description === undefined ? {} : { description: lens.description }),
      ...(lens.lens === undefined ? {} : { lens: lens.lens }),
    })),
    widgets,
    paths,
    bindingPaths: uniqueBindingPaths(definition),
  }
}
