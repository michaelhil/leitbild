import type {
  CompiledProcessSurface,
  CompiledProcessSurfacePath,
  CompiledProcessSurfaceWidget,
  ProcessSurfaceValue,
} from '../../packs/process-plant/surfaces/index.ts'
import type { ProcessSurfaceWidgetPosition } from './process-surface-layout.ts'

export interface Point {
  readonly x: number
  readonly y: number
}

export const bindingRowsFor = (
  widget: CompiledProcessSurfaceWidget,
  values: ReadonlyMap<string, ProcessSurfaceValue>,
): ReadonlyArray<ProcessSurfaceValue> =>
  Object.values(widget.binds)
    .map(binding => values.get(binding.path))
    .filter(value => value !== undefined)

export const numericValueFor = (
  path: string,
  values: ReadonlyMap<string, ProcessSurfaceValue>,
): number | null => {
  const value = values.get(path)?.value
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export const levelFractionFor = (
  widget: CompiledProcessSurfaceWidget,
  values: ReadonlyMap<string, ProcessSurfaceValue>,
): number => {
  const levelBinding = widget.binds.level
  if (!levelBinding) return 0.5
  const value = numericValueFor(levelBinding.path, values)
  if (value === null) return 0.5
  return Math.max(0, Math.min(1, value > 1 ? value / 100 : value))
}

export const widgetPositionFor = (
  widget: CompiledProcessSurfaceWidget,
  widgetPositions: Readonly<Record<string, ProcessSurfaceWidgetPosition>>,
): ProcessSurfaceWidgetPosition =>
  widgetPositions[widget.id] ?? { x: widget.geometry.x, y: widget.geometry.y }

export const widgetGeometryFor = (
  widget: CompiledProcessSurfaceWidget,
  widgetPositions: Readonly<Record<string, ProcessSurfaceWidgetPosition>>,
): CompiledProcessSurfaceWidget['geometry'] => ({
  ...widget.geometry,
  ...widgetPositionFor(widget, widgetPositions),
})

export const portPointFor = (config: {
  readonly surface: CompiledProcessSurface
  readonly widgetPositions: Readonly<Record<string, ProcessSurfaceWidgetPosition>>
  readonly widgetId: string
  readonly portName: string
}): Point | null => {
  const widget = config.surface.widgets.find(candidate => candidate.id === config.widgetId)
  const original = widget?.ports[config.portName]
  if (!widget || !original) return null
  const position = widgetPositionFor(widget, config.widgetPositions)
  return {
    x: original.x + position.x - widget.geometry.x,
    y: original.y + position.y - widget.geometry.y,
  }
}

export const pathPointsFor = (config: {
  readonly surface: CompiledProcessSurface
  readonly widgetPositions: Readonly<Record<string, ProcessSurfaceWidgetPosition>>
  readonly path: CompiledProcessSurfacePath
}): ReadonlyArray<Point> => {
  const from = portPointFor({
    surface: config.surface,
    widgetPositions: config.widgetPositions,
    widgetId: config.path.from.widgetId,
    portName: config.path.from.portName,
  })
  const to = portPointFor({
    surface: config.surface,
    widgetPositions: config.widgetPositions,
    widgetId: config.path.to.widgetId,
    portName: config.path.to.portName,
  })
  const authoredFirst = config.path.points[0]
  const authoredLast = config.path.points[config.path.points.length - 1]
  if (!from || !to || !authoredFirst || !authoredLast || config.path.points.length < 2) return config.path.points
  const startDelta = { x: from.x - authoredFirst.x, y: from.y - authoredFirst.y }
  const endDelta = { x: to.x - authoredLast.x, y: to.y - authoredLast.y }
  return config.path.points.map((point, index) => {
    const ratio = config.path.points.length === 1 ? 0 : index / (config.path.points.length - 1)
    return {
      x: point.x + startDelta.x * (1 - ratio) + endDelta.x * ratio,
      y: point.y + startDelta.y * (1 - ratio) + endDelta.y * ratio,
    }
  })
}

export const curvedPathData = (from: Point, to: Point): string => {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const horizontalBias = Math.max(80, Math.min(260, Math.abs(dx) * 0.48 + Math.abs(dy) * 0.12))
  const direction = dx >= 0 ? 1 : -1
  return [
    `M ${from.x.toFixed(1)} ${from.y.toFixed(1)}`,
    `C ${(from.x + horizontalBias * direction).toFixed(1)} ${from.y.toFixed(1)}`,
    `${(to.x - horizontalBias * direction).toFixed(1)} ${to.y.toFixed(1)}`,
    `${to.x.toFixed(1)} ${to.y.toFixed(1)}`,
  ].join(' ')
}

export const pathDataFor = (points: ReadonlyArray<Point>): string => {
  const first = points[0]
  const second = points[1]
  if (points.length === 2 && first && second) return curvedPathData(first, second)
  if (!first) return ''
  const commands = [`M ${first.x.toFixed(1)} ${first.y.toFixed(1)}`]
  for (let index = 1; index < points.length - 1; index += 1) {
    const control = points[index]
    const next = points[index + 1]
    if (!control || !next) continue
    const midpoint = { x: (control.x + next.x) / 2, y: (control.y + next.y) / 2 }
    commands.push(`Q ${control.x.toFixed(1)} ${control.y.toFixed(1)} ${midpoint.x.toFixed(1)} ${midpoint.y.toFixed(1)}`)
  }
  const last = points[points.length - 1]
  if (last && points.length > 1) commands.push(`L ${last.x.toFixed(1)} ${last.y.toFixed(1)}`)
  return commands.join(' ')
}

export const pathFlowFraction = (
  path: CompiledProcessSurfacePath,
  values: ReadonlyMap<string, ProcessSurfaceValue>,
): number => {
  const binding = path.binds.flow ?? Object.values(path.binds)[0]
  if (!binding) return 0
  const value = numericValueFor(binding.path, values)
  if (value === null) return 0
  return Math.max(0.12, Math.min(0.82, Math.abs(value) / 5_500))
}
