// Injected only by the isolated full-product test. Never imported by product code.
// Weak keys preserve the production GC/lease behavior; logs contain primitives.
(() => {
  const arrays = new WeakMap<object, { key: string; sourceKey: string; received: number; bytes: number }>()
  const buffers = new WeakMap<WebGLBuffer, { key: string; sourceKey: string; received: number; bytes: number }>()
  const vaos = new WeakMap<WebGLVertexArrayObject, WebGLBuffer>()
  const bound = new WeakMap<WebGL2RenderingContext, { array: WebGLBuffer | null; vao: WebGLVertexArrayObject | null }>()
  const workers = new WeakMap<Worker, { id: number; jobs: Map<number, any>; source: any | null }>()
  const q: any = { started: performance.now(), sources: [], jobs: [], draws: [], actions: [], errors: [], pending: 0, sequence: 0, overheadMs: 0, current: null }
  ;(window as any).__loadingProof = q
  const state = (gl: WebGL2RenderingContext) => { let value = bound.get(gl); if (!value) { value = { array: null, vao: null }; bound.set(gl, value) }; return value }
  const viewFrom = (key: string) => { const at = key.lastIndexOf('/['); if (at < 0) return null; try { return JSON.parse(key.slice(at + 1)) } catch { throw Error('Physical view key cannot be decoded by loading proof') } }
  const matches = (key: string, expected: any) => { const view = viewFrom(key); return Boolean(view && (!expected.mode || view[0] === expected.mode) && (!expected.levelId || view[1] === expected.levelId) && (expected.cutaway === undefined || view[2] === expected.cutaway) && (expected.separated === undefined || Boolean(view[3]) === expected.separated)) }
  const NativeWorker = Worker
  const observe = (worker: Worker, response: any) => {
    const current = workers.get(worker); if (!current) return
    const at = performance.now()
    if (current.source && response?.ok !== undefined) {
      const job = current.source; job.responseAt = at; job.responseMs = at - job.started; job.ok = response.ok; job.occurrences = response.scene?.objects?.length ?? null; q.pending--
      if (!response.ok) q.errors.push(response.message ?? 'Source compilation failed')
    }
    const job = current.jobs.get(response?.id); if (!job) return
    current.jobs.delete(response.id); q.pending--; job.responseAt = at; job.responseMs = at - job.started; job.responseKind = response.kind
    if (response.kind === 'error') q.errors.push(response.message)
    if (response.kind === 'prepared') {
      const meta = { key: response.key, sourceKey: response.sourceKey, received: at, bytes: response.buffers.vertices.byteLength + response.buffers.lines.byteLength }
      arrays.set(response.buffers.vertices, meta); arrays.set(response.buffers.lines, meta)
      job.meshes = response.meshes.length; job.renderBytes = meta.bytes
    }
  }
  // Install the observer before product listeners, including source termination.
  ;(window as any).Worker = new Proxy(NativeWorker, { construct(target, args, constructor) {
    const worker = Reflect.construct(target, args, constructor) as Worker
    worker.addEventListener('message', event => observe(worker, event.data))
    worker.addEventListener('error', event => { if (workers.has(worker)) q.errors.push(event.message || 'Worker error') })
    return worker
  } })
  const post = NativeWorker.prototype.postMessage, terminate = NativeWorker.prototype.terminate
  Worker.prototype.postMessage = function (this: Worker, message: any, transfer: any) {
    const physical = message?.kind === 'register' || message?.kind === 'prepare', source = Boolean(message?.design?.digest && message?.compiler)
    if (physical || source) {
      let record = workers.get(this)
      if (!record) {
        record = { id: ++q.sequence, jobs: new Map(), source: null }; workers.set(this, record)
      }
      const now = performance.now()
      if (source) { const job = { worker: record.id, design: message.design.digest, compiler: message.compiler.digest, started: now }; record.source = job; q.sources.push(job); q.pending++ }
      else { const job = { worker: record.id, id: message.id, kind: message.kind, key: message.key, sourceKey: message.sourceKey, view: message.view, started: now }; record.jobs.set(message.id, job); q.jobs.push(job); q.pending++ }
    }
    const transferBytes = Array.isArray(transfer) ? transfer.reduce((sum: number, item: any) => sum + (item.byteLength ?? 0), 0) : 0
    const started = performance.now(); const result = Reflect.apply(post, this, [message, transfer]); const ms = performance.now() - started
    const record = workers.get(this), job = source ? record?.source : record?.jobs.get(message?.id)
    if (job) { job.postMs = ms; job.transferBytes = transferBytes }
    return result
  } as typeof Worker.prototype.postMessage
  Worker.prototype.terminate = function () { const record = workers.get(this); if (record?.source) record.source.terminatedAt = performance.now(); return Reflect.apply(terminate, this, []) }
  const bindBuffer = WebGL2RenderingContext.prototype.bindBuffer
  WebGL2RenderingContext.prototype.bindBuffer = function (target, buffer) { if (target === this.ARRAY_BUFFER) state(this).array = buffer; return bindBuffer.call(this, target, buffer) }
  const bindVao = WebGL2RenderingContext.prototype.bindVertexArray
  WebGL2RenderingContext.prototype.bindVertexArray = function (vao) { state(this).vao = vao; return bindVao.call(this, vao) }
  const bufferData = WebGL2RenderingContext.prototype.bufferData
  WebGL2RenderingContext.prototype.bufferData = function (this: WebGL2RenderingContext, ...args: any[]) {
    const meta = args[1] && typeof args[1] === 'object' ? arrays.get(args[1]) : null, buffer = state(this).array
    if (args[0] === this.ARRAY_BUFFER && meta && buffer) buffers.set(buffer, meta)
    return Reflect.apply(bufferData, this, args)
  } as typeof WebGL2RenderingContext.prototype.bufferData
  const attrib = WebGL2RenderingContext.prototype.vertexAttribPointer
  WebGL2RenderingContext.prototype.vertexAttribPointer = function (...args: Parameters<WebGL2RenderingContext['vertexAttribPointer']>) { const b = state(this); if (args[0] === 0 && b.vao && b.array) vaos.set(b.vao, b.array); return attrib.apply(this, args) }
  const draw = WebGL2RenderingContext.prototype.drawArraysInstanced
  WebGL2RenderingContext.prototype.drawArraysInstanced = function (...args: Parameters<WebGL2RenderingContext['drawArraysInstanced']>) {
    const result = draw.apply(this, args), started = performance.now(), current = q.current, vao = state(this).vao, buffer = vao ? vaos.get(vao) : null, meta = buffer ? buffers.get(buffer) : null
    if (meta && args[0] === this.TRIANGLES) {
      const item = { at: started, key: meta.key, sourceKey: meta.sourceKey, preparedReceivedAt: meta.received, vertices: args[2], instances: args[3], surface: this.canvas instanceof HTMLCanvasElement ? this.canvas.className : 'offscreen' }
      q.draws.push(item)
      if (current && !current.finished && item.at >= current.started && matches(item.key, current.expected) && (!current.surface || item.surface.includes(current.surface))) {
        current.firstDraw ??= item
        if (!current.fencePending) {
          current.fencePending = true
          // All rendering/Plan compositing in this JS frame precedes this fence.
          queueMicrotask(() => {
            if (q.current !== current || current.finished) return
            const gl = this, fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush()
            if (!fence) { current.reject(Error('GPU completion fence unavailable')); return }
            const check = () => {
              if (current.finished) { gl.deleteSync(fence); return }
              const status = gl.clientWaitSync(fence, 0, 0)
              if (status === gl.WAIT_FAILED) { gl.deleteSync(fence); current.reject(Error('GPU completion fence failed')); return }
              if (status === gl.TIMEOUT_EXPIRED) { requestAnimationFrame(check); return }
              gl.deleteSync(fence)
              const dom = document.querySelector('.layout-browser') ?? document, evidence = dom.querySelector('.explorer-controls .evidence')?.textContent ?? ''
              if (q.pending || /\b[1-9]\d* loading\b/.test(evidence) || (current.expected.readyCount && !evidence.includes(`${current.expected.readyCount} layouts ready`))) { current.fencePending = false; return }
              const completed = performance.now(), currentJobs = q.jobs.slice(current.jobStart), matchingResponses = currentJobs.filter((job: any) => job.kind === 'prepare' && job.key === current.firstDraw.key && job.responseKind === 'prepared'), latestResponse = matchingResponses.at(-1)?.responseAt, receipt = { name: current.name, expected: current.expected, started: current.started, firstDraw: current.firstDraw, gpuCompletedAt: completed, actionToFirstDrawMs: current.firstDraw.at - current.started, actionToGpuCompletedMs: completed - current.started, preparedAfterAction: matchingResponses.length > 0, preparedResponseMs: latestResponse === undefined ? null : latestResponse - current.started, gpuBufferFromPriorResponse: current.firstDraw.preparedReceivedAt < current.started, evidence, pending: q.pending, jobs: currentJobs, sources: q.sources.slice(current.sourceStart), overheadMs: q.overheadMs - current.overheadStart, glError: gl.getError() }
              current.finished = true; q.actions.push(receipt); current.resolve(receipt)
            }
            requestAnimationFrame(check)
          })
        }
      }
    }
    q.overheadMs += performance.now() - started; return result
  }
  q.begin = (name: string, expected: any, surface: string) => {
    if (q.current && !q.current.finished) throw Error('Previous loading action is unfinished')
    let resolve: (value: unknown) => void = () => {}, reject: (error: Error) => void = () => {}
    const promise = new Promise((a, b) => { resolve = a; reject = b })
    q.current = { name, expected, surface, started: performance.now(), jobStart: q.jobs.length, sourceStart: q.sources.length, overheadStart: q.overheadMs, firstDraw: null, finished: false, fencePending: false, promise, resolve, reject }
  }
})()
