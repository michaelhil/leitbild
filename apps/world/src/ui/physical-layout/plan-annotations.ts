import type { PackPhysicalScene, PhysicalPlanAnnotation, PhysicalSceneBounds } from '../../core/packs/scene.ts'
import type { PhysicalSceneView } from '../map/physical-scene/types.ts'
import type { ExplorerViewportRect } from './explorer-viewport.ts'

type Point = { readonly x: number; readonly y: number }
type Position = readonly [number, number, number]
const metric = new Intl.NumberFormat('en', { maximumFractionDigits: 2 })
export const physicalPlanDimensionText = (annotation: Extract<PhysicalPlanAnnotation, { kind: 'dimension' }>): string =>
  `${metric.format(Math.hypot(...annotation.to.map((value, axis) => value - annotation.from[axis]!)))} m`

export const visiblePhysicalPlanAnnotations = (scene: PackPhysicalScene, view: PhysicalSceneView, scopeId: string | null): ReadonlyArray<PhysicalPlanAnnotation> => {
  if (view.mode !== '2d') return []
  const hidden = new Set(view.hiddenLayerIds ?? scene.layers?.filter(layer => !layer.defaultVisible).map(layer => layer.id) ?? [])
  const scopes = new Map(scene.scopes?.map(scope => [scope.id, scope]))
  const inScope = (id: string): boolean => {
    let current: string | undefined = id
    while (current !== undefined) { if (current === scopeId) return true; current = scopes.get(current)?.parentId }
    return false
  }
  return (scene.planAnnotations ?? []).filter(annotation => (annotation.levelIds.includes('site') || annotation.levelIds.includes(view.levelId)) &&
    (annotation.layerId === undefined || !hidden.has(annotation.layerId)) && (scopeId === null || annotation.scopeIds.some(inScope)))
}

const box = (points: ReadonlyArray<Point>): ExplorerViewportRect => {
  const xs = points.map(point => point.x), ys = points.map(point => point.y)
  const x = Math.min(...xs), y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}
const overlaps = (a: ExplorerViewportRect, b: ExplorerViewportRect): boolean => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
const corners = (bounds: PhysicalSceneBounds): Position[] => [[bounds.min[0], bounds.min[1], 0], [bounds.max[0], bounds.min[1], 0], [bounds.max[0], bounds.max[1], 0], [bounds.min[0], bounds.max[1], 0]]
const lookup = new WeakMap<PackPhysicalScene, { objects: Map<string, PackPhysicalScene['objects'][number]>; envelopes: Map<string, PhysicalSceneBounds> }>()
const draftingLookup = (scene: PackPhysicalScene) => {
  const previous = lookup.get(scene); if (previous) return previous
  const scopes = new Map(scene.scopes?.map(scope => [scope.id, scope])), objects = new Map(scene.objects.map(object => [object.id, object]))
  const depth = (id: string): number => { const parent = scopes.get(id)?.parentId; return parent === undefined ? 0 : depth(parent) + 1 }
  const area = (bounds: PhysicalSceneBounds) => (bounds.max[0] - bounds.min[0]) * (bounds.max[1] - bounds.min[1])
  const ordered = [...scopes.values()].sort((a, b) => depth(b.id) - depth(a.id) || area(a.bounds) - area(b.bounds) || a.id.localeCompare(b.id)), envelopes = new Map<string, PhysicalSceneBounds>()
  for (const annotation of scene.planAnnotations ?? []) {
    const bounds = (annotation.occurrenceId ? objects.get(annotation.occurrenceId)?.bounds : undefined) ?? ordered.find(scope => annotation.scopeIds.includes(scope.id))?.bounds
    if (bounds) envelopes.set(annotation.id, bounds)
  }
  const value = { objects, envelopes }; lookup.set(scene, value); return value
}

/** Screen drafting over the actual Plan, shared by map and dedicated hosts.
 * Text/line widths are typography; measured fit/overlap replaces label-count caps. */
export const drawPhysicalPlanAnnotations = (context: CanvasRenderingContext2D, input: {
  readonly scene: PackPhysicalScene; readonly view: PhysicalSceneView; readonly scopeId: string | null
  readonly project: (points: ReadonlyArray<Position>) => ReadonlyArray<Point>
  readonly width: number; readonly height: number; readonly covers: ReadonlyArray<ExplorerViewportRect>
  readonly line: string; readonly allowance: string; readonly access: string
  readonly font: string; readonly fontSize: number
}, occupied: ExplorerViewportRect[]): void => {
  const annotations = visiblePhysicalPlanAnnotations(input.scene, input.view, input.scopeId)
  if (!annotations.length) return
  const viewport = { x: 0, y: 0, width: input.width, height: input.height }, { envelopes } = draftingLookup(input.scene)
  context.save(); context.font = input.font; context.textAlign = 'center'; context.textBaseline = 'middle'; context.lineWidth = 1
  const height = input.fontSize, gap = height / 3
  const path = (points: ReadonlyArray<Point>, closed = false): void => {
    context.beginPath(); points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y)); if (closed) context.closePath()
  }
  const label = (text: string, point: Point, rotation = 0, envelope?: ExplorerViewportRect): void => {
    const width = context.measureText(text).width, c = Math.abs(Math.cos(rotation)), s = Math.abs(Math.sin(rotation))
    const bound = { x: point.x - (width * c + height * s) / 2 - gap, y: point.y - (height * c + width * s) / 2 - gap, width: width * c + height * s + gap * 2, height: height * c + width * s + gap * 2 }
    if (!overlaps(bound, viewport) || envelope && (bound.width > envelope.width || bound.height > envelope.height) || input.covers.some(cover => overlaps(bound, cover)) || occupied.some(other => overlaps(bound, other))) return
    occupied.push(bound); context.save(); context.translate(point.x, point.y); context.rotate(rotation); context.fillText(text, 0, 0); context.restore()
  }
  // Illustrative allowances are a drafting facet, not opaque physical solids.
  for (const annotation of annotations) if (annotation.kind === 'hatch') {
    const points = input.project(annotation.outline); if (!points.length) continue
    const bounds = box(points); if (!overlaps(bounds, viewport)) continue
    context.save(); context.strokeStyle = annotation.role === 'access' ? input.access : input.allowance; context.fillStyle = context.strokeStyle
    path(points, true); context.setLineDash([height / 2, height / 3]); context.stroke(); context.setLineDash([]); context.clip()
    const left = Math.max(0, bounds.x), top = Math.max(0, bounds.y), right = Math.min(input.width, bounds.x + bounds.width), bottom = Math.min(input.height, bounds.y + bounds.height)
    context.globalAlpha = .35
    for (let offset = left - (bottom - top); offset < right; offset += height / 2) { path([{ x: offset, y: bottom }, { x: offset + bottom - top, y: top }]); context.stroke() }
    context.restore(); context.fillStyle = annotation.role === 'access' ? input.access : input.allowance
    label(annotation.label, { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }, 0, bounds)
  }
  context.strokeStyle = input.line; context.fillStyle = input.line
  for (const annotation of annotations) if (annotation.kind === 'dimension') {
    const start = annotation.from.map((value, axis) => value + annotation.offset[axis]!) as unknown as Position, end = annotation.to.map((value, axis) => value + annotation.offset[axis]!) as unknown as Position
    const points = input.project([annotation.from, annotation.to, start, end]); if (points.length !== 4 || !overlaps(box(points), viewport)) continue
    const [a, b, c, d] = points as [Point, Point, Point, Point], dx = d.x - c.x, dy = d.y - c.y, length = Math.hypot(dx, dy), text = physicalPlanDimensionText(annotation)
    if (length < context.measureText(text).width + height * 2) continue
    context.globalAlpha = .6; path([a, c]); context.stroke(); path([b, d]); context.stroke(); path([c, d]); context.stroke()
    const tickX = (dx - dy) / length * gap, tickY = (dy + dx) / length * gap
    for (const point of [c, d]) { path([{ x: point.x - tickX, y: point.y - tickY }, { x: point.x + tickX, y: point.y + tickY }]); context.stroke() }
    context.globalAlpha = 1
    let angle = Math.atan2(dy, dx); if (angle > Math.PI / 2) angle -= Math.PI; else if (angle < -Math.PI / 2) angle += Math.PI
    label(text, { x: (c.x + d.x) / 2 + dy / length * height, y: (c.y + d.y) / 2 - dx / length * height }, angle)
  }
  for (const annotation of annotations) if (annotation.kind === 'label') {
    const angle = annotation.rotation * Math.PI / 180, points = input.project([annotation.anchor, [annotation.anchor[0] + Math.cos(angle), annotation.anchor[1] + Math.sin(angle), annotation.anchor[2]]]); if (points.length !== 2) continue
    const bound = envelopes.get(annotation.id)
    const projected = bound ? input.project(corners(bound)) : []
    label(annotation.text, points[0]!, Math.atan2(points[1]!.y - points[0]!.y, points[1]!.x - points[0]!.x), projected.length ? box(projected) : undefined)
  }
  context.restore()
}
