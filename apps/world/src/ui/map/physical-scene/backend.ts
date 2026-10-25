import type { PhysicalMesh } from './geometry.ts'
import type { PhysicalScenePalette, PhysicalSubjectStyle } from './types.ts'

const vertexSource = `#version 300 es
precision highp float;
layout(location=0) in vec3 position;
layout(location=1) in vec3 normal;
layout(location=2) in vec3 color;
uniform mat4 uMatrix;
uniform vec3 uOffset;
out vec3 vNormal;
out vec3 vColor;
void main(){ gl_Position=uMatrix*vec4(position+uOffset,1.); vNormal=normal; vColor=color; }
`
const fragmentSource = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vColor;
uniform vec3 uStatusColor;
uniform vec3 uLineColor;
uniform float uEmphasis;
uniform bool uFlat;
uniform bool uLines;
out vec4 outColor;
void main(){
  vec3 n=normalize(vNormal);
  float light=uFlat ? 1. : .67+.25*max(dot(n,normalize(vec3(-.45,-.55,.88))),0.)+.08*max(dot(n,normalize(vec3(.65,.4,.5))),0.);
  vec3 base=uLines ? uLineColor : vColor*light;
  outColor=vec4(mix(base,uStatusColor,uLines ? 0. : uEmphasis),1.);
}
`
interface GpuMesh { readonly vao: WebGLVertexArrayObject; readonly buffer: WebGLBuffer; readonly count: number; readonly lineVao: WebGLVertexArrayObject; readonly lineBuffer: WebGLBuffer; readonly lineCount: number; readonly bytes: number }
export interface PhysicalBackendMetrics { geometryUploads: number; geometryBytes: number; draws: number; buffers: number; programs: number; liveBuffersAfterDisposal: number | null; liveProgramsAfterDisposal: number | null }
export interface PhysicalDraw { readonly mesh: PhysicalMesh; readonly matrix: Float32Array; readonly flat: boolean; readonly style: PhysicalSubjectStyle | null }

export const createPhysicalBackend = (gl: WebGL2RenderingContext, palette: PhysicalScenePalette) => {
  const shaders: WebGLShader[] = []
  let program: WebGLProgram | null = null
  try {
    for (const [kind, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]] as const) {
      const shader = gl.createShader(kind)
      if (!shader) throw new Error('Unable to allocate physical scene shader')
      shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'Physical scene shader compilation failed')
    }
    program = gl.createProgram()
    if (!program) throw new Error('Unable to allocate physical scene program')
    for (const shader of shaders) gl.attachShader(program, shader)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'Physical scene program linking failed')
  } catch (error) { if (program) gl.deleteProgram(program); throw error }
  finally { for (const shader of shaders) gl.deleteShader(shader) }
  const ownedProgram = program
  const uniforms = Object.fromEntries(['uMatrix', 'uOffset', 'uStatusColor', 'uLineColor', 'uEmphasis', 'uFlat', 'uLines'].map(name => [name, gl.getUniformLocation(ownedProgram, name)]))
  const cache = new Map<PhysicalMesh, GpuMesh>()
  const metrics: PhysicalBackendMetrics = { geometryUploads: 0, geometryBytes: 0, draws: 0, buffers: 0, programs: 1, liveBuffersAfterDisposal: null, liveProgramsAfterDisposal: null }
  let disposed = false
  const release = (gpu: GpuMesh): void => {
    gl.deleteBuffer(gpu.buffer); gl.deleteBuffer(gpu.lineBuffer)
    gl.deleteVertexArray(gpu.vao); gl.deleteVertexArray(gpu.lineVao)
    metrics.geometryBytes -= gpu.bytes; metrics.buffers -= 2
  }
  const bufferFor = (data: Float32Array, stride: number): { vao: WebGLVertexArrayObject; buffer: WebGLBuffer } => {
    const vao = gl.createVertexArray(), buffer = gl.createBuffer()
    if (!vao || !buffer) { if (vao) gl.deleteVertexArray(vao); if (buffer) gl.deleteBuffer(buffer); throw new Error('Unable to allocate physical scene geometry') }
    gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
    for (let attribute = 0; attribute < 3; attribute++) {
      if (stride === 3 && attribute > 0) { gl.disableVertexAttribArray(attribute); continue }
      gl.enableVertexAttribArray(attribute); gl.vertexAttribPointer(attribute, 3, gl.FLOAT, false, stride * 4, attribute * 12)
    }
    return { vao, buffer }
  }
  const upload = (mesh: PhysicalMesh): GpuMesh => {
    const cached = cache.get(mesh)
    if (cached) return cached
    const data = new Float32Array(mesh.vertices.length / 7 * 9)
    for (let index = 0, target = 0; index < mesh.vertices.length; index += 7, target += 9) {
      data.set(mesh.vertices.slice(index, index + 6), target)
      const role = mesh.object.materials?.[mesh.vertices[index + 6]!] ?? mesh.object.material ?? mesh.object.kind
      const color = palette.materials[role] ?? palette.defaultMaterial
      data.set(color, target + 6)
    }
    const solid = bufferFor(data, 9)
    let line: ReturnType<typeof bufferFor>
    try { line = bufferFor(new Float32Array(mesh.lines), 3) } catch (error) { gl.deleteBuffer(solid.buffer); gl.deleteVertexArray(solid.vao); throw error }
    const gpu = { vao: solid.vao, buffer: solid.buffer, count: data.length / 9, lineVao: line.vao, lineBuffer: line.buffer, lineCount: mesh.lines.length / 3, bytes: data.byteLength + mesh.lines.length * 4 }
    cache.set(mesh, gpu); metrics.geometryUploads++; metrics.geometryBytes += gpu.bytes; metrics.buffers += 2
    return gpu
  }
  return {
    metrics,
    draw(draws: ReadonlyArray<PhysicalDraw>): void {
      if (disposed) throw new Error('Physical scene renderer has been disposed')
      const used = new Set(draws.map(draw => draw.mesh))
      for (const [mesh, gpu] of cache) if (!used.has(mesh)) { release(gpu); cache.delete(mesh) }
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE); gl.disable(gl.STENCIL_TEST); gl.colorMask(true, true, true, true)
      gl.useProgram(ownedProgram); gl.uniform3fv(uniforms.uLineColor!, palette.line)
      for (const draw of draws) {
        const gpu = upload(draw.mesh)
        gl.uniformMatrix4fv(uniforms.uMatrix!, false, draw.matrix); gl.uniform3fv(uniforms.uOffset!, draw.mesh.offset)
        gl.uniform3fv(uniforms.uStatusColor!, draw.style?.color ?? palette.defaultMaterial); gl.uniform1f(uniforms.uEmphasis!, draw.style?.color ? draw.style.emphasis : 0)
        gl.uniform1i(uniforms.uFlat!, Number(draw.flat)); gl.uniform1i(uniforms.uLines!, 0)
        gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1, 1)
        gl.bindVertexArray(gpu.vao); gl.drawArrays(gl.TRIANGLES, 0, gpu.count); metrics.draws++
        gl.disable(gl.POLYGON_OFFSET_FILL); gl.uniform1i(uniforms.uLines!, 1)
        gl.bindVertexArray(gpu.lineVao); gl.drawArrays(gl.LINES, 0, gpu.lineCount); metrics.draws++
      }
    },
    dispose(): void {
      if (disposed) return
      const buffers = [...cache.values()].flatMap(gpu => [gpu.buffer, gpu.lineBuffer])
      for (const gpu of cache.values()) release(gpu)
      cache.clear(); gl.deleteProgram(ownedProgram); metrics.programs = 0; disposed = true
      metrics.liveBuffersAfterDisposal = buffers.filter(buffer => gl.isBuffer(buffer)).length
      metrics.liveProgramsAfterDisposal = Number(gl.isProgram(ownedProgram))
    },
  }
}
