import { compilePhysicalPlanPaint } from '../../../src/ui/physical-layout/plan-paint-stream.ts'
import type { PackPhysicalScene, PhysicalPlanPrimitive } from '../../../src/core/packs/scene.ts'
import { drawPhysicalPlanDrawing, visiblePhysicalPlanDrawing } from '../../../src/ui/physical-layout/plan-drawing.ts'
import { drawPhysicalPlanDrawing as drawOrdered } from './plan-ordered-reference.ts'
import { physicalLayoutPalette } from '../../../src/ui/physical-layout/palette.ts'
import { defaultPhysicalSceneView } from '../../../src/ui/map/physical-scene/types.ts'
const scene = await (await fetch('/fixture.json')).json() as PackPhysicalScene
const current = document.querySelector<HTMLCanvasElement>('#current')!, reference = document.querySelector<HTMLCanvasElement>('#reference')!, palette = physicalLayoutPalette(document.body)
const context = current.getContext('2d', { willReadFrequently: true })!, orderedContext = reference.getContext('2d', { willReadFrequently: true })!
const scopeId = 'area/turbine-island', width = 1280, height = 920
current.width = reference.width = width; current.height = reference.height = height
;(window as any).planRasterComparison = {
  async phase(levelId: string, layers: 'all' | 'without-utilities' | 'without-allowances', alert: boolean, camera: 'home' | 'pan' | 'rotate', phaseScene = scene) {
    const hidden = layers === 'all' ? [] : [layers === 'without-utilities' ? 'utility-routes' : 'plan-allowances']
    const view = { ...defaultPhysicalSceneView(scene.levels), mode: '2d' as const, levelId, live: alert, hiddenLayerIds: hidden }
    // Match the original authored sheet extent in metres, including its inset.
    const scale = Math.min(width / 103, height / 74) * (camera === 'pan' ? 1.25 : 1), angle = camera === 'rotate' ? .27 : 0
    const c = Math.cos(angle), s = Math.sin(angle), center = [-.1, -4], dx = camera === 'pan' ? 73.25 : 0, dy = camera === 'pan' ? -42.5 : 0
    const project = (points: ReadonlyArray<readonly [number, number, number]>) => points.map(p => ({ x: width / 2 + dx + (c * (p[0] - center[0]!) + s * (p[1] - center[1]!)) * scale, y: height / 2 + dy + (s * (p[0] - center[0]!) - c * (p[1] - center[1]!)) * scale }))
    const status = new Map(alert ? scene.objects.flatMap(object => object.subjectIds.map(id => [id, { color: [.91, .17, .2] as const, emphasis: .65 }] as const)) : [])
    for (const [ctx, painter] of [[context, drawPhysicalPlanDrawing], [orderedContext, drawOrdered]] as const) {
      ctx.resetTransform(); ctx.clearRect(0, 0, width, height); ctx.fillStyle = '#faf9f4'; ctx.fillRect(0, 0, width, height)
      painter(ctx, { scene: phaseScene, view, scopeId, project, width, height, ratio: 1, palette, fontFamily: 'Arial, Helvetica, sans-serif', status })
    }
    const a = context.getImageData(0, 0, width, height).data, b = orderedContext.getImageData(0, 0, width, height).data
    let changedPixels = 0, maxChannelDifference = 0
    for (let i = 0; i < a.length; i += 4) { let changed = false; for (let channel = 0; channel < 4; channel++) { const delta = Math.abs(a[i + channel]! - b[i + channel]!); if (delta) changed = true; maxChannelDifference = Math.max(maxChannelDifference, delta) }; if (changed) changedPixels++ }
    document.querySelector('#caption')!.textContent = `${levelId} · ${layers} · ${alert ? 'controlled status' : 'architectural materials'} · ${camera} · source ${scene.revision.slice(0, 12)}`
    return { levelId, layers, alert, camera, changedPixels, maxChannelDifference, sourcePrimitives: visiblePhysicalPlanDrawing(phaseScene, view, scopeId).length, width, height, passed: changedPixels === 0 }
  },
  async explain(levelId: string) {
    type Geometry = Exclude<PhysicalPlanPrimitive, { kind: 'text' }>
    const view = { ...defaultPhysicalSceneView(scene.levels), mode: '2d' as const, levelId, hiddenLayerIds: [] }, primitives = visiblePhysicalPlanDrawing(scene, view, scopeId)
    const ownership = new WeakMap<Path2D, Geometry[]>(), add = Path2D.prototype.addPath
    Path2D.prototype.addPath = function(path, transform) { ownership.set(this, [...(ownership.get(this) ?? []), ...(ownership.get(path) ?? [])]); add.call(this, path, transform) }
    const pathFor = (primitive: Geometry) => {
      const path = new Path2D(); ownership.set(path, [primitive])
      if (primitive.kind === 'ellipse') path.ellipse(...primitive.center, ...primitive.radii, primitive.rotation * Math.PI / 180, 0, Math.PI * 2)
      else for (const command of primitive.commands) {
        if (command[0] === 'M') path.moveTo(command[1], command[2])
        else if (command[0] === 'L') path.lineTo(command[1], command[2])
        else if (command[0] === 'Q') path.quadraticCurveTo(command[1], command[2], command[3], command[4])
        else if (command[0] === 'C') path.bezierCurveTo(command[1], command[2], command[3], command[4], command[5], command[6])
        else path.closePath()
      }
      return path
    }
    let stream
    try { stream = compilePhysicalPlanPaint(primitives, new Map(scene.objects.map(object => [object.id, object])), pathFor) } finally { Path2D.prototype.addPath = add }
    const differences = []
    for (const command of stream) {
      const group = command.kind === 'geometry' ? ownership.get(command.path) : undefined
      if (!group || group.length < 2) continue
      const subset = { ...scene, planDrawing: { views: [{ levelId, bounds: scene.planDrawing!.views.find(view => view.levelId === levelId)!.bounds, primitives: group }] } }
      const result = await this.phase(levelId, 'all', false, 'home', subset)
      if (!result.passed) differences.push({ ids: group.map(p => p.id), count: group.length, bounds: command.kind === 'geometry' ? command.bounds : null, result, paints: group.map(p => ({ bounds: p.bounds, fill: p.fill, stroke: p.stroke, width: p.width })) })
    }
    return { levelId, groups: stream.length, differences }
  },
  async original(levelId: string) {
    await this.phase(levelId, 'all', false, 'home')
    const object = document.querySelector<HTMLImageElement>('#original')!
    document.body.classList.add('original')
    await new Promise<void>((resolve, reject) => { object.onload = () => resolve(); object.onerror = () => reject(Error('Original authored Plan did not load')); object.src = `/original-${levelId}.svg` })
    return { levelId, sourceRevision: scene.revision, nativeViewport: { width, height }, reference: 'Original authored SVG, original complete sheet extent; native explicit Plan uses identical metre scale and extent' }
  },
}
