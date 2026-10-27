// Functional product proof only. Observe one exact admitted route and actual GPU
// projection; never expose test hooks in the production application.
(() => {
  const target = (window as any).__nativeRouteTarget as { elementId: string } | undefined
  if (!target) return
  const q: any = { registrations: [], prepared: [], matrix: null, instances: 0, points: [], samples: [], endpointContexts: [], errors: [], currentDrawKey: null, heldLayer: null, holdNextLayer: false }
  ;(window as any).__nativeRouteProof = q
  const sourceIndices = new Map<string, number>(), arrays = new WeakMap<object, { key: string; sourceKey: string }>()
  const buffers = new WeakMap<WebGLBuffer, { key: string; sourceKey: string }>(), vaos = new WeakMap<WebGLVertexArrayObject, WebGLBuffer>(), instanceVao = new WeakMap<WebGLVertexArrayObject, WebGLBuffer>()
  const instanceBuffers = new WeakSet<WebGLBuffer>(), matrices = new WeakMap<WebGLBuffer, Float32Array>()
  const bound = new WeakMap<WebGL2RenderingContext, { array: WebGLBuffer | null; vao: WebGLVertexArrayObject | null }>()
  const state = (gl: WebGL2RenderingContext) => { let s = bound.get(gl); if (!s) { s = { array: null, vao: null }; bound.set(gl, s) }; return s }
  const NativeWorker = Worker, post = NativeWorker.prototype.postMessage
  const inspect = (response: any) => {
    if (response?.kind !== 'prepared') return
    const index = sourceIndices.get(response.sourceKey); if (index === undefined) return
    const selected = response.meshes.filter((mesh: any) => mesh.objectIndex === index)
    const points: number[][] = []
    for (const mesh of selected) for (let i = 0; i + 20 < mesh.vertices.length; i += 21) points.push([0, 1, 2].map(axis => (mesh.vertices[i + axis] + mesh.vertices[i + 7 + axis] + mesh.vertices[i + 14 + axis]) / 3 + mesh.offset[axis]))
    q.prepared.push({ key: response.key, sourceKey: response.sourceKey, meshes: selected.length, triangles: points.length })
    q.points = points; q.key = response.key; arrays.set(response.buffers.vertices, { key: response.key, sourceKey: response.sourceKey })
  }
  ;(window as any).Worker = new Proxy(NativeWorker, { construct(constructor, args, receiver) { const worker = Reflect.construct(constructor, args, receiver) as Worker; worker.addEventListener('message', event => {const response=event.data,at=typeof response?.key==='string'?response.key.lastIndexOf('/['):-1,view=at<0?null:JSON.parse(response.key.slice(at+1));if(q.holdNextLayer&&response?.kind==='prepared'&&view?.some((part:any)=>part&&typeof part==='object'&&!Array.isArray(part)&&part.layers?.includes(q.holdLayerId??'utility-routes'))){event.stopImmediatePropagation();q.holdNextLayer=false;q.heldLayer={worker,response};return}inspect(response)}); return worker } })
  Worker.prototype.postMessage = function (this: Worker, message: any, transfer: any) {
    if (message?.kind === 'register') {
      const index = message.scene.objects.findIndex((object: any) => object.subjectIds.includes(target.elementId))
      if (index >= 0) { const object = message.scene.objects[index]; sourceIndices.set(message.sourceKey, index); q.object = { id: object.id, label: object.label, subjectIds: [...object.subjectIds], layerId: object.layerId }; q.sourceKey = message.sourceKey; q.registrations.push({ sourceKey: message.sourceKey, index, ...q.object }) }
    }
    return Reflect.apply(post, this, [message, transfer])
  } as typeof post
  q.heldLayerInfo=()=>q.heldLayer?{id:q.heldLayer.response.id,key:q.heldLayer.response.key}:null
  q.releaseHeldLayer=()=>{const held=q.heldLayer;if(!held)throw Error('No actual held layer response');q.heldLayer=null;held.worker.dispatchEvent(new MessageEvent('message',{data:held.response}))}
  q.failHeldLayer=()=>{const held=q.heldLayer;if(!held)throw Error('No actual held layer response');q.heldLayer=null;held.worker.dispatchEvent(new MessageEvent('message',{data:{kind:'error',id:held.response.id,message:'Intentional isolated test failure while adding Utility routes'}}))}
  const bindBuffer = WebGL2RenderingContext.prototype.bindBuffer
  WebGL2RenderingContext.prototype.bindBuffer = function (target, buffer) { if (target === this.ARRAY_BUFFER) state(this).array = buffer; return bindBuffer.call(this, target, buffer) }
  const bindVao = WebGL2RenderingContext.prototype.bindVertexArray
  WebGL2RenderingContext.prototype.bindVertexArray = function (vao) { state(this).vao = vao; return bindVao.call(this, vao) }
  const data = WebGL2RenderingContext.prototype.bufferData
  WebGL2RenderingContext.prototype.bufferData = function (this: WebGL2RenderingContext, ...args: any[]) {
    const s = state(this), meta = args[1] && typeof args[1] === 'object' ? arrays.get(args[1]) : undefined
    if (s.array && args[0] === this.ARRAY_BUFFER) { if (meta) buffers.set(s.array, meta); if (instanceBuffers.has(s.array) && args[1] instanceof Float32Array) matrices.set(s.array, new Float32Array(args[1])) }
    return Reflect.apply(data, this, args)
  } as typeof data
  const attribute = WebGL2RenderingContext.prototype.vertexAttribPointer
  WebGL2RenderingContext.prototype.vertexAttribPointer = function (...args: Parameters<WebGL2RenderingContext['vertexAttribPointer']>) {
    const s = state(this)
    if (s.vao && s.array) { if (args[0] === 0) vaos.set(s.vao, s.array); if (args[0] === 5 && buffers.has(vaos.get(s.vao)!)) { instanceVao.set(s.vao, s.array); instanceBuffers.add(s.array) } }
    return attribute.apply(this, args)
  }
  const draw = WebGL2RenderingContext.prototype.drawArraysInstanced
  WebGL2RenderingContext.prototype.drawArraysInstanced = function (...args: Parameters<WebGL2RenderingContext['drawArraysInstanced']>) {
    const result = draw.apply(this, args), s = state(this), buffer = s.vao ? vaos.get(s.vao) : undefined, meta = buffer ? buffers.get(buffer) : undefined, instance = s.vao ? instanceVao.get(s.vao) : undefined, values = instance ? matrices.get(instance) : undefined
    if (args[0] === this.TRIANGLES && meta && meta.key === q.key && values) { q.currentDrawKey=meta.key;q.lastDrawAt=performance.now();q.matrix = Array.from(values.slice(0, 16)); q.instances = args[3] }
    return result
  }
  q.projected = () => {
    const m = q.matrix, canvas = document.querySelector<HTMLCanvasElement>('.maplibregl-canvas'); if (!m || !canvas || q.instances !== 1) return []
    const box = canvas.getBoundingClientRect(), seen = new Set<string>()
    return q.points.flatMap(([x, y, z]: number[]) => {
      const w = m[3] * x! + m[7] * y! + m[11] * z! + m[15], u = (m[0] * x! + m[4] * y! + m[8] * z! + m[12]) / w, v = (m[1] * x! + m[5] * y! + m[9] * z! + m[13]) / w
      const px = (u + 1) * box.width / 2, py = (1 - v) * box.height / 2, key = `${Math.floor(px * devicePixelRatio)},${Math.floor(py * devicePixelRatio)}`
      if (!(w > 0 && px > 0 && py > 0 && px < box.width && py < box.height) || seen.has(key)) return []
      seen.add(key); return [{ x: box.x + px, y: box.y + py }]
    })
  }
  const originalFetch = window.fetch
  window.fetch = Object.assign(async function (...args: Parameters<typeof fetch>) {
    const response = await originalFetch(...args), request = args[0], url = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url
    if (/\/displays\/(view|sample)(?:\?|$)/.test(url)) void response.clone().json().then(body => {
      const inspect = (value: any): void => {
        if (!value || typeof value !== 'object') return
        if (value.id === target.elementId && typeof value.from?.port === 'string' && typeof value.to?.port === 'string') q.endpointContexts.push({ id: value.id, from: value.from, to: value.to })
        for (const child of Object.values(value)) if (child && typeof child === 'object') inspect(child)
      }
      inspect(body)
    }).catch(() => {})
    return response
  }, originalFetch)
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.data?.type !== 'world:layout-inspection-sample' || event.data.elementId !== target.elementId) return
    const subject = event.data.snapshot?.latest?.subjects?.find((value: any) => value.elementId === target.elementId)
    if (subject) q.samples.push({ elementId: subject.elementId, label: subject.label, values: subject.values.map((value: any) => ({ ref: value.ref, label: value.label, unit: value.unit })), observedRefs: event.data.snapshot.latest.sample.observations.map((value: any) => value.ref), stamp: event.data.snapshot.stamp })
  })
})()
