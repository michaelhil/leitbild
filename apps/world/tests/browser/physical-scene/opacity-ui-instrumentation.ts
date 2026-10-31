// Test-only boundary instrumentation. It observes actual workers/draws and may
// delay a real outbound BSP request or return one explicit controlled error.
// Nothing is imported by product code, and no Run/domain state is changed.
(() => {
  const q: any = { jobs: [], draws: [], hold: false, failNext: false, sequence: 0, controlledFailure: 'Controlled isolated architecture worker failure' }
  ;(window as any).__opacityUiProof = q
  const dead = new WeakSet<Worker>(), requests = new WeakMap<Worker, any>(), held: Array<{ worker: Worker; message: any; transfer: any; job: any }> = []
  const NativeWorker = Worker, post = NativeWorker.prototype.postMessage, terminate = NativeWorker.prototype.terminate
  ;(window as any).Worker = new Proxy(NativeWorker, { construct(constructor, args, receiver) {
    const worker = Reflect.construct(constructor, args, receiver) as Worker
    worker.addEventListener('message', event => { const job = requests.get(worker); if (!job || !['prepared', 'error'].includes(event.data?.kind)) return; job.response = event.data.kind; job.finished = performance.now() })
    return worker
  } })
  const send = (worker: Worker, message: any, transfer: any, job: any) => {
    job.posted = performance.now(); Reflect.apply(post, worker, [message, transfer])
    if (q.failNext) { q.failNext = false; job.controlledFailure = true; queueMicrotask(() => { if (!dead.has(worker)) worker.dispatchEvent(new MessageEvent('message', { data: { kind: 'error', message: q.controlledFailure } })) }) }
  }
  Worker.prototype.postMessage = function (this: Worker, message: any, transfer: any) {
    if (!(message?.kind === 'prepare' && typeof message?.input?.key === 'string' && Array.isArray(message.input.sources))) return Reflect.apply(post, this, [message, transfer])
    const job = { id: ++q.sequence, key: message.input.key, sources: message.input.sources.length, requested: performance.now(), held: q.hold }
    q.jobs.push(job); requests.set(this, job)
    if (q.hold) held.push({ worker: this, message, transfer, job }); else send(this, message, transfer, job)
  } as typeof post
  Worker.prototype.terminate = function (this: Worker) { dead.add(this); const job = requests.get(this); if (job) job.terminated = performance.now(); return Reflect.apply(terminate, this, []) }
  q.release = () => { q.hold = false; let posted = 0, cancelled = 0; for (const item of held.splice(0)) { if (dead.has(item.worker)) { item.job.cancelledBeforePost = true; cancelled++ } else { send(item.worker, item.message, item.transfer, item.job); posted++ } }; return { posted, cancelled } }
  const data = WebGL2RenderingContext.prototype.bufferData, bind = WebGL2RenderingContext.prototype.bindBuffer, pointer = WebGL2RenderingContext.prototype.vertexAttribPointer
  const bound = new WeakMap<WebGL2RenderingContext, WebGLBuffer | null>(), uploads = new WeakMap<WebGLBuffer, number>(), ids = new WeakMap<WebGLBuffer, number>(), vaoBuffers = new WeakMap<WebGLVertexArrayObject, WebGLBuffer>()
  let nextBuffer = 0
  WebGL2RenderingContext.prototype.bindBuffer = function (target, buffer) { if (target === this.ARRAY_BUFFER) bound.set(this, buffer); return bind.call(this, target, buffer) }
  WebGL2RenderingContext.prototype.bufferData = function (this: WebGL2RenderingContext, ...args: any[]) { const buffer = bound.get(this); if (args[0] === this.ARRAY_BUFFER && args[2] === this.STATIC_DRAW && buffer) { uploads.set(buffer, (uploads.get(buffer) ?? 0) + 1); if (!ids.has(buffer)) ids.set(buffer, ++nextBuffer) }; return Reflect.apply(data, this, args) } as typeof data
  WebGL2RenderingContext.prototype.vertexAttribPointer = function (...args: Parameters<WebGL2RenderingContext['vertexAttribPointer']>) { if (args[0] === 10) { const vao = this.getParameter(this.VERTEX_ARRAY_BINDING), buffer = bound.get(this); if (vao && buffer) vaoBuffers.set(vao, buffer) }; return pointer.apply(this, args) }
  const draw = WebGL2RenderingContext.prototype.drawElementsInstanced
  const batch = new Map<WebGLBuffer, any>()
  WebGL2RenderingContext.prototype.drawElementsInstanced = function (...args: Parameters<WebGL2RenderingContext['drawElementsInstanced']>) {
    const result = draw.apply(this, args), vao = this.getParameter(this.VERTEX_ARRAY_BINDING), buffer = vao ? vaoBuffers.get(vao) : null
    if (buffer) {
      let item = batch.get(buffer)
      if (!item) { if (!batch.size) queueMicrotask(() => batch.clear()); item = { at: performance.now(), buffer: ids.get(buffer), staticUploads: uploads.get(buffer) ?? 0, triangles: 0, lines: 0, calls: 0 }; batch.set(buffer, item); q.draws.push(item) }
      item.calls++; item[args[0] === this.TRIANGLES ? 'triangles' : 'lines'] += args[1]
    }
    return result
  }
  q.annotationFrames = []
  const clear = CanvasRenderingContext2D.prototype.clearRect, stroke = CanvasRenderingContext2D.prototype.stroke
  CanvasRenderingContext2D.prototype.clearRect = function (...args: Parameters<CanvasRenderingContext2D['clearRect']>) { if (this.canvas.classList.contains('layout-plan-annotations')) q.annotationFrames.push({ at: performance.now(), strokes: 0, badges: document.querySelectorAll('.layout-status').length }); return clear.apply(this, args) }
  CanvasRenderingContext2D.prototype.stroke = function (this: CanvasRenderingContext2D, ...args: any[]) { if (this.canvas.classList.contains('layout-plan-annotations') && q.annotationFrames.length) q.annotationFrames.at(-1).strokes++; return Reflect.apply(stroke, this, args) } as typeof stroke
})()
