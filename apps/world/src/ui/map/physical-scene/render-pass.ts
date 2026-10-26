export interface PhysicalRenderPassMetrics {
  readonly depthFormat: 'float32'; readonly samples: number; readonly programs: number; readonly textures: number; readonly framebuffers: number; readonly renderbuffers: number; readonly bytes: number; readonly textureBytes: number; readonly allocations: number; readonly composites: number
  readonly liveTextures: number | null; readonly livePrograms: number | null; readonly liveFramebuffers: number | null; readonly liveRenderbuffers: number | null
}

/** Owned physical depth and shared antialiasing. Only colour is composited into either host. */
export const createPhysicalRenderPass = (gl: WebGL2RenderingContext) => {
  const colorSamples = [...gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA8, gl.SAMPLES) as Int32Array]
  const depthSamples = new Set([...gl.getInternalformatParameter(gl.RENDERBUFFER, gl.DEPTH_COMPONENT32F, gl.SAMPLES) as Int32Array])
  const samples = Math.max(0, ...colorSamples.filter(value => depthSamples.has(value)))
  const shaders: WebGLShader[] = []
  let program: WebGLProgram | null = null, vao: WebGLVertexArrayObject | null = null
  try {
    for (const [kind, source] of [[gl.VERTEX_SHADER, '#version 300 es\nprecision highp float;out vec2 uv;void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));uv=p;gl_Position=vec4(p*2.-1.,0.,1.);}'], [gl.FRAGMENT_SHADER, '#version 300 es\nprecision highp float;in vec2 uv;uniform sampler2D image;out vec4 color;void main(){color=texture(image,uv);}']] as const) {
      const shader = gl.createShader(kind); if (!shader) throw Error('Unable to allocate physical composite shader')
      shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(shader) ?? 'physical composite shader compilation failed')
    }
    program = gl.createProgram(); if (!program) throw Error('Unable to allocate physical composite program')
    for (const shader of shaders) gl.attachShader(program, shader)
    gl.linkProgram(program); if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program) ?? 'physical composite linking failed')
    vao = gl.createVertexArray(); if (!vao) throw Error('Unable to allocate physical composite vertex array')
  } catch (error) { if (vao) gl.deleteVertexArray(vao); if (program) gl.deleteProgram(program); throw error }
  finally { for (const shader of shaders) gl.deleteShader(shader) }
  const ownedProgram = program, ownedVao = vao, image = gl.getUniformLocation(ownedProgram, 'image')
  interface Targets { width: number; height: number; samples: number; texture: WebGLTexture; draw: WebGLFramebuffer; resolve: WebGLFramebuffer; depth: WebGLRenderbuffer; color: WebGLRenderbuffer | null }
  let targets: Targets | null = null, disposed = false, allocations = 0, composites = 0
  const final = { liveTextures: null as number | null, livePrograms: null as number | null, liveFramebuffers: null as number | null, liveRenderbuffers: null as number | null }
  const releaseTargets = (value: Targets): void => {
    gl.deleteTexture(value.texture); gl.deleteRenderbuffer(value.depth); if (value.color) gl.deleteRenderbuffer(value.color)
    gl.deleteFramebuffer(value.resolve); if (value.draw !== value.resolve) gl.deleteFramebuffer(value.draw)
  }
  const allocate = (width: number, height: number, samples: number): Targets => {
    const texture = gl.createTexture(), resolve = gl.createFramebuffer(), depth = gl.createRenderbuffer(), color = samples > 0 ? gl.createRenderbuffer() : null, draw = samples > 0 ? gl.createFramebuffer() : resolve
    const clean = () => { if (texture) gl.deleteTexture(texture); if (depth) gl.deleteRenderbuffer(depth); if (color) gl.deleteRenderbuffer(color); if (resolve) gl.deleteFramebuffer(resolve); if (draw && draw !== resolve) gl.deleteFramebuffer(draw) }
    if (!texture || !resolve || !depth || !draw || (samples > 0 && !color)) { clean(); throw Error('Unable to allocate owned physical render target') }
    try {
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.bindFramebuffer(gl.FRAMEBUFFER, resolve); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
      gl.bindFramebuffer(gl.FRAMEBUFFER, draw); gl.bindRenderbuffer(gl.RENDERBUFFER, depth)
      if (samples > 0) gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT32F, width, height)
      else gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT32F, width, height)
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth)
      if (color) { gl.bindRenderbuffer(gl.RENDERBUFFER, color); gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, width, height); gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color) }
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw Error('Owned physical render target is incomplete')
      gl.bindFramebuffer(gl.FRAMEBUFFER, resolve)
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw Error('Owned physical colour resolve target is incomplete')
      allocations++; return { width, height, samples, texture, draw, resolve, depth, color }
    } catch (error) { clean(); throw error }
  }
  return {
    begin(width: number, height: number): void {
      if (disposed) throw Error('physical pass has been disposed')
      if (!targets || targets.width !== width || targets.height !== height || targets.samples !== samples) { if (targets) releaseTargets(targets); targets = null; targets = allocate(width, height, samples) }
      gl.bindFramebuffer(gl.FRAMEBUFFER, targets.draw); gl.viewport(0, 0, width, height); gl.disable(gl.SCISSOR_TEST); gl.depthRange(0, 1); gl.colorMask(true, true, true, true); gl.depthMask(true)
      gl.clearColor(0, 0, 0, 0); gl.clearDepth(0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    },
    composite(draw: WebGLFramebuffer | null, read: WebGLFramebuffer | null, viewport: readonly [number, number, number, number]): void {
      if (!targets) throw Error('physical render target was not initialized')
      if (targets.draw !== targets.resolve) {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, targets.draw); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, targets.resolve)
        gl.blitFramebuffer(0, 0, targets.width, targets.height, 0, 0, targets.width, targets.height, gl.COLOR_BUFFER_BIT, gl.NEAREST)
      }
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read); gl.viewport(...viewport)
      gl.disable(gl.SCISSOR_TEST); gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.disable(gl.STENCIL_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.POLYGON_OFFSET_FILL); gl.enable(gl.BLEND)
      gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD); gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.colorMask(true, true, true, true)
      gl.useProgram(ownedProgram); gl.bindVertexArray(ownedVao); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, targets.texture); gl.bindSampler(0, null); gl.uniform1i(image, 0); gl.drawArrays(gl.TRIANGLES, 0, 3); composites++
    },
    metrics: (): PhysicalRenderPassMetrics => ({ depthFormat: 'float32', samples: targets?.samples ?? samples, programs: disposed ? 0 : 1, textures: targets ? 1 : 0, framebuffers: targets ? targets.draw === targets.resolve ? 1 : 2 : 0, renderbuffers: targets ? targets.color ? 2 : 1 : 0, bytes: targets ? targets.width * targets.height * 4 * (1 + (targets.color ? targets.samples * 2 : 1)) : 0, textureBytes: targets ? targets.width * targets.height * 4 : 0, allocations, composites, ...final }),
    dispose(): void {
      if (disposed) return
      const prior = targets; if (prior) releaseTargets(prior); targets = null
      gl.deleteProgram(ownedProgram); gl.deleteVertexArray(ownedVao); disposed = true
      final.liveTextures = prior ? Number(gl.isTexture(prior.texture)) : 0; final.livePrograms = Number(gl.isProgram(ownedProgram))
      final.liveFramebuffers = prior ? Number(gl.isFramebuffer(prior.draw)) + (prior.draw !== prior.resolve ? Number(gl.isFramebuffer(prior.resolve)) : 0) : 0
      final.liveRenderbuffers = prior ? Number(gl.isRenderbuffer(prior.depth)) + (prior.color ? Number(gl.isRenderbuffer(prior.color)) : 0) : 0
    },
  }
}
