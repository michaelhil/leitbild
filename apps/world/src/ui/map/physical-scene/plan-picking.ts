import type { PackPhysicalScene, PhysicalPlanPrimitive, PhysicalSceneBounds, PhysicalSceneObject } from '../../../core/packs/scene.ts'
import { physicalPlanPaintCommands, physicalPlanContinuationPaths, physicalPlanTextFrame } from '../../physical-layout/plan-drawing.ts'
import type { PhysicalPlanPaint } from '../../physical-layout/plan-paint-stream.ts'
import { physicalScopeRegions } from './scope-regions.ts'
import { physicalArchitectureOpacity } from './architecture-opacity.ts'
import { createPhysicalSpatialIndex, visitPhysicalSpatialBounds, physicalSpatialBoundsOverlap, type PhysicalSpatialIndex } from './spatial-index.ts'
import type { PhysicalSceneView } from './types.ts'

export interface PhysicalPlanPickFrame { readonly a: number; readonly b: number; readonly c: number; readonly d: number; readonly e: number; readonly f: number }
export interface PhysicalPlanPickInput {
  readonly scene: PackPhysicalScene; readonly view: PhysicalSceneView; readonly scopeId: string | null
  readonly frame: PhysicalPlanPickFrame; readonly width: number; readonly height: number; readonly ratio: number; readonly fontFamily: string
}
export interface PhysicalPlanInkHit {
  /** Actual graph-bearing source occurrence; absent for annotation/architecture blockers. */
  readonly occurrenceId?: string
  /** Actual authoring owner, including non-operational walls/floors. */
  readonly ownerOccurrenceId?: string
  readonly primitiveId: string
  readonly occluded: boolean
}
type Point = { readonly x: number; readonly y: number }
type Geometry = Exclude<PhysicalPlanPrimitive, { kind: 'text' }>
type Text = Extract<PhysicalPlanPrimitive, { kind: 'text' }>
type Marker = ReturnType<typeof physicalPlanContinuationPaths>[number]
type NativeContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
interface Entry { readonly order: number; readonly primitiveId: string; readonly owner?: PhysicalSceneObject; readonly command?: PhysicalPlanPaint; readonly marker?: Marker; readonly bounds: PhysicalSceneBounds }
interface TextLayout { readonly font: string; readonly box: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number }; readonly angle: number }
interface TextIndex { readonly key: string; readonly entries: ReadonlyArray<Entry>; readonly layouts: ReadonlyArray<TextLayout>; readonly index: PhysicalSpatialIndex }
interface Index { readonly entries: ReadonlyArray<Entry>; readonly index: PhysicalSpatialIndex; readonly texts: ReadonlyArray<{ readonly order: number; readonly primitive: Text; readonly owner?: PhysicalSceneObject }>; readonly textOwners: ReadonlySet<string>; readonly regions: ReadonlyArray<PhysicalSceneBounds>; readonly owners: ReadonlyMap<string, ReadonlyArray<Entry>>; readonly occurrenceBounds: Map<string, PhysicalSceneBounds | null>; textIndex?: TextIndex }
const indexes = new WeakMap<ReadonlyArray<PhysicalPlanPaint>, Index>()
const hatches = new WeakMap<Geometry, { readonly path: Path2D; readonly x: number; readonly y: number; readonly cosine: number; readonly sine: number }>()
let context: NativeContext | null = null, fontRevision = 0
if (typeof document !== 'undefined') document.fonts?.addEventListener('loadingdone', () => { fontRevision++ })
const nativeContext = (): NativeContext => {
  if (context) return context
  // A one-device-pixel alpha sample is needed only for native glyph coverage;
  // geometry uses native Path2D predicates without painting/readback.
  const canvas = typeof OffscreenCanvas === 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(1, 1)
  canvas.width = canvas.height = 1
  context = canvas.getContext('2d', { willReadFrequently: true }) as NativeContext | null
  if (!context) throw new Error('Native Plan interaction requires Canvas2D path and glyph support')
  return context
}
const bounds = (points: ReadonlyArray<readonly [number, number]>, padding = 0): PhysicalSceneBounds => {
  const min: [number, number, number] = [Infinity, Infinity, 0], max: [number, number, number] = [-Infinity, -Infinity, 0]
  for (const point of points) for (const axis of [0, 1] as const) { min[axis] = Math.min(min[axis], point[axis] - padding); max[axis] = Math.max(max[axis], point[axis] + padding) }
  return { min, max }
}
/** Control-point hulls are conservative for curves; native predicates remain
 * the final geometry oracle. Supplied drawing bounds never become hit shapes. */
const geometryBounds = (primitive: Geometry): PhysicalSceneBounds => {
  const points: Array<readonly [number, number]> = [primitive.bounds.min, primitive.bounds.max]
  if (primitive.kind === 'ellipse') {
    const angle = primitive.rotation * Math.PI / 180, x = Math.hypot(primitive.radii[0] * Math.cos(angle), primitive.radii[1] * Math.sin(angle)), y = Math.hypot(primitive.radii[0] * Math.sin(angle), primitive.radii[1] * Math.cos(angle))
    points.push([primitive.center[0] - x, primitive.center[1] - y], [primitive.center[0] + x, primitive.center[1] + y])
  } else for (const command of primitive.commands) for (let at = 1; at + 1 < command.length; at += 2) points.push([command[at] as number, command[at + 1] as number])
  return bounds(points, primitive.stroke ? (primitive.width ?? 0) / 2 : 0)
}
const localPoint = (frame: PhysicalPlanPickFrame, point: Point): Point | null => {
  const determinant = frame.a * frame.d - frame.b * frame.c
  if (!Number.isFinite(determinant) || determinant === 0) return null
  const x = point.x - frame.e, y = point.y - frame.f
  return { x: (frame.d * x - frame.c * y) / determinant, y: (frame.a * y - frame.b * x) / determinant }
}
const visible = (input: PhysicalPlanPickInput, value: PhysicalSceneBounds): boolean => {
  const { a, b, c, d, e, f } = input.frame, x = (value.min[0] + value.max[0]) / 2, y = (value.min[1] + value.max[1]) / 2, hx = (value.max[0] - value.min[0]) / 2, hy = (value.max[1] - value.min[1]) / 2
  const px = a * x + c * y + e, py = b * x + d * y + f, rx = Math.abs(a) * hx + Math.abs(c) * hy, ry = Math.abs(b) * hx + Math.abs(d) * hy
  return px + rx >= 0 && px - rx <= input.width && py + ry >= 0 && py - ry <= input.height
}
const inRegions = (regions: ReadonlyArray<PhysicalSceneBounds>, point: Point): boolean => !regions.length || regions.some(region => point.x >= region.min[0] && point.x <= region.max[0] && point.y >= region.min[1] && point.y <= region.max[1])
const indexFor = (input: PhysicalPlanPickInput): Index => {
  const commands = physicalPlanPaintCommands(input.scene, input.view, input.scopeId), previous = indexes.get(commands)
  if (previous) return previous
  const objects = new Map(input.scene.objects.map(object => [object.id, object])), entries: Entry[] = [], texts: Array<{ order: number; primitive: Text; owner?: PhysicalSceneObject }> = []
  commands.forEach((command, order) => {
    const primitive = command.kind === 'text' ? command.primitive : command.paint, owner = primitive.occurrenceId ? objects.get(primitive.occurrenceId) : undefined
    if (command.kind === 'text') texts.push({ order, primitive: command.primitive, ...(owner ? { owner } : {}) })
    else entries.push({ order, primitiveId: primitive.id, ...(owner ? { owner } : {}), command, bounds: geometryBounds(command.paint) })
  })
  physicalPlanContinuationPaths(input.scene, input.view, input.scopeId).forEach((marker, at) => { const owner = objects.get(marker.occurrenceId); entries.push({ order: commands.length + at, primitiveId: `continuation/${marker.occurrenceId}`, ...(owner ? { owner } : {}), marker, bounds: bounds([[marker.bounds.min[0], marker.bounds.min[1]], [marker.bounds.max[0], marker.bounds.max[1]]], .08 / 2) }) })
  const owners = new Map<string, Entry[]>()
  for (const entry of entries) if (entry.owner) { const values = owners.get(entry.owner.id) ?? []; values.push(entry); owners.set(entry.owner.id, values) }
  const textOwners = new Set<string>()
  for (const text of texts) if (text.owner) textOwners.add(text.owner.id)
  const value: Index = { owners, textOwners, occurrenceBounds: new Map(), entries, index: createPhysicalSpatialIndex(entries.map(entry => entry.bounds)), texts, regions: physicalScopeRegions(input.scene, input.scopeId ?? undefined) }
  indexes.set(commands, value); return value
}
const textIndexFor = (input: PhysicalPlanPickInput, index: Index): TextIndex => {
  const { a, b, c, d } = input.frame, key = JSON.stringify([a, b, c, d, input.ratio, input.fontFamily, fontRevision])
  if (index.textIndex?.key === key) return index.textIndex
  const ctx = nativeContext(), entries: Entry[] = [], layouts: TextLayout[] = [], determinant = a * d - b * c
  ctx.save()
  try {
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.textBaseline = 'middle'
    for (const item of index.texts) {
      const p = item.primitive, text = physicalPlanTextFrame(p, input.frame), font = `${p.height * text.scale}px ${input.fontFamily}`
      ctx.font = font; ctx.textAlign = p.align === 'middle' ? 'center' : p.align
      const metrics = ctx.measureText(p.text), halo = p.halo ? (p.haloWidth ?? 0) * text.scale : 0
      const box = { left: -metrics.actualBoundingBoxLeft - halo, right: metrics.actualBoundingBoxRight + halo, top: -metrics.actualBoundingBoxAscent - halo, bottom: metrics.actualBoundingBoxDescent + halo }, cosine = Math.cos(text.angle), sine = Math.sin(text.angle)
      const corners = [[box.left, box.top], [box.left, box.bottom], [box.right, box.top], [box.right, box.bottom]].map(([x, y]) => {
        const dx = cosine * x! - sine * y!, dy = sine * x! + cosine * y!
        return [p.anchor[0] + (d * dx - c * dy) / determinant, p.anchor[1] + (a * dy - b * dx) / determinant] as const
      })
      entries.push({ order: item.order, primitiveId: p.id, ...(item.owner ? { owner: item.owner } : {}), command: { kind: 'text', primitive: p }, bounds: bounds(corners) }); layouts.push({ font, box, angle: text.angle })
    }
  } finally { ctx.restore() }
  const value = { key, entries, layouts, index: createPhysicalSpatialIndex(entries.map(entry => entry.bounds)) }; index.textIndex = value; return value
}
const hatchPath = (primitive: Geometry) => {
  const previous = hatches.get(primitive); if (previous) return previous
  const hatch = primitive.hatch!, box = primitive.bounds, x = (box.min[0] + box.max[0]) / 2, y = (box.min[1] + box.max[1]) / 2, radius = Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1]) / 2, angle = hatch.angle * Math.PI / 180, path = new Path2D()
  for (let at = -Math.ceil(radius / hatch.spacing) * hatch.spacing; at <= radius; at += hatch.spacing) { path.moveTo(-radius, at); path.lineTo(radius, at) }
  const value = { path, x, y, cosine: Math.cos(angle), sine: Math.sin(angle) }; hatches.set(primitive, value); return value
}
const glyphContains = (input: PhysicalPlanPickInput, primitive: Text, layout: TextLayout, point: Point): boolean => {
  const ctx = nativeContext(), text = physicalPlanTextFrame(primitive, input.frame), ratio = input.ratio, cosine = Math.cos(layout.angle), sine = Math.sin(layout.angle)
  ctx.save()
  try {
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, 1, 1)
    ctx.setTransform(ratio * cosine, ratio * sine, -ratio * sine, ratio * cosine, ratio * text.x - Math.floor(point.x * ratio), ratio * text.y - Math.floor(point.y * ratio))
    ctx.font = layout.font; ctx.textAlign = primitive.align === 'middle' ? 'center' : primitive.align; ctx.textBaseline = 'middle'; ctx.globalAlpha = 1
    if (primitive.halo) { ctx.lineWidth = (primitive.haloWidth ?? 0) * text.scale * 2; ctx.strokeText(primitive.text, 0, 0) }
    ctx.fillText(primitive.text, 0, 0)
    return ctx.getImageData(0, 0, 1, 1).data[3]! > 0
  } finally { ctx.restore() }
}
const ownerHit = (entry: Entry): PhysicalPlanInkHit => ({ primitiveId: entry.primitiveId, ...(entry.owner ? { ownerOccurrenceId: entry.owner.id } : {}), ...(entry.owner?.subjectIds.length ? { occurrenceId: entry.owner.id } : {}), occluded: !entry.owner?.subjectIds.length })

/** Native ink hit tests preserve painter order, holes, clipping and glyphs.
 * Bounds are broadphase only. No solid triangulation or GPU upload is needed. */
export const pickPhysicalPlan = (input: PhysicalPlanPickInput, point: Point): PhysicalPlanInkHit | null => {
  if (input.view.mode !== '2d' || !(input.ratio > 0) || point.x < 0 || point.y < 0 || point.x >= input.width || point.y >= input.height) return null
  const local = localPoint(input.frame, point); if (!local) return null
  const scale = Math.sqrt(Math.abs(input.frame.a * input.frame.d - input.frame.b * input.frame.c)); if (!(scale > 0)) return null
  const index = indexFor(input), texts = textIndexFor(input, index), candidates: Array<{ entry: Entry; text?: TextLayout }> = [], padding = (.5 + 1 / input.ratio) / scale
  const query = { min: [local.x - padding, local.y - padding, 0] as [number, number, number], max: [local.x + padding, local.y + padding, 0] as [number, number, number] }
  // Ray SAH leaves may contain several primitives. Their union is conservative
  // for the leaf, not evidence that every member can cover this query. Reject
  // individual bounds before invoking the unchanged native ink/glyph oracle.
  visitPhysicalSpatialBounds(index.index, query, at => { const entry = index.entries[at]!; if (physicalSpatialBoundsOverlap(entry.bounds, query)) candidates.push({ entry }) })
  visitPhysicalSpatialBounds(texts.index, query, at => { const entry = texts.entries[at]!; if (physicalSpatialBoundsOverlap(entry.bounds, query)) candidates.push({ entry, text: texts.layouts[at]! }) })
  candidates.sort((a, b) => b.entry.order - a.entry.order)
  const ctx = nativeContext(); ctx.save()
  try {
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.lineJoin = 'round'; ctx.lineCap = 'round'
    for (const { entry, text } of candidates) {
      if (entry.owner) {
        const opacity = physicalArchitectureOpacity(entry.owner, input.view)
        if (opacity === 0 || !entry.owner.subjectIds.length && opacity < 1) continue
      }
      if (entry.marker) {
        if (!visible(input, entry.marker.bounds) || !inRegions(index.regions, local)) continue
        ctx.lineWidth = .08; ctx.setLineDash([])
        if (ctx.isPointInStroke(entry.marker.path, local.x, local.y)) return ownerHit(entry)
        continue
      }
      const command = entry.command!
      if (command.kind === 'text') {
        const p = command.primitive
        if (visible(input, { min: [...p.bounds.min, 0], max: [...p.bounds.max, 0] }) && glyphContains(input, p, text!, point)) return ownerHit(entry)
        continue
      }
      const p = command.paint, alpha = p.opacity ?? 1
      if (alpha === 0 || !visible(input, { min: [...command.bounds.min, 0], max: [...command.bounds.max, 0] }) || command.clip && !inRegions(index.regions, local)) continue
      let hit = Boolean(p.fill && ctx.isPointInPath(command.path, local.x, local.y, p.fillRule ?? 'nonzero'))
      if (!hit && p.hatch && ctx.isPointInPath(command.path, local.x, local.y, p.fillRule ?? 'nonzero')) {
        const hatch = hatchPath(p), dx = local.x - hatch.x, dy = local.y - hatch.y
        ctx.lineWidth = p.hatch.width; ctx.setLineDash([])
        hit = ctx.isPointInStroke(hatch.path, hatch.cosine * dx + hatch.sine * dy, -hatch.sine * dx + hatch.cosine * dy)
      }
      if (!hit && p.stroke) { ctx.lineWidth = p.width ?? 1 / scale; ctx.setLineDash(p.dash ?? []); hit = ctx.isPointInStroke(command.path, local.x, local.y) }
      if (hit && (entry.owner?.subjectIds.length || alpha === 1)) return ownerHit(entry)
    }
  } finally { ctx.restore() }
  return null
}

/** Visible authored footprint for status anchors/camera focus, never a hit box. */
export const physicalPlanOccurrenceBounds = (input: PhysicalPlanPickInput, occurrenceId: string): PhysicalSceneBounds | null => {
  const index = indexFor(input)
  if (index.occurrenceBounds.has(occurrenceId)) return index.occurrenceBounds.get(occurrenceId)!
  const geometry = index.owners.get(occurrenceId)
  // Absence is an immutable command-roster fact. Do not construct/revisit all
  // scale-sensitive glyph metrics for an occurrence with no authored Plan ink.
  if (!geometry?.length && !index.textOwners.has(occurrenceId)) { index.occurrenceBounds.set(occurrenceId, null); return null }
  const matches = geometry?.length ? geometry : textIndexFor(input, index).entries.filter(entry => entry.owner?.id === occurrenceId)
  if (!matches.length) return null
  const points: Array<readonly [number, number]> = []
  for (const entry of matches) {
    const regions = entry.marker || entry.command?.kind === 'geometry' && entry.command.clip ? index.regions : []
    if (!regions.length) points.push([entry.bounds.min[0], entry.bounds.min[1]], [entry.bounds.max[0], entry.bounds.max[1]])
    else for (const region of regions) {
      const min = [Math.max(entry.bounds.min[0], region.min[0]), Math.max(entry.bounds.min[1], region.min[1])] as const, max = [Math.min(entry.bounds.max[0], region.max[0]), Math.min(entry.bounds.max[1], region.max[1])] as const
      if (min[0] <= max[0] && min[1] <= max[1]) points.push(min, max)
    }
  }
  const value = points.length ? bounds(points) : null
  if (geometry?.length) index.occurrenceBounds.set(occurrenceId, value)
  return value
}
