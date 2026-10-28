// Diagnostic-only extension: identify actual indexed interior submissions, not merely a first solid draw.
import './native-map-loading-instrumentation.ts'

(() => {
  const q = (window as any).__nativeMapLoadingProof
  const sources = new Map<string, ReadonlyArray<{ id: string; kind: string; subjectIds: readonly string[] }>>()
  type Range = { first: number; end: number; id: string; kind: string; operational: boolean }
  type Asset = { key: string; sourceKey: string; ranges: Range[] }
  const arrays = new WeakMap<object, Asset>(), buffers = new WeakMap<WebGLBuffer, Asset>(), vertices = new WeakMap<WebGLVertexArrayObject, WebGLBuffer>()
  const elements = new WeakMap<WebGLVertexArrayObject, WebGLBuffer>(), indices = new WeakMap<WebGLBuffer, WeakRef<Uint32Array>>()
  const states = new WeakMap<WebGL2RenderingContext, { array: WebGLBuffer | null; element: WebGLBuffer | null; vao: WebGLVertexArrayObject | null }>()
  const state = (gl: WebGL2RenderingContext) => { let value = states.get(gl); if (!value) { value = { array: null, element: null, vao: null }; states.set(gl, value) }; return value }
  q.detailDraws = []; q.detailInventories = []; q.detailSignatures = []; q.sourceManifests = []; q.detailObserverMs = 0; q.detailErrors = []; q.detailEnabled = true
  const signatureIds = new Map<string, number>()
  let lastPhysicalGl: WebGL2RenderingContext | undefined
  q.awaitDetailFence = () => new Promise((resolve, reject) => {
    const gl = lastPhysicalGl, fence = gl?.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
    if (!gl || !fence) { reject(Error('No actual detail submission context/fence')); return }
    gl.flush()
    const check = () => {
      const status = gl.clientWaitSync(fence, 0, 0)
      if (status === gl.TIMEOUT_EXPIRED) { requestAnimationFrame(check); return }
      gl.deleteSync(fence)
      if (status === gl.WAIT_FAILED) reject(Error('Detail submission fence failed'))
      else resolve({ at: performance.now(), glError: gl.getError() })
    }
    requestAnimationFrame(check)
  })
  const interior = (kind: string) => !['wall', 'slab', 'roof', 'pavement', 'context'].includes(kind)
  const NativeWorker = Worker, post = Worker.prototype.postMessage
  ;(window as any).Worker = new Proxy(NativeWorker, { construct(target, args, constructor) {
    const worker = Reflect.construct(target, args, constructor) as Worker
    worker.addEventListener('message', event => {
      const response = event.data
      if (response?.ok && response.scene) q.sourceManifests.push({ revision: response.scene.revision, scopes: response.scene.scopes, objects: response.scene.objects.map((object: any) => ({ id: object.id, kind: object.kind, subjects: object.subjectIds.length })) })
      if (response?.kind !== 'prepared' || !response.buffers) return
      const source = sources.get(response.sourceKey); if (!source) { q.detailErrors.push('Detail witness has no registered source metadata'); return }
      let first = 0
      if (response.meshes.some((mesh: any) => !source[mesh.objectIndex])) { q.detailErrors.push('Detail witness object index mismatch'); return }
      const ranges: Range[] = response.meshes.map((mesh: any) => { const object = source[mesh.objectIndex]!; const value = { first, end: first + mesh.vertices.length / 7, id: object.id, kind: object.kind, operational: object.subjectIds.length > 0 }; first = value.end; return value })
      if (first !== response.buffers.vertices.length / 8) { q.detailErrors.push('Detail witness packed vertex ranges do not match the prepared asset'); return }
      const asset = { key: response.key, sourceKey: response.sourceKey, ranges }; arrays.set(response.buffers.vertices, asset)
      q.detailInventories.push({ key: asset.key, sourceKey: asset.sourceKey, at: performance.now(), meshCount: ranges.length, interiorOccurrences: [...new Set(ranges.filter(range => range.end > range.first && interior(range.kind)).map(range => range.id))], operationalInteriorOccurrences: [...new Set(ranges.filter(range => range.end > range.first && interior(range.kind) && range.operational).map(range => range.id))] })
    })
    return worker
  } })
  Worker.prototype.postMessage = function(this: Worker, message: any, transfer: any) {
    if (message?.kind === 'register') sources.set(message.sourceKey, message.scene.objects.map((object: any) => ({ id: object.id, kind: object.kind, subjectIds: object.subjectIds })))
    if (message?.kind === 'release') sources.delete(message.sourceKey)
    return Reflect.apply(post, this, [message, transfer])
  } as typeof post
  const bind = WebGL2RenderingContext.prototype.bindBuffer
  WebGL2RenderingContext.prototype.bindBuffer = function(target, buffer) { const s = state(this); if (target === this.ARRAY_BUFFER) s.array = buffer; if (target === this.ELEMENT_ARRAY_BUFFER) { s.element = buffer; if (s.vao && buffer) elements.set(s.vao, buffer) }; return bind.call(this, target, buffer) }
  const vao = WebGL2RenderingContext.prototype.bindVertexArray
  WebGL2RenderingContext.prototype.bindVertexArray = function(value) { const s = state(this); s.vao = value; s.element = value ? elements.get(value) ?? null : null; return vao.call(this, value) }
  const upload = WebGL2RenderingContext.prototype.bufferData
  WebGL2RenderingContext.prototype.bufferData = function(this: WebGL2RenderingContext, ...args: any[]) { const s = state(this); if (args[0] === this.ARRAY_BUFFER && s.array && args[1] && typeof args[1] === 'object') { const asset = arrays.get(args[1]); if (asset) buffers.set(s.array, asset) }; if (args[0] === this.ELEMENT_ARRAY_BUFFER && s.element && args[1] instanceof Uint32Array) indices.set(s.element, new WeakRef(args[1])); return Reflect.apply(upload, this, args) } as typeof upload
  const attribute = WebGL2RenderingContext.prototype.vertexAttribPointer
  WebGL2RenderingContext.prototype.vertexAttribPointer = function(...args: Parameters<WebGL2RenderingContext['vertexAttribPointer']>) { const s = state(this); if (args[0] === 0 && s.vao && s.array) vertices.set(s.vao, s.array); return attribute.apply(this, args) }
  const observe = (gl: WebGL2RenderingContext, mode: number, first: number, count: number, instances: number, indexed: boolean) => {
    if (!q.detailEnabled) return
    const started = performance.now(), s = state(gl), buffer = s.vao ? vertices.get(s.vao) : undefined, asset = buffer ? buffers.get(buffer) : undefined
    if (!asset || mode !== gl.TRIANGLES || !count) return
    lastPhysicalGl = gl
    const indexBuffer = s.vao ? elements.get(s.vao) : undefined, selection = indexed && indexBuffer ? indices.get(indexBuffer)?.deref() : undefined
    // The diagnostic must never throw into a product draw. In particular an
    // old GPU EBO may outlive its weak CPU array after an explicit GC test.
    if (indexed && !selection) { q.detailErrors.push('Detail witness has no live CPU index selection'); return }
    const lower = (needle: number) => { let low = first, high = first + count; while (low < high) { const middle = (low + high) >>> 1; if (selection![middle]! < needle) low = middle + 1; else high = middle }; return low }
    const selected = asset.ranges.filter(range => { if (range.end === range.first || !interior(range.kind)) return false; if (!selection) return range.first < first + count && range.end > first; const at = lower(range.first); return at < first + count && selection[at]! < range.end })
    const ids = [...new Set(selected.map(range => range.id))].sort(), signature = JSON.stringify([asset.key, ids]); let signatureId = signatureIds.get(signature)
    if (signatureId === undefined) { signatureId = Number(q.detailSignatures.length); signatureIds.set(signature, signatureId); q.detailSignatures.push({ key: asset.key, sourceKey: asset.sourceKey, interiorOccurrences: ids, operationalInteriorOccurrences: [...new Set(selected.filter(range => range.operational).map(range => range.id))].sort(), kinds: [...new Set(selected.map(range => range.kind))] }) }
    q.detailDraws.push({ at: started, key: asset.key, sourceKey: asset.sourceKey, instances, signatureId, interiorCount: ids.length, submittedReferences: count, indexed, phase: q.current?.name ?? 'navigation' })
    q.detailObserverMs += performance.now() - started
  }
  const draw = WebGL2RenderingContext.prototype.drawArraysInstanced
  WebGL2RenderingContext.prototype.drawArraysInstanced = function(mode, first, count, instances) { const result = draw.call(this, mode, first, count, instances); observe(this, mode, first, count, instances, false); return result }
  const indexed = WebGL2RenderingContext.prototype.drawElementsInstanced
  WebGL2RenderingContext.prototype.drawElementsInstanced = function(mode, count, type, offset, instances) { const result = indexed.call(this, mode, count, type, offset, instances); if (type === this.UNSIGNED_INT) observe(this, mode, offset / 4, count, instances, true); return result }
})()
