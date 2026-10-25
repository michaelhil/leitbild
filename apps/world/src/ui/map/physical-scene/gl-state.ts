type GL = WebGL2RenderingContext

/** Only the state this renderer changes; it never clears or replaces MapLibre's render target. */
export const captureSceneGlState = (gl: GL) => ({
  program: gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null,
  vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null,
  arrayBuffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null,
  depthTest: gl.isEnabled(gl.DEPTH_TEST),
  depthFunction: gl.getParameter(gl.DEPTH_FUNC) as number,
  depthMask: gl.getParameter(gl.DEPTH_WRITEMASK) as boolean,
  blend: gl.isEnabled(gl.BLEND),
  cull: gl.isEnabled(gl.CULL_FACE),
  stencil: gl.isEnabled(gl.STENCIL_TEST),
  polygonOffset: gl.isEnabled(gl.POLYGON_OFFSET_FILL),
  polygonFactor: gl.getParameter(gl.POLYGON_OFFSET_FACTOR) as number,
  polygonUnits: gl.getParameter(gl.POLYGON_OFFSET_UNITS) as number,
  colorMask: gl.getParameter(gl.COLOR_WRITEMASK) as [boolean, boolean, boolean, boolean],
})
export const restoreSceneGlState = (gl: GL, state: ReturnType<typeof captureSceneGlState>): void => {
  const toggle = (capability: number, enabled: boolean): void => enabled ? gl.enable(capability) : gl.disable(capability)
  gl.useProgram(state.program)
  gl.bindVertexArray(state.vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, state.arrayBuffer)
  toggle(gl.DEPTH_TEST, state.depthTest)
  gl.depthFunc(state.depthFunction)
  gl.depthMask(state.depthMask)
  toggle(gl.BLEND, state.blend)
  toggle(gl.CULL_FACE, state.cull)
  toggle(gl.STENCIL_TEST, state.stencil)
  toggle(gl.POLYGON_OFFSET_FILL, state.polygonOffset)
  gl.polygonOffset(state.polygonFactor, state.polygonUnits)
  gl.colorMask(...state.colorMask)
}
