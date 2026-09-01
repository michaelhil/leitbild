import type {
  CompiledProcessDisplay,
  CompiledProcessDisplayPath,
  CompiledProcessDisplayWidget,
  ProcessDisplayValue,
} from '../../packs/process-plant/displays/index.ts'
import type { ProcessDisplayWidgetPosition } from './process-display-layout.ts'

export interface Point {
  readonly x: number
  readonly y: number
}

export const bindingRowsFor = (
  widget: CompiledProcessDisplayWidget,
  values: ReadonlyMap<string, ProcessDisplayValue>,
): ReadonlyArray<ProcessDisplayValue> =>
  Object.values(widget.binds)
    .map(binding => values.get(binding.path))
    .filter(value => value !== undefined)

export const numericValueFor = (
  path: string,
  values: ReadonlyMap<string, ProcessDisplayValue>,
): number | null => {
  const value = values.get(path)?.value
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export const levelFractionFor = (
  widget: CompiledProcessDisplayWidget,
  values: ReadonlyMap<string, ProcessDisplayValue>,
): number => {
  const levelBinding = widget.binds.level
  if (!levelBinding) return 0.5
  const value = numericValueFor(levelBinding.path, values)
  if (value === null) return 0.5
  return Math.max(0, Math.min(1, value > 1 ? value / 100 : value))
}

export const widgetPositionFor = (
  widget: CompiledProcessDisplayWidget,
  widgetPositions: Readonly<Record<string, ProcessDisplayWidgetPosition>>,
): ProcessDisplayWidgetPosition =>
  widgetPositions[widget.id] ?? { x: widget.geometry.x, y: widget.geometry.y }

export const widgetGeometryFor = (
  widget: CompiledProcessDisplayWidget,
  widgetPositions: Readonly<Record<string, ProcessDisplayWidgetPosition>>,
): CompiledProcessDisplayWidget['geometry'] => ({
  ...widget.geometry,
  ...widgetPositionFor(widget, widgetPositions),
})

export const portPointFor = (config: {
  readonly display: CompiledProcessDisplay
  readonly widgetPositions: Readonly<Record<string, ProcessDisplayWidgetPosition>>
  readonly widgetId: string
  readonly portName: string
}): Point | null => {
  const widget = config.display.widgets.find(candidate => candidate.id === config.widgetId)
  const original = widget?.ports[config.portName]
  if (!widget || !original) return null
  const position = widgetPositionFor(widget, config.widgetPositions)
  return {
    x: original.x + position.x - widget.geometry.x,
    y: original.y + position.y - widget.geometry.y,
  }
}

export const pathPointsFor = (config: {
  readonly display: CompiledProcessDisplay
  readonly widgetPositions: Readonly<Record<string, ProcessDisplayWidgetPosition>>
  readonly path: CompiledProcessDisplayPath
}): ReadonlyArray<Point> => {
  const from = portPointFor({
    display: config.display,
    widgetPositions: config.widgetPositions,
    widgetId: config.path.from.widgetId,
    portName: config.path.from.portName,
  })
  const to = portPointFor({
    display: config.display,
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

export const pathDataFor = (points: ReadonlyArray<Point>): string => {
  const first = points[0]
  if (!first) return ''
  const commands = [`M ${first.x.toFixed(1)} ${first.y.toFixed(1)}`]
  for (const point of points.slice(1)) commands.push(`L ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
  return commands.join(' ')
}

export const pathFlowFraction = (
  path: CompiledProcessDisplayPath,
  values: ReadonlyMap<string, ProcessDisplayValue>,
): number => {
  const binding = path.binds.flow ?? Object.values(path.binds)[0]
  if (!binding) return 0
  const value = numericValueFor(binding.path, values)
  if (value === null) return 0
  return Math.max(0.12, Math.min(0.82, Math.abs(value) / 5_500))
}
