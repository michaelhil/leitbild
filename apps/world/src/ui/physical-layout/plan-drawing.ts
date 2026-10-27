import type { PackPhysicalScene, PhysicalPlanPrimitive, PhysicalSceneBounds } from '../../core/packs/scene.ts'
import type { PhysicalScenePalette, PhysicalSceneView, PhysicalSubjectStyle } from '../map/physical-scene/types.ts'
import { physicalScopeMembers } from '../map/physical-scene/scopes.ts'

type Point = { readonly x: number; readonly y: number }
type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
const selections = new WeakMap<PackPhysicalScene, Map<string, ReadonlyArray<PhysicalPlanPrimitive>>>()
const sceneObjects = new WeakMap<PackPhysicalScene, ReadonlyMap<string, PackPhysicalScene['objects'][number]>>()
const paletteInks = new WeakMap<PhysicalScenePalette, ReadonlyMap<string, string>>()
/** Selection and compilation live exactly as long as the immutable delivery. */
export const visiblePhysicalPlanDrawing = (scene: PackPhysicalScene, view: PhysicalSceneView, scopeId: string | null): ReadonlyArray<PhysicalPlanPrimitive> => {
  if (view.mode !== '2d') return []
  const floor = scene.planDrawing?.views.find(floor => floor.levelId === view.levelId)
  if (!floor) return []
  const hidden = view.hiddenLayerIds ?? scene.layers?.filter(layer => !layer.defaultVisible).map(layer => layer.id) ?? []
  const key = JSON.stringify([view.levelId, scopeId, [...hidden].sort()])
  let cache = selections.get(scene); if (!cache) { cache = new Map(); selections.set(scene, cache) }
  const cached = cache.get(key); if (cached) return cached
  const members = scopeId === null ? null : physicalScopeMembers(scene.scopes ?? [], scopeId), hiddenSet = new Set(hidden)
  const result = floor.primitives.filter(primitive => (!primitive.layerId || !hiddenSet.has(primitive.layerId)) && (members === null || primitive.scopeIds.some(id => members.has(id))))
  cache.set(key, result); return result
}
export const physicalPlanDrawingBounds = (scene: PackPhysicalScene, view: PhysicalSceneView, scopeId: string | null): PhysicalSceneBounds | null => {
  const primitives = visiblePhysicalPlanDrawing(scene, view, scopeId)
  if (!primitives.length) return null
  const min: [number, number, number] = [Infinity, Infinity, 0], max: [number, number, number] = [-Infinity, -Infinity, 0]
  for (const primitive of primitives) for (const axis of [0, 1] as const) { min[axis] = Math.min(min[axis], primitive.bounds.min[axis]); max[axis] = Math.max(max[axis], primitive.bounds.max[axis]) }
  return { min, max }
}
export const physicalPlanFrame = (points: ReadonlyArray<Point>) => {
  if (points.length !== 3) return null
  const [origin, x, y] = points as [Point, Point, Point]
  const frame = { a: x.x - origin.x, b: x.y - origin.y, c: y.x - origin.x, d: y.y - origin.y, e: origin.x, f: origin.y }
  const determinant = frame.a * frame.d - frame.b * frame.c
  return Object.values(frame).every(Number.isFinite) && determinant !== 0 ? frame : null
}
const paths = new WeakMap<PhysicalPlanPrimitive, Path2D>()
const pathFor = (primitive: Exclude<PhysicalPlanPrimitive, { kind: 'text' }>): Path2D => {
  const cached = paths.get(primitive); if (cached) return cached
  const path = new Path2D()
  if (primitive.kind === 'ellipse') path.ellipse(...primitive.center, ...primitive.radii, primitive.rotation * Math.PI / 180, 0, Math.PI * 2)
  else for (const command of primitive.commands) {
    switch (command[0]) {
      case 'M': path.moveTo(command[1], command[2]); break
      case 'L': path.lineTo(command[1], command[2]); break
      case 'Q': path.quadraticCurveTo(command[1], command[2], command[3], command[4]); break
      case 'C': path.bezierCurveTo(command[1], command[2], command[3], command[4], command[5], command[6]); break
      case 'Z': path.closePath(); break
    }
  }
  paths.set(primitive, path); return path
}
const intersects = (a: Rect, b: Rect) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
const rgb = (color: readonly number[]) => `rgb(${color.map(channel => channel * 255).join(' ')})`
/** One affine map transform per scene/frame. Curves, joins, line weights and
 * hatches remain native vectors; no vertex-by-vertex map projection or raster asset. */
export const drawPhysicalPlanDrawing = (context: CanvasRenderingContext2D, input: {
  readonly scene: PackPhysicalScene; readonly view: PhysicalSceneView; readonly scopeId: string | null
  readonly project: (points: ReadonlyArray<readonly [number, number, number]>) => ReadonlyArray<Point>
  readonly width: number; readonly height: number; readonly ratio: number
  readonly palette: PhysicalScenePalette; readonly fontFamily: string
  readonly status: ReadonlyMap<string, PhysicalSubjectStyle>
}): void => {
  const primitives = visiblePhysicalPlanDrawing(input.scene, input.view, input.scopeId)
  if (!primitives.length) return
  const frame = physicalPlanFrame(input.project([[0, 0, 0], [1, 0, 0], [0, 1, 0]])); if (!frame) return
  const { a, b, c, d, e, f } = frame, scale = Math.sqrt(Math.abs(a * d - b * c)), ratio = input.ratio
  const project = (x: number, y: number): Point => ({ x: a * x + c * y + e, y: b * x + d * y + f })
  const viewport: Rect = { x: 0, y: 0, width: input.width, height: input.height }
  let inks = paletteInks.get(input.palette)
  if (!inks) { inks = new Map(Object.entries(input.palette.planMaterials ?? input.palette.materials).map(([role, color]) => [role, rgb(color)])); paletteInks.set(input.palette, inks) }
  const ink = (role: string) => { const value = inks.get(role); if (!value) throw new Error(`Unknown architectural Plan material: ${role}`); return value }
  let objects = sceneObjects.get(input.scene)
  if (!objects) { objects = new Map(input.scene.objects.map(object => [object.id, object])); sceneObjects.set(input.scene, objects) }
  const accents = new Map<string, { readonly color: string; readonly alpha: number } | null>()
  const accentFor = (id: string) => {
    if (accents.has(id)) return accents.get(id)
    const states = objects.get(id)?.subjectIds.map(id => input.status.get(id)) ?? [], state = states[0]
    const value = state?.color && state.emphasis > 0 && states.every(other => other?.emphasis === state.emphasis && JSON.stringify(other.color) === JSON.stringify(state.color)) ? { color: rgb(state.color), alpha: state.emphasis } : null
    accents.set(id, value); return value
  }
  context.save(); context.setTransform(ratio * a, ratio * b, ratio * c, ratio * d, ratio * e, ratio * f)
  context.lineJoin = 'round'; context.lineCap = 'round'
  for (const primitive of primitives) {
    const p = primitive.bounds, corners = [project(...p.min), project(p.max[0], p.min[1]), project(...p.max), project(p.min[0], p.max[1])]
    const left = Math.min(...corners.map(point => point.x)), top = Math.min(...corners.map(point => point.y))
    if (!intersects({ x: left, y: top, width: Math.max(...corners.map(point => point.x)) - left, height: Math.max(...corners.map(point => point.y)) - top }, viewport)) continue
    if (primitive.kind === 'text') {
      const anchor = project(...primitive.anchor), rotation = primitive.rotation * Math.PI / 180
      // Glyphs are screen-upright even when the physical XY basis is reflected
      // by the map's north-up projection. Only their source baseline rotates.
      let angle = Math.atan2(b * Math.cos(rotation) + d * Math.sin(rotation), a * Math.cos(rotation) + c * Math.sin(rotation))
      if (angle > Math.PI / 2) angle -= Math.PI
      if (angle < -Math.PI / 2) angle += Math.PI
      context.save(); context.setTransform(ratio, 0, 0, ratio, anchor.x * ratio, anchor.y * ratio); context.rotate(angle)
      context.font = `${primitive.height * scale}px ${input.fontFamily}`; context.textAlign = primitive.align === 'middle' ? 'center' : primitive.align; context.textBaseline = 'middle'
      if (primitive.halo) { context.strokeStyle = ink(primitive.halo); context.lineWidth = (primitive.haloWidth ?? 0) * scale * 2; context.strokeText(primitive.text, 0, 0) }
      context.fillStyle = ink(primitive.material); context.fillText(primitive.text, 0, 0); context.restore(); continue
    }
    const path = pathFor(primitive), fillRule = primitive.fillRule ?? 'nonzero'
    context.save(); context.globalAlpha = primitive.opacity ?? 1; context.setLineDash(primitive.dash ?? [])
    if (primitive.fill) { context.fillStyle = ink(primitive.fill); context.fill(path, fillRule) }
    if (primitive.hatch) {
      const hatch = primitive.hatch
      context.save(); context.clip(path, fillRule); context.strokeStyle = ink(hatch.material); context.lineWidth = hatch.width; context.setLineDash([])
      const centerX = (p.min[0] + p.max[0]) / 2, centerY = (p.min[1] + p.max[1]) / 2, radius = Math.hypot(p.max[0] - p.min[0], p.max[1] - p.min[1]) / 2
      context.translate(centerX, centerY); context.rotate(hatch.angle * Math.PI / 180); context.beginPath()
      for (let offset = -Math.ceil(radius / hatch.spacing) * hatch.spacing; offset <= radius; offset += hatch.spacing) { context.moveTo(-radius, offset); context.lineTo(radius, offset) }
      context.stroke(); context.restore()
    }
    if (primitive.stroke) {
      context.strokeStyle = ink(primitive.stroke); context.lineWidth = primitive.width ?? 1 / scale; context.stroke(path)
      const accent = input.view.live && primitive.occurrenceId && primitive.depiction !== 'above' && primitive.depiction !== 'below' ? accentFor(primitive.occurrenceId) : null
      if (accent) {
        context.globalAlpha = accent.alpha; context.strokeStyle = accent.color; context.stroke(path)
      }
    }
    context.restore()
  }
  context.restore()
}
