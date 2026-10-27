// Test-only native GL wall-time attribution. Installed BEFORE other observers.
(() => {
  type Counter = { calls: number; wallMs: number; maxMs: number; slowCalls: number }
  const methods = ['bufferData','bufferSubData','texImage2D','texSubImage2D','drawArrays','drawArraysInstanced','drawElements','drawElementsInstanced','uniform1i','uniform1f','uniform2f','uniform3f','uniformMatrix4fv','depthFunc','useProgram','bindVertexArray','bindBuffer','bindTexture','bindFramebuffer','bindRenderbuffer','bindSampler','activeTexture','viewport','enable','disable','blendFuncSeparate','blendEquationSeparate','colorMask','depthMask','clear','blitFramebuffer','getParameter','isEnabled','getShaderParameter','getProgramParameter','checkFramebufferStatus','readPixels','flush','fenceSync','clientWaitSync','getQueryParameter'] as const
  const proto = WebGL2RenderingContext.prototype as any, programs = new WeakSet<WebGLProgram>(), current = new WeakMap<WebGL2RenderingContext,WebGLProgram|null>(), ordered = new WeakMap<WebGLProgram,boolean>(), locations = new WeakMap<WebGLUniformLocation,WebGLProgram>(), contexts = new WeakMap<WebGL2RenderingContext,number>()
  let sequence = 0, recording = false, started = 0, nativeMs = 0, bookkeepingMs = 0, outerExtraMs = 0, outerInstalled = false, depth = 0
  let counters = new Map<string,Counter>(), slow: any[] = []
  for (const name of methods) {
    const original = proto[name]
    if (typeof original !== 'function') throw Error(`Missing actual GL method ${name}`)
    proto[name] = function(this:WebGL2RenderingContext,...args:any[]) {
      const program = name === 'useProgram' ? args[0] as WebGLProgram|null : current.get(this), label = program && programs.has(program) ? ordered.get(program) ? 'ordered' : 'physical-base' : 'other'
      const active = recording, at = active ? performance.now() : 0
      let result: any
      try { result = Reflect.apply(original,this,args); return result }
      finally {
        const end = active ? performance.now() : 0
        if(name === 'useProgram') current.set(this,args[0])
        else if(name === 'getUniformLocation' && result) { if(args[1] === 'uDepthNear') programs.add(args[0]); if(args[1] === 'uOrdered') locations.set(result,args[0]) }
        else if(name === 'uniform1i' && args[0]) { const owner = locations.get(args[0]); if(owner) ordered.set(owner,Boolean(args[1])) }
        if(active) {
          const ms = end-at, key = `${name}/${label}`, before = counters.get(key) ?? {calls:0,wallMs:0,maxMs:0,slowCalls:0}
          nativeMs += ms; before.calls++; before.wallMs += ms; before.maxMs = Math.max(before.maxMs,ms)
          // Threshold affects diagnostic detail only, never product rendering.
          // Every native call remains in the aggregate; no slow-record count cap.
          if(ms >= 1) { before.slowCalls++; let id = contexts.get(this); if(id === undefined) { id = ++sequence; contexts.set(this,id) }; slow.push({name,label,context:id,started:at,durationMs:ms,args:args.map(value=>typeof value === 'number' ? value : ArrayBuffer.isView(value) ? {typedBytes:value.byteLength} : null),stack:new Error().stack}) }
          counters.set(key,before); bookkeepingMs += performance.now()-end
        }
      }
    }
  }
  const api = {
    installOuterObserver() {
      if(outerInstalled)throw Error('GL outer observer already installed');outerInstalled=true
      for(const name of methods) {
        const observed=proto[name]
        proto[name]=function(this:WebGL2RenderingContext,...args:any[]) {
          if(!recording)return Reflect.apply(observed,this,args)
          const outer=depth++===0,at=outer?performance.now():0,before=nativeMs
          try{return Reflect.apply(observed,this,args)}finally{depth--;if(outer)outerExtraMs+=Math.max(0,performance.now()-at-(nativeMs-before))}
        }
      }
    },
    reset(){counters=new Map();slow=[];nativeMs=bookkeepingMs=outerExtraMs=0;started=performance.now();recording=true},
    stop(){recording=false},
    snapshot(){return{diagnosticOnly:true,started,elapsedMs:performance.now()-started,recording,nativeWallMs:nativeMs,innerBookkeepingMs:bookkeepingMs,outerExtraMs,existingObserverPlusOuterProbeMs:Math.max(0,outerExtraMs-bookkeepingMs),methods:[...counters].map(([method,value])=>({method,...value})),slow,limits:['Native calls are timed inside pre-existing product/GPU observers. Labels describe the bound program, not responsibility for earlier queued work.','Outer extra excludes measured native time; it includes original observers plus this diagnostic wrapper. Subtracting measured inner bookkeeping still includes outer timer overhead and clock quantization.','All >=1ms native calls retain stacks, without a count cap. Every watched call is aggregated. Threshold is diagnostic only.','This observer perturbs pacing and cannot issue a clean frame-budget verdict. Native walltime can include driver/GPU waits; it is not CPU utilization.']}}
  }
  ;(window as any).__nativePhysicalGlWallProof=api
})()
