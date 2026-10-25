import type { CustomLayerInterface } from 'maplibre-gl'

/** Test instrumentation only: checks every shared-context field, beyond the renderer's own guard. */
export const fullGlState = (gl: WebGL2RenderingContext) => {
  const parameters = ['CURRENT_PROGRAM', 'VERTEX_ARRAY_BINDING', 'ARRAY_BUFFER_BINDING', 'FRAMEBUFFER_BINDING', 'READ_FRAMEBUFFER_BINDING', 'RENDERBUFFER_BINDING', 'VIEWPORT', 'SCISSOR_BOX', 'DEPTH_FUNC', 'DEPTH_WRITEMASK', 'DEPTH_RANGE', 'BLEND_SRC_RGB', 'BLEND_DST_RGB', 'BLEND_SRC_ALPHA', 'BLEND_DST_ALPHA', 'BLEND_EQUATION_RGB', 'BLEND_EQUATION_ALPHA', 'BLEND_COLOR', 'CULL_FACE_MODE', 'FRONT_FACE', 'STENCIL_FUNC', 'STENCIL_REF', 'STENCIL_VALUE_MASK', 'STENCIL_WRITEMASK', 'STENCIL_FAIL', 'STENCIL_PASS_DEPTH_FAIL', 'STENCIL_PASS_DEPTH_PASS', 'STENCIL_BACK_FUNC', 'STENCIL_BACK_REF', 'STENCIL_BACK_VALUE_MASK', 'STENCIL_BACK_WRITEMASK', 'STENCIL_BACK_FAIL', 'STENCIL_BACK_PASS_DEPTH_FAIL', 'STENCIL_BACK_PASS_DEPTH_PASS', 'POLYGON_OFFSET_FACTOR', 'POLYGON_OFFSET_UNITS', 'COLOR_WRITEMASK', 'ACTIVE_TEXTURE', 'TEXTURE_BINDING_2D', 'TEXTURE_BINDING_CUBE_MAP', 'LINE_WIDTH', 'COLOR_CLEAR_VALUE', 'DEPTH_CLEAR_VALUE', 'STENCIL_CLEAR_VALUE'] as const
  const values = new Map<string, unknown>(parameters.map(name => { const value: unknown = gl.getParameter(gl[name]); return [name, ArrayBuffer.isView(value) ? Array.from(value as unknown as ArrayLike<number>) : value] }))
  const active = gl.getParameter(gl.ACTIVE_TEXTURE) as number
  for (const unit of [gl.TEXTURE0, gl.TEXTURE1]) { gl.activeTexture(unit); values.set(`texture2D/${unit}`, gl.getParameter(gl.TEXTURE_BINDING_2D)); values.set(`sampler/${unit}`, gl.getParameter(gl.SAMPLER_BINDING)) }
  gl.activeTexture(active)
  for (const name of ['SCISSOR_TEST', 'DEPTH_TEST', 'BLEND', 'CULL_FACE', 'STENCIL_TEST', 'POLYGON_OFFSET_FILL', 'DITHER'] as const) values.set(name, gl.isEnabled(gl[name]))
  return values
}
export const stateDifferences = (a: ReadonlyMap<string, unknown>, b: ReadonlyMap<string, unknown>): string[] => [...a].flatMap(([key, value]) => {
  const other = b.get(key)
  return Array.isArray(value) && Array.isArray(other) ? JSON.stringify(value) === JSON.stringify(other) ? [] : [key] : value === other ? [] : [key]
})

/** A preceding colour/depth/stencil survives the real physical layer; a later far fragment must fail depth. */
export const sentinel = (id: string, after: boolean): CustomLayerInterface => {
  let program: WebGLProgram, vao: WebGLVertexArrayObject, buffer: WebGLBuffer
  return {
    id, type: 'custom', renderingMode: '3d',
    onAdd(_map, gl) {
      const shader = (kind: number, source: string) => { const value = gl.createShader(kind)!; gl.shaderSource(value, source); gl.compileShader(value); if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(value)!); return value }
      program = gl.createProgram()!
      const vertex = shader(gl.VERTEX_SHADER, '#version 300 es\nin vec2 p;uniform float z;uniform float dx;void main(){gl_Position=vec4(p+vec2(dx,0.),z,1.);}')
      const fragment = shader(gl.FRAGMENT_SHADER, '#version 300 es\nprecision highp float;uniform vec3 color;out vec4 c;void main(){c=vec4(color,1.);}')
      gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program); gl.deleteShader(vertex); gl.deleteShader(fragment)
      vao = gl.createVertexArray()!; buffer = gl.createBuffer()!; gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-.95, -.95, -.75, -.95, -.75, -.75, -.95, -.95, -.75, -.75, -.95, -.75]), gl.STATIC_DRAW)
      const attribute = gl.getAttribLocation(program, 'p'); gl.enableVertexAttribArray(attribute); gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 8, 0)
    },
    render(gl) {
      // The probes own their state; MapLibre resets its custom-layer defaults for the next layer.
      gl.useProgram(program); gl.bindVertexArray(vao); gl.disable(gl.SCISSOR_TEST); gl.disable(gl.BLEND); gl.colorMask(true, true, true, true)
      const draw = (x: number, z: number, color: [number, number, number]) => { gl.uniform1f(gl.getUniformLocation(program, 'dx'), x); gl.uniform1f(gl.getUniformLocation(program, 'z'), z); gl.uniform3f(gl.getUniformLocation(program, 'color'), ...color); gl.drawArrays(gl.TRIANGLES, 0, 6) }
      if (!after) {
        gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true); gl.disable(gl.STENCIL_TEST); draw(0, .5, [.8, .1, .7])
        gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.enable(gl.STENCIL_TEST); gl.stencilFunc(gl.ALWAYS, 7, 0xff); gl.stencilOp(gl.REPLACE, gl.REPLACE, gl.REPLACE); gl.stencilMask(0xff); draw(.85, .5, [.15, .2, .2])
      } else {
        gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(false); gl.disable(gl.STENCIL_TEST); draw(0, .8, [.1, .2, .9])
        gl.disable(gl.DEPTH_TEST); draw(1.7, .5, [.1, .8, .2])
        gl.enable(gl.STENCIL_TEST); gl.stencilFunc(gl.EQUAL, 7, 0xff); gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP); gl.stencilMask(0); draw(.85, .5, [.9, .8, .1])
      }
      gl.disable(gl.STENCIL_TEST); gl.stencilMask(0xff); gl.depthMask(true)
    },
    onRemove(_map, gl) { gl.deleteProgram(program); gl.deleteVertexArray(vao); gl.deleteBuffer(buffer) },
  }
}
