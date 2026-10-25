type GL = WebGL2RenderingContext

/** State changed by physical drawing and its owned Plan pass; the host target is never cleared. */
export const captureSceneGlState = (gl: GL) => {
  const activeTexture = gl.getParameter(gl.ACTIVE_TEXTURE) as number
  gl.activeTexture(gl.TEXTURE0); const texture0 = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null; const sampler0 = gl.getParameter(gl.SAMPLER_BINDING) as WebGLSampler | null
  gl.activeTexture(gl.TEXTURE1); const texture1 = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null; const sampler1 = gl.getParameter(gl.SAMPLER_BINDING) as WebGLSampler | null
  gl.activeTexture(activeTexture)
  return { activeTexture, texture0, texture1, sampler0, sampler1,
  drawFramebuffer: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null, readFramebuffer: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null, renderbuffer: gl.getParameter(gl.RENDERBUFFER_BINDING) as WebGLRenderbuffer | null,
  viewport: Array.from(gl.getParameter(gl.VIEWPORT) as Int32Array) as [number, number, number, number], scissor: gl.isEnabled(gl.SCISSOR_TEST), depthRange: Array.from(gl.getParameter(gl.DEPTH_RANGE) as Float32Array) as [number, number], clearColor: Array.from(gl.getParameter(gl.COLOR_CLEAR_VALUE) as Float32Array) as [number, number, number, number], clearDepth: gl.getParameter(gl.DEPTH_CLEAR_VALUE) as number,
  program: gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null,
  vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null,
  arrayBuffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null,
  depthTest: gl.isEnabled(gl.DEPTH_TEST),
  depthFunction: gl.getParameter(gl.DEPTH_FUNC) as number,
  depthMask: gl.getParameter(gl.DEPTH_WRITEMASK) as boolean,
  blend: gl.isEnabled(gl.BLEND), blendEquationRgb: gl.getParameter(gl.BLEND_EQUATION_RGB) as number, blendEquationAlpha: gl.getParameter(gl.BLEND_EQUATION_ALPHA) as number,
  blendSrcRgb: gl.getParameter(gl.BLEND_SRC_RGB) as number, blendDstRgb: gl.getParameter(gl.BLEND_DST_RGB) as number,
  blendSrcAlpha: gl.getParameter(gl.BLEND_SRC_ALPHA) as number, blendDstAlpha: gl.getParameter(gl.BLEND_DST_ALPHA) as number,
  lineWidth: gl.getParameter(gl.LINE_WIDTH) as number,
  cull: gl.isEnabled(gl.CULL_FACE),
  stencil: gl.isEnabled(gl.STENCIL_TEST),
  polygonOffset: gl.isEnabled(gl.POLYGON_OFFSET_FILL),
  polygonFactor: gl.getParameter(gl.POLYGON_OFFSET_FACTOR) as number,
  polygonUnits: gl.getParameter(gl.POLYGON_OFFSET_UNITS) as number,
  colorMask: gl.getParameter(gl.COLOR_WRITEMASK) as [boolean, boolean, boolean, boolean],
} }
export const restoreSceneGlState = (gl: GL, state: ReturnType<typeof captureSceneGlState>): void => {
  const toggle = (capability: number, enabled: boolean): void => enabled ? gl.enable(capability) : gl.disable(capability)
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, state.drawFramebuffer); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, state.readFramebuffer); gl.bindRenderbuffer(gl.RENDERBUFFER, state.renderbuffer)
  gl.viewport(...state.viewport); toggle(gl.SCISSOR_TEST, state.scissor); gl.depthRange(...state.depthRange); gl.clearColor(...state.clearColor); gl.clearDepth(state.clearDepth)
  gl.useProgram(state.program)
  gl.bindVertexArray(state.vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, state.arrayBuffer)
  toggle(gl.DEPTH_TEST, state.depthTest)
  gl.depthFunc(state.depthFunction)
  gl.depthMask(state.depthMask)
  toggle(gl.BLEND, state.blend)
  gl.blendEquationSeparate(state.blendEquationRgb, state.blendEquationAlpha)
  gl.blendFuncSeparate(state.blendSrcRgb, state.blendDstRgb, state.blendSrcAlpha, state.blendDstAlpha)
  gl.lineWidth(state.lineWidth)
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, state.texture0)
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, state.texture1)
  gl.bindSampler(0, state.sampler0); gl.bindSampler(1, state.sampler1)
  gl.activeTexture(state.activeTexture)
  toggle(gl.CULL_FACE, state.cull)
  toggle(gl.STENCIL_TEST, state.stencil)
  toggle(gl.POLYGON_OFFSET_FILL, state.polygonOffset)
  gl.polygonOffset(state.polygonFactor, state.polygonUnits)
  gl.colorMask(...state.colorMask)
}
