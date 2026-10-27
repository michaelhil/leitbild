/**
 * Test-only asynchronous GPU attribution for the actual native-map program.
 * This observer changes no shader, geometry, sampling, camera or product flag.
 * Its query/observer overhead makes the run diagnostic, not a frame-budget gate.
 */
(() => {
  interface TimerExtension { readonly TIME_ELAPSED_EXT: number; readonly GPU_DISJOINT_EXT: number }
  interface Sample {
    readonly context: number
    readonly phase: 'draw' | 'resolve'
    readonly startedMs: number
    readonly endedMs: number
    readonly cpuSubmissionMs: number
    readonly drawCalls: number
    readonly triangleVertices: number
    readonly lineVertices: number
    readonly gpuNs: number | null
  }
  interface Interval {
    readonly phase: Sample['phase']
    readonly epoch: number
    readonly started: number
    readonly query: WebGLQuery | null
    drawCalls: number
    triangleVertices: number
    lineVertices: number
  }
  interface Pending { readonly epoch: number; readonly query: WebGLQuery; readonly sample: Omit<Sample, 'gpuNs'> }
  interface Context {
    readonly id: number
    readonly gl: WebGL2RenderingContext
    readonly extension: TimerExtension | null
    readonly pending: Pending[]
    active: Interval | null
  }
  const contexts = new WeakMap<WebGL2RenderingContext, Context>(), retained = new Set<Context>(), physical = new WeakSet<WebGLProgram>()
  let epoch = 0, sequence = 0, recording = false, started = performance.now(), scheduled: number | null = null
  let samples: Sample[] = [], aborted: { context: number; reason: string }[] = [], busyIntervals = 0, disjointChecks = 0, disjointEvents = 0
  let polling = false
  const stateReads = new Map<string, { calls: number; cpuMs: number }>()
  const abort = (context: Context, reason: string): void => { aborted.push({ context: context.id, reason }) }
  const state = (gl: WebGL2RenderingContext): Context => {
    let context = contexts.get(gl)
    if (!context) {
      context = { id: ++sequence, gl, extension: gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExtension | null, active: null, pending: [] }
      contexts.set(gl, context); retained.add(context)
    }
    return context
  }
  const surface = (context: Context): string => context.gl.canvas instanceof HTMLCanvasElement ? context.gl.canvas.className : 'offscreen'
  const poll = (): void => {
    polling = true
    try {
    for (const context of retained) {
      const { gl, extension } = context
      if (!extension || !context.pending.length) continue
      if (gl.isContextLost()) {
        for (const pending of context.pending.splice(0)) { gl.deleteQuery(pending.query); if (pending.epoch === epoch) abort(context, 'Context lost before query completion') }
        continue
      }
      disjointChecks++
      if (gl.getParameter(extension.GPU_DISJOINT_EXT)) {
        disjointEvents++
        for (const pending of context.pending.splice(0)) { gl.deleteQuery(pending.query); if (pending.epoch === epoch) abort(context, 'GPU disjoint invalidated elapsed query') }
        continue
      }
      for (let at = context.pending.length - 1; at >= 0; at--) {
        const pending = context.pending[at]!
        // Reading QUERY_RESULT is permitted only after the availability flag.
        if (!gl.getQueryParameter(pending.query, gl.QUERY_RESULT_AVAILABLE)) continue
        const ns = gl.getQueryParameter(pending.query, gl.QUERY_RESULT) as number
        context.pending.splice(at, 1); gl.deleteQuery(pending.query)
        if (pending.epoch !== epoch) continue
        if (!Number.isFinite(ns) || ns < 0) abort(context, 'Invalid completed elapsed query')
        else samples.push({ ...pending.sample, gpuNs: ns })
      }
    }
    } finally { polling = false }
  }
  const enqueue = (): void => {
    if (scheduled !== null || !recording && ![...retained].some(context => context.pending.length)) return
    scheduled = requestAnimationFrame(() => { scheduled = null; poll(); enqueue() })
  }
  const end = (context: Context): void => {
    const interval = context.active
    if (!interval) return
    context.active = null
    const { gl, extension } = context
    const endedMs = performance.now(), sample = { context: context.id, phase: interval.phase, startedMs: interval.started, endedMs, cpuSubmissionMs: endedMs - interval.started, drawCalls: interval.drawCalls, triangleVertices: interval.triangleVertices, lineVertices: interval.lineVertices }
    if (!interval.query || !extension) { if (interval.epoch === epoch) samples.push({ ...sample, gpuNs: null }); return }
    if (gl.isContextLost()) { gl.deleteQuery(interval.query); if (interval.epoch === epoch) abort(context, 'Context lost during physical program'); return }
    if (gl.getQuery(extension.TIME_ELAPSED_EXT, gl.CURRENT_QUERY) !== interval.query) { gl.deleteQuery(interval.query); if (interval.epoch === epoch) abort(context, 'Elapsed query ownership changed'); return }
    gl.endQuery(extension.TIME_ELAPSED_EXT)
    context.pending.push({ epoch: interval.epoch, query: interval.query, sample }); enqueue()
  }
  const begin = (context: Context, phase: Sample['phase']): void => {
    if (!recording) return
    const { gl, extension } = context
    let query: WebGLQuery | null = null
    if (extension) {
      if (gl.isContextLost()) { abort(context, 'Context lost before physical program'); return }
      if (gl.getQuery(extension.TIME_ELAPSED_EXT, gl.CURRENT_QUERY) !== null) busyIntervals++
      else {
        query = gl.createQuery()
        if (!query) abort(context, 'Unable to allocate elapsed query')
        else {
          gl.beginQuery(extension.TIME_ELAPSED_EXT, query)
          if (gl.getQuery(extension.TIME_ELAPSED_EXT, gl.CURRENT_QUERY) !== query) { gl.deleteQuery(query); query = null; abort(context, 'Elapsed query did not begin') }
        }
      }
    }
    context.active = { epoch, phase, started: performance.now(), query, drawCalls: 0, triangleVertices: 0, lineVertices: 0 }
  }
  const uniform = WebGL2RenderingContext.prototype.getUniformLocation
  WebGL2RenderingContext.prototype.getUniformLocation = function (program, name) {
    const location = uniform.call(this, program, name)
    if (name === 'uDepthNear' && location !== null) { physical.add(program); state(this) }
    return location
  }
  const use = WebGL2RenderingContext.prototype.useProgram
  WebGL2RenderingContext.prototype.useProgram = function (program) {
    const context = contexts.get(this)
    if (context?.active) end(context)
    use.call(this, program)
    if (program !== null && physical.has(program)) begin(state(this), 'draw')
  }
  const draw = WebGL2RenderingContext.prototype.drawArraysInstanced
  WebGL2RenderingContext.prototype.drawArraysInstanced = function (...args: Parameters<WebGL2RenderingContext['drawArraysInstanced']>) {
    const interval = contexts.get(this)?.active
    if (interval) {
      interval.drawCalls++
      if (args[0] === this.TRIANGLES) interval.triangleVertices += args[2] * args[3]
      else if (args[0] === this.LINES) interval.lineVertices += args[2] * args[3]
    }
    return draw.apply(this, args)
  }
  const blit = WebGL2RenderingContext.prototype.blitFramebuffer
  WebGL2RenderingContext.prototype.blitFramebuffer = function (...args: Parameters<WebGL2RenderingContext['blitFramebuffer']>) {
    const context = contexts.get(this), physicalResolve = context?.active?.phase === 'draw'
    if (!context || !physicalResolve) return blit.apply(this, args)
    // The owned pass resolves before it switches to the composite program.
    // End geometry timing before that blit instead of mislabelling resolve as
    // vertex/fragment draw work. No product target/binding is changed here.
    end(context); begin(context, 'resolve')
    try { return blit.apply(this, args) } finally { end(context) }
  }
  // Context-wide state readers include the real save/restore boundary as well
  // as host readers. The CPU trace must locate callers; this is not exclusively
  // physical-renderer time. Observer-owned disjoint polling is excluded.
  const parameter = WebGL2RenderingContext.prototype.getParameter
  WebGL2RenderingContext.prototype.getParameter = function (name: number): unknown {
    if (!recording || polling || !contexts.has(this)) return parameter.call(this, name)
    const at = performance.now(), result = parameter.call(this, name), key = `getParameter/${name}`, before = stateReads.get(key) ?? { calls: 0, cpuMs: 0 }
    before.calls++; before.cpuMs += performance.now() - at; stateReads.set(key, before); return result
  }
  const enabled = WebGL2RenderingContext.prototype.isEnabled
  WebGL2RenderingContext.prototype.isEnabled = function (name: number): boolean {
    if (!recording || polling || !contexts.has(this)) return enabled.call(this, name)
    const at = performance.now(), result = enabled.call(this, name), key = `isEnabled/${name}`, before = stateReads.get(key) ?? { calls: 0, cpuMs: 0 }
    before.calls++; before.cpuMs += performance.now() - at; stateReads.set(key, before); return result
  }
  const snapshot = () => {
    poll()
    const supported = [...retained].filter(context => context.extension !== null).map(context => context.id)
    const pending = [...retained].reduce((count, context) => count + context.pending.filter(value => value.epoch === epoch).length, 0), activeIntervals = [...retained].filter(context => context.active?.epoch === epoch).length
    return {
      diagnosticOnly: true,
      measurement: 'Separate physical draw (instance/status commands and solid/line submissions) and following MSAA colour resolve intervals; excludes owned-target clear and full-screen composite',
      supported: supported.length > 0,
      unsupported: [...retained].filter(context => context.extension === null).map(context => context.id),
      contexts: [...retained].map(context => ({ id: context.id, surface: surface(context), supported: context.extension !== null, contextLost: context.gl.isContextLost() })),
      recording, elapsedWallMs: performance.now() - started, samples, pending, activeIntervals,
      busyIntervals, disjointChecks, disjointEvents, aborted,
      contextStateReads: [...stateReads].map(([reader, value]) => ({ reader, ...value })),
      validGpuWindow: samples.length > 0 && samples.every(sample => sample.gpuNs !== null) && pending === 0 && activeIntervals === 0 && disjointEvents === 0 && aborted.length === 0 && busyIntervals === 0,
    }
  }
  const reset = (): void => {
    recording = false
    for (const context of retained) end(context)
    poll(); epoch++; samples = []; aborted = []; stateReads.clear(); busyIntervals = 0; disjointChecks = 0; disjointEvents = 0; started = performance.now(); recording = true; enqueue()
  }
  const stop = () => { recording = false; for (const context of retained) end(context); return snapshot() }
  const settle = async () => {
    stop()
    while ([...retained].some(context => context.pending.some(value => value.epoch === epoch))) await new Promise<void>(resolve => requestAnimationFrame(() => { poll(); resolve() }))
    return snapshot()
  }
  Object.assign(window, { __nativePhysicalGpuProof: { reset, snapshot, stop, settle } })
})()
