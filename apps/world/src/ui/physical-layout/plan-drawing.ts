import type { PackPhysicalScene, PhysicalPlanPrimitive, PhysicalSceneBounds } from '../../core/packs/scene.ts'
import type { PhysicalScenePalette, PhysicalSceneView, PhysicalSubjectStyle } from '../map/physical-scene/types.ts'
import { physicalScopeMembers } from '../map/physical-scene/scopes.ts'
import { physicalScopeRegions } from '../map/physical-scene/scope-regions.ts'
import { physicalPlanContinuations } from './plan-continuations.ts'
import { compilePhysicalPlanPaint, type PhysicalPlanPaint } from './plan-paint-stream.ts'

type Point = { readonly x: number; readonly y: number }
const selections = new WeakMap<PackPhysicalScene, { readonly key: string; readonly primitives: ReadonlyArray<PhysicalPlanPrimitive> }>()
const sceneObjects = new WeakMap<PackPhysicalScene, ReadonlyMap<string, PackPhysicalScene['objects'][number]>>()
const paletteInks = new WeakMap<PhysicalScenePalette, ReadonlyMap<string, string>>()
const paintStreams = new WeakMap<ReadonlyArray<PhysicalPlanPrimitive>, ReadonlyArray<PhysicalPlanPaint>>()
const objectRoster = (scene: PackPhysicalScene) => {
  let objects = sceneObjects.get(scene)
  if (!objects) { objects = new Map(scene.objects.map(object => [object.id, object])); sceneObjects.set(scene, objects) }
  return objects
}
const scopePaths = new WeakMap<PackPhysicalScene, { readonly scopeId: string | null; readonly regions: ReadonlyArray<PhysicalSceneBounds>; readonly path: Path2D }>()
/** Selection and compilation live exactly as long as the immutable delivery. */
export const visiblePhysicalPlanDrawing = (scene: PackPhysicalScene, view: PhysicalSceneView, scopeId: string | null): ReadonlyArray<PhysicalPlanPrimitive> => {
  if (view.mode !== '2d') return []
  const floor = scene.planDrawing?.views.find(floor => floor.levelId === view.levelId)
  if (!floor) return []
  const hidden = view.hiddenLayerIds ?? scene.layers?.filter(layer => !layer.defaultVisible).map(layer => layer.id) ?? []
  const key = JSON.stringify([view.levelId, scopeId, [...hidden].sort()])
  const cached = selections.get(scene); if (cached?.key === key) return cached.primitives
  const members = scopeId === null ? null : physicalScopeMembers(scene.scopes ?? [], scopeId), hiddenSet = new Set(hidden)
  const objects = objectRoster(scene), regions = physicalScopeRegions(scene, scopeId ?? undefined)
  const result = floor.primitives.filter(primitive => (!primitive.layerId || !hiddenSet.has(primitive.layerId)) && (members === null || (primitive.occurrenceId && objects.get(primitive.occurrenceId)?.clipToScope ? regions.some(region => primitive.bounds.min[0] <= region.max[0] && primitive.bounds.max[0] >= region.min[0] && primitive.bounds.min[1] <= region.max[1] && primitive.bounds.max[1] >= region.min[1]) : primitive.scopeIds.some(id => members.has(id)))))
  selections.set(scene, { key, primitives: result }); return result
}
export const physicalPlanDrawingBounds = (scene: PackPhysicalScene, view: PhysicalSceneView, scopeId: string | null): PhysicalSceneBounds | null => {
  const primitives = visiblePhysicalPlanDrawing(scene, view, scopeId)
  if (!primitives.length) return null
  const min: [number, number, number] = [Infinity, Infinity, 0], max: [number, number, number] = [-Infinity, -Infinity, 0]
  const objects = objectRoster(scene), regions = physicalScopeRegions(scene, scopeId ?? undefined)
  for (const primitive of primitives) {
    const clipped = regions.length && primitive.occurrenceId && objects.get(primitive.occurrenceId)?.clipToScope
    const pieces = clipped ? regions.map(region => ({ min: [Math.max(primitive.bounds.min[0], region.min[0]), Math.max(primitive.bounds.min[1], region.min[1])], max: [Math.min(primitive.bounds.max[0], region.max[0]), Math.min(primitive.bounds.max[1], region.max[1])] })).filter(piece => piece.min.every((value, axis) => value <= piece.max[axis]!)) : [primitive.bounds]
    for (const piece of pieces) for (const axis of [0, 1] as const) { min[axis] = Math.min(min[axis], piece.min[axis]!); max[axis] = Math.max(max[axis], piece.max[axis]!) }
  }
  return min.every(Number.isFinite) ? { min, max } : null
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
const rgb = (color: readonly number[]) => `rgb(${color.map(channel => channel * 255).join(' ')})`
/** One affine map transform and a retained native paint stream per scene.
 * Each source path keeps its original submission and antialiasing. Canvas state
 * changes only when its value changes; no per-primitive save/restore cycle. */
const continuationPaths = new WeakMap<ReadonlyArray<PhysicalPlanPrimitive>, ReadonlyArray<{ path: Path2D; material: string; occurrenceId: string }>>()
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
  const aa = Math.abs(a), ab = Math.abs(b), ac = Math.abs(c), ad = Math.abs(d)
  const visible = (bounds: PhysicalPlanPrimitive['bounds']) => {
    const x = (bounds.min[0] + bounds.max[0]) / 2, y = (bounds.min[1] + bounds.max[1]) / 2
    const hx = (bounds.max[0] - bounds.min[0]) / 2, hy = (bounds.max[1] - bounds.min[1]) / 2
    const px = a * x + c * y + e, py = b * x + d * y + f, rx = aa * hx + ac * hy, ry = ab * hx + ad * hy
    return px + rx >= 0 && px - rx <= input.width && py + ry >= 0 && py - ry <= input.height
  }
  let inks = paletteInks.get(input.palette)
  if (!inks) { inks = new Map(Object.entries(input.palette.planMaterials ?? input.palette.materials).map(([role, color]) => [role, rgb(color)])); paletteInks.set(input.palette, inks) }
  const ink = (role: string) => { const value = inks.get(role); if (!value) throw new Error('Unknown architectural Plan material: ' + role); return value }
  const objects = objectRoster(input.scene)
  let stream = paintStreams.get(primitives)
  if (!stream) { stream = compilePhysicalPlanPaint(primitives, objects, pathFor); paintStreams.set(primitives, stream) }
  let scope = scopePaths.get(input.scene)
  if (!scope || scope.scopeId !== input.scopeId) {
    const regions = physicalScopeRegions(input.scene, input.scopeId ?? undefined), path = new Path2D()
    for (const region of regions) path.rect(region.min[0], region.min[1], region.max[0] - region.min[0], region.max[1] - region.min[1])
    scope = { scopeId: input.scopeId, regions, path }; scopePaths.set(input.scene, scope)
  }
  const accents = new Map<string, { readonly color: string; readonly alpha: number } | null>()
  const accentFor = (id: string) => {
    if (accents.has(id)) return accents.get(id)
    const states = objects.get(id)?.subjectIds.map(id => input.status.get(id)) ?? [], state = states[0]
    const value = state?.color && state.emphasis > 0 && states.every(other => other?.emphasis === state.emphasis && JSON.stringify(other.color) === JSON.stringify(state.color)) ? { color: rgb(state.color), alpha: state.emphasis } : null
    accents.set(id, value); return value
  }
  let stroke: string | null = null, fill: string | null = null, width: number | null = null, alpha: number | null = null, dash: string | null = null, font: string | null = null, align: string | null = null
  let world = false, clipped = false
  const worldTransform = () => { if (!world) { context.setTransform(ratio * a, ratio * b, ratio * c, ratio * d, ratio * e, ratio * f); world = true } }
  const strokeInk = (value: string) => { if (stroke !== value) { context.strokeStyle = value; stroke = value } }
  const fillInk = (value: string) => { if (fill !== value) { context.fillStyle = value; fill = value } }
  const lineWidth = (value: number) => { if (width !== value) { context.lineWidth = value; width = value } }
  const opacity = (value: number) => { if (alpha !== value) { context.globalAlpha = value; alpha = value } }
  const invalidState = () => { stroke = fill = dash = font = align = null; width = alpha = null }
  const setClip = (value: boolean) => {
    if (value === clipped) return
    if (clipped) { context.restore(); clipped = false; world = true; invalidState() }
    if (value) { worldTransform(); context.save(); context.clip(scope.path); clipped = true }
  }
  context.save()
  try {
    worldTransform(); context.lineJoin = 'round'; context.lineCap = 'round'; context.textBaseline = 'middle'
    for (const command of stream) {
      if (!visible(command.kind === 'text' ? command.primitive.bounds : command.bounds)) continue
      setClip(command.kind === 'geometry' && command.clip && scope.regions.length > 0)
      if (command.kind === 'text') {
        const p = command.primitive, x = a * p.anchor[0] + c * p.anchor[1] + e, y = b * p.anchor[0] + d * p.anchor[1] + f, rotation = p.rotation * Math.PI / 180
        let angle = Math.atan2(b * Math.cos(rotation) + d * Math.sin(rotation), a * Math.cos(rotation) + c * Math.sin(rotation))
        if (angle > Math.PI / 2) angle -= Math.PI
        if (angle < -Math.PI / 2) angle += Math.PI
        const cosine = Math.cos(angle), sine = Math.sin(angle)
        context.setTransform(ratio * cosine, ratio * sine, -ratio * sine, ratio * cosine, ratio * x, ratio * y); world = false
        const nextFont = String(p.height * scale) + 'px ' + input.fontFamily, nextAlign = p.align === 'middle' ? 'center' : p.align
        if (font !== nextFont) { context.font = nextFont; font = nextFont }
        if (align !== nextAlign) { context.textAlign = nextAlign; align = nextAlign }
        opacity(1)
        if (p.halo) { strokeInk(ink(p.halo)); lineWidth((p.haloWidth ?? 0) * scale * 2); context.strokeText(p.text, 0, 0) }
        fillInk(ink(p.material)); context.fillText(p.text, 0, 0)
        continue
      }
      worldTransform()
      const p = command.paint, path = command.path, fillRule = p.fillRule ?? 'nonzero'
      opacity(p.opacity ?? 1)
      if (dash !== command.dashKey) { context.setLineDash(p.dash ?? []); dash = command.dashKey }
      if (p.fill) { fillInk(ink(p.fill)); context.fill(path, fillRule) }
      if (p.hatch) {
        const hatch = p.hatch, bounds = command.bounds, centerX = (bounds.min[0] + bounds.max[0]) / 2, centerY = (bounds.min[1] + bounds.max[1]) / 2, radius = Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1]) / 2
        context.save(); context.clip(path, fillRule); context.strokeStyle = ink(hatch.material); context.lineWidth = hatch.width; context.setLineDash([])
        context.translate(centerX, centerY); context.rotate(hatch.angle * Math.PI / 180); context.beginPath()
        for (let at = -Math.ceil(radius / hatch.spacing) * hatch.spacing; at <= radius; at += hatch.spacing) { context.moveTo(-radius, at); context.lineTo(radius, at) }
        context.stroke(); context.restore()
      }
      if (p.stroke) {
        strokeInk(ink(p.stroke)); lineWidth(p.width ?? 1 / scale); context.stroke(path)
        const accent = input.view.live && command.occurrenceId && p.depiction !== 'above' && p.depiction !== 'below' ? accentFor(command.occurrenceId) : null
        if (accent) { opacity(accent.alpha); strokeInk(accent.color); context.stroke(path) }
      }
    }
    setClip(false); worldTransform()
    if (scope.regions.length) {
      let markers = continuationPaths.get(primitives)
      if (!markers) {
        const built: Array<{ path: Path2D; material: string; occurrenceId: string }> = [], traced = new Set(stream.flatMap(command => command.kind === 'geometry' && command.clip && command.occurrenceId ? [command.occurrenceId] : []))
        for (const id of traced) {
          const object = objects.get(id)!, route = object.spatialPath; if (!route) continue
          const floor = object.levelId === 'site' ? undefined : object.inspectionLevels?.find(floor => floor.levelId === input.view.levelId), path = new Path2D(), length = route.radius * 3 + .16
          for (const { point: [x, y], outward: [dx, dy] } of physicalPlanContinuations(route.points, scope.regions, floor)) {
            path.moveTo(x - dx * length - dy * length / 2, y - dy * length + dx * length / 2); path.lineTo(x, y); path.lineTo(x - dx * length + dy * length / 2, y - dy * length - dx * length / 2)
          }
          built.push({ path, material: object.material ?? 'pipe', occurrenceId: id })
        }
        markers = built; continuationPaths.set(primitives, markers)
      }
      setClip(true); opacity(1); context.setLineDash([]); dash = '[]'; lineWidth(.08)
      for (const marker of markers) { const accent = input.view.live ? accentFor(marker.occurrenceId) : null; strokeInk(accent?.color ?? ink(marker.material)); opacity(accent?.alpha ?? 1); context.stroke(marker.path) }
    }
  } finally { if (clipped) context.restore(); context.restore() }
}
