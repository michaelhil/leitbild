// Test-only genuinely separated surface diagnostic. Production scenes, preparation,
// viewports, renderer and picker remain unchanged.
import { Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl'
import type { PackPhysicalScene, PackPhysicalSceneDescriptor } from '../../../src/core/packs/scene.ts'
import { createMapPhysicalViewport } from '../../../src/ui/map/physical-scene/map-viewport.ts'
import { createCanvasPhysicalViewport } from '../../../src/ui/map/physical-scene/canvas-viewport.ts'
import { createPhysicalSceneControllerForViewport } from '../../../src/ui/map/physical-scene/scene-controller.ts'
import { transform } from '../../../src/ui/map/physical-scene/math.ts'
import type { PhysicalViewport } from '../../../src/ui/map/physical-scene/viewport.ts'
import type { PhysicalScenePalette } from '../../../src/ui/map/physical-scene/types.ts'

setWorkerUrl('/worker.mjs')
const fixtures = await (await fetch('/fixtures.json')).json() as { scenes: PackPhysicalScene[]; descriptors: PackPhysicalSceneDescriptor[] }
const scene = fixtures.scenes[0]!, descriptor = fixtures.descriptors[0]!, errors: string[] = []
const baseObject = scene.objects.find(object => object.id === 'yard/gravel')!
if (!baseObject?.bounds) throw Error('Actual switchyard base requires source bounds')
const sourceOrigin = [0, 0, 0]
const mapElement = document.querySelector<HTMLElement>('#map')!, canvas = document.querySelector<HTMLCanvasElement>('#canvas')!
const map = new MapLibreMap({ container: mapElement, style: { version: 8, sources: {}, layers: [{ id: 'ground', type: 'background', paint: { 'background-color': '#cccccc' } }] }, center: descriptor.anchor, zoom: 16, attributionControl: false, fadeDuration: 0, canvasContextAttributes: { antialias: true, preserveDrawingBuffer: true } })
const loaded = new Promise<void>(resolve => map.once('load', () => resolve()))
const palette: PhysicalScenePalette = { materials: { plinth: [1,1,1], pavement: [.03,.1,.95], background: [.2,.2,.2] }, defaultMaterial: [.03, .7, .08], line: [1, 0, 1], lineOpacity: .26, contextLineOpacity: .1 }
const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
type Controller = ReturnType<typeof createPhysicalSceneControllerForViewport>
interface Host { viewport: PhysicalViewport; controller: Controller; gl: WebGL2RenderingContext; matrices: number[][]; solidsOnly: boolean; suppressedLines: number; drawState?: {depthBits:number;samples:number} }
const hosts = new globalThis.Map<string, Host>()
let active: Host | null = null
const rendered = (host: Host) => new Promise<void>(resolve => { const off = host.viewport.surface.on('render', () => { off(); resolve() }); host.viewport.requestRender() })
const ready = async (host: Host) => { const started = performance.now(); while (host.controller.presentations()[0]?.status !== 'ready') { if (errors.length) throw Error(errors.join(';')); if (performance.now() - started > 30000) throw Error('Flicker scene did not prepare'); await tick() } }
const startHost = (name: string): Host => {
  const viewport = name === 'map' ? createMapPhysicalViewport(map, () => undefined) : createCanvasPhysicalViewport(canvas)
  const surface = name === 'map' ? map.getCanvas() : canvas, gl = surface.getContext('webgl2')!
  const result: Host = { viewport, gl, matrices: [], solidsOnly: false, suppressedLines: 0, controller: undefined as unknown as Controller }
  const bufferData = gl.bufferData.bind(gl), draw = gl.drawArraysInstanced.bind(gl)
  gl.bufferData = ((target: number, data: unknown, usage: number, ...rest: unknown[]) => {
    if (target === gl.ARRAY_BUFFER && usage === gl.DYNAMIC_DRAW && data instanceof Float32Array && data.length === 17) result.matrices.push([...data.subarray(0, 16)])
    ;(bufferData as (...args: unknown[]) => void)(target, data, usage, ...rest)
  }) as typeof gl.bufferData
  gl.drawArraysInstanced = (mode, first, count, instances) => { if(mode===gl.TRIANGLES&&!result.drawState)result.drawState={depthBits:gl.getParameter(gl.DEPTH_BITS),samples:gl.getParameter(gl.SAMPLES)}; if (result.solidsOnly && mode === gl.LINES) { result.suppressedLines++; return }; draw(mode, first, count, instances) }
  result.controller = createPhysicalSceneControllerForViewport(viewport, { palette, onChange() {}, reportError: error => errors.push(error.message), fitPadding: () => ({ top: 40, bottom: 40, left: 40, right: 40 }) })
  result.controller.setSources([{ descriptor, load: async () => scene }]); return result
}
const pointAt = (matrix: number[], x: number, y: number, z: number, width: number, height: number) => { const p = transform(matrix, [x - sourceOrigin[0]!, y - sourceOrigin[1]!, z - sourceOrigin[2]!]); return { x: (p[0] + 1) * width / 2, y: (1 - p[1]) * height / 2, depth: p[2] } }
const depthRange = (matrix: number[]) => {
  const k = [0, 1, 2].sort((a, b) => Math.abs(matrix[b * 4 + 3]!) - Math.abs(matrix[a * 4 + 3]!))[0]!
  if (Math.abs(matrix[k * 4 + 3]!) < Number.EPSILON) return null
  const a = -matrix[k * 4 + 2]! / matrix[k * 4 + 3]!, b = matrix[14]! + a * matrix[15]!, unitsPerMetre = Math.hypot(matrix[3]!, matrix[7]!, matrix[11]!)
  return { nearMetres: b / (a - 1) / unitsPerMetre, farMetres: b / (a + 1) / unitsPerMetre, a, b, unitsPerMetre }
}
const lineDistance = (p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number => Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / Math.hypot(b.x - a.x, b.y - a.y)
declare global { interface Window { yardDepthProbe: { phase: (name: string, solidsOnly: boolean, scale: 'site' | 'yard') => Promise<unknown>; finish: () => unknown } } }
window.yardDepthProbe = {
  async phase(name, solidsOnly, scale) {
    await loaded; active?.controller.setActive(false); mapElement.hidden = name !== 'map'; canvas.hidden = name !== 'canvas'
    let host = hosts.get(name); if (!host) { host = startHost(name); hosts.set(name, host) }
    active = host; delete host.drawState; host.solidsOnly = solidsOnly; host.controller.setActive(true); if (name === 'map') map.resize()
    host.controller.setView(scene.id, { ...host.controller.presentations()[0]!.view, mode: '3d', levelId: 'all', cutaway: true, live: false, separation: 0 })
    const target = scale === 'yard' ? { occurrenceId: baseObject.id, preservePose: false } : { preservePose: false }
    host.controller.focus(scene.id, target); await ready(host); host.controller.focus(scene.id, target); await rendered(host)
    const base = { ...host.viewport.cameraPose() }, surface = name === 'map' ? map.getCanvas() : canvas, box = surface.getBoundingClientRect(), gl = host.gl, b = baseObject.bounds!
    const frames: unknown[] = [], byPoint = new globalThis.Map<string, string[]>()
    for (let frame = 0; frame < 13; frame++) {
      host.viewport.setPose({ center: base.center, bearing: base.bearing + (frame - 6) * .03, pitch: base.pitch + (frame - 6) * .02, zoom: base.zoom + (frame - 6) * .002 }); host.viewport.panBy((frame - 6) * .2, (frame - 6) * .1); await rendered(host)
      const matrix = host.matrices.at(-1); if (!matrix) throw Error('No actual GPU instance matrix captured')
      const corners = [[b.min[0], b.min[1]], [b.max[0], b.min[1]], [b.max[0], b.max[1]], [b.min[0], b.max[1]]].map(([x,y])=>pointAt(matrix,x!,y!,b.max[2],box.width,box.height))
      const samples=[]
      for (let ix=1;ix<=9;ix++) for (let iy=1;iy<=9;iy++) {
        const model = [b.min[0]+ix/10*(b.max[0]-b.min[0]),b.min[1]+iy/10*(b.max[1]-b.min[1]),b.max[2]] as [number,number,number], p=pointAt(matrix,...model,box.width,box.height)
        const x=Math.floor(p.x/box.width*gl.drawingBufferWidth), y=Math.floor((1-p.y/box.height)*gl.drawingBufferHeight)
        if(x<1||x>=gl.drawingBufferWidth-1||y<1||y>=gl.drawingBufferHeight-1||Math.abs(p.depth)>1)continue
        const css={x:(x+.5)/gl.drawingBufferWidth*box.width,y:(1-(y+.5)/gl.drawingBufferHeight)*box.height}, pixel=new Uint8Array(4)
        const marginDevice=Math.min(...corners.map((a,i)=>lineDistance(css,a,corners[(i+1)%4]!)))*gl.drawingBufferWidth/box.width
        if(marginDevice<1)continue
        const neighbors=[-1,0,1].flatMap(dx=>[-1,0,1].map(dy=>host.controller.pick({x:css.x+dx*box.width/gl.drawingBufferWidth,y:css.y+dy*box.height/gl.drawingBufferHeight})?.occurrenceId??null))
        if(neighbors.some(id=>id!==baseObject.id))continue
        gl.readPixels(x,y,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel)
        const gray=Math.max(pixel[0]!,pixel[1]!,pixel[2]!)-Math.min(pixel[0]!,pixel[1]!,pixel[2]!)<4, average=(pixel[0]!+pixel[1]!+pixel[2]!)/3
        const painted=gray&&average>210?'top':gray&&average>145&&average<195?'underside':'other',key=`${ix}/${iy}`
        const values=byPoint.get(key)??[];values.push(painted);byPoint.set(key,values)
        const bottom=pointAt(matrix,model[0],model[1],b.min[2],box.width,box.height)
        samples.push({point:key,model,painted,gray,pixel:[...pixel],marginDevice,hit:baseObject.id,depthSeparation:bottom.depth-p.depth,css})
      }
      frames.push({pose:host.viewport.cameraPose(),matrix,depthRange:depthRange(matrix),samples})
    }
    const eligible=new Set([...byPoint.keys()].filter(point=>{const values=(frames as Array<{samples:any[]}>).flatMap(frame=>frame.samples).filter(sample=>sample.point===point);return values.length===13&&values.every(sample=>sample.gray)}))
    const tracks=[...byPoint].filter(([point])=>eligible.has(point)).map(([point,values])=>({point,values,flips:values.slice(1).reduce((sum,value,i)=>sum+Number(value!==values[i]),0)})), all=(frames as Array<{samples:any[]}>).flatMap(frame=>frame.samples).filter(sample=>eligible.has(sample.point)),gpuInfo=gl.getExtension('WEBGL_debug_renderer_info')
    return {host:name,scale,solidsOnly,drawState:host.drawState,baseBounds:b,expectedNormal:[0,0,1],eligiblePoints:[...eligible],sampled:all.length,correctPainted:all.filter(s=>s.painted==='top').length,underside:all.filter(s=>s.painted==='underside').length,other:all.filter(s=>s.painted==='other').length,tracks,frames,glDepthBits:gl.getParameter(gl.DEPTH_BITS),samples:gl.getParameter(gl.SAMPLES),dpr:devicePixelRatio,viewport:{width:box.width,height:box.height,bufferWidth:gl.drawingBufferWidth,bufferHeight:gl.drawingBufferHeight},gpu:gpuInfo?gl.getParameter(gpuInfo.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),metrics:host.controller.diagnostics(),glError:gl.getError()}
  },
  finish(){for(const host of hosts.values())host.controller.destroy();return{errors}},
}
