import type { PhysicalMesh } from './geometry.ts'
import type { PhysicalPreparedGeometry } from './preparation.ts'
import type { PhysicalScenePalette, PhysicalSubjectStyle } from './types.ts'

const vertexSource = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in vec3 position;
layout(location=1) in vec3 normal;
layout(location=2) in float materialIndex;
layout(location=3) in float objectIndex;
layout(location=4) in float strokeStyle;
layout(location=5) in mat4 instanceMatrix;
layout(location=9) in float instanceData;
uniform sampler2D uObjects;
uniform int uObjectWidth;
out vec3 vNormal;
flat out int vMaterial;
flat out int vObject;
flat out float vStroke;
vec4 objectData(int i){return texelFetch(uObjects,ivec2(i%uObjectWidth,i/uObjectWidth),0);}
void main(){
  int i=int(instanceData)+int(objectIndex)*2;
  vec4 placement=objectData(i+1);
  gl_Position=placement.w<.5?vec4(2.,2.,2.,1.):instanceMatrix*vec4(position+placement.xyz,1.);
  vNormal=normal;vMaterial=int(materialIndex);vObject=i;vStroke=strokeStyle;
}
`
const fragmentSource = `#version 300 es
precision highp float;
precision highp int;
in vec3 vNormal;
flat in int vMaterial;
flat in int vObject;
flat in float vStroke;
uniform sampler2D uMaterials;
uniform sampler2D uObjects;
uniform int uMaterialWidth;
uniform int uObjectWidth;
uniform bool uFlat;
uniform bool uLines;
uniform vec2 uLineOpacity;
out vec4 outColor;
void main(){
  vec3 n=normalize(vNormal);
  float light=uFlat?1.:.67+.25*max(dot(n,normalize(vec3(-.45,-.55,.88))),0.)+.08*max(dot(n,normalize(vec3(.65,.4,.5))),0.);
  vec3 material=texelFetch(uMaterials,ivec2(vMaterial%uMaterialWidth,vMaterial/uMaterialWidth),0).rgb;
  vec4 state=texelFetch(uObjects,ivec2(vObject%uObjectWidth,vObject/uObjectWidth),0);
  float alpha=!uLines||uFlat||vStroke>1.5?1.:vStroke>.5?uLineOpacity.y:uLineOpacity.x;
  outColor=vec4(uLines?material:mix(material*light,state.rgb,state.a),alpha);
}
`
export interface PhysicalBackendMetrics {
  geometryUploads: number; geometryBytes: number; draws: number; buffers: number; programs: number
  textures: number; textureBytes: number; instanceBytes: number; instanceUploads: number; statusUploads: number; paletteUploads: number; evictions: number; peakRequiredBytes: number
  liveBuffersAfterDisposal: number | null; liveProgramsAfterDisposal: number | null; liveTexturesAfterDisposal: number | null
}
export interface PhysicalDraw {
  readonly asset: PhysicalPreparedGeometry
  readonly matrix: Float32Array
  readonly flat: boolean
  readonly meshes: ReadonlyArray<PhysicalMesh>
  readonly styles: ReadonlyArray<PhysicalSubjectStyle | null>
}
interface Texture { readonly texture: WebGLTexture; width: number; height: number; data: Float32Array }
interface Asset {
  readonly identity: string; readonly solid: WebGLBuffer; readonly lines: WebGLBuffer; readonly instances: WebGLBuffer; readonly vao: WebGLVertexArrayObject; readonly lineVao: WebGLVertexArrayObject
  readonly count: number; readonly lineCount: number; readonly geometryBytes: number; readonly materials: Texture; readonly objects: Texture
  instanceData: Float32Array; lastUsed: number; roles: ReadonlyArray<string>; paletteSignature: string
}

/** Retained local buffers, instanced placements and separate palette/status tables. */
export const createPhysicalBackend = (gl: WebGL2RenderingContext, initialPalette: PhysicalScenePalette) => {
  let palette = initialPalette, disposed = false, frame = 0
  const shaders: WebGLShader[] = [], cache = new Map<string, Asset>(), maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
  let program: WebGLProgram | null = null
  try {
    for (const [kind, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]] as const) {
      const shader = gl.createShader(kind); if (!shader) throw new Error('Unable to allocate physical scene shader')
      shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader); if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'Physical scene shader compilation failed')
    }
    program = gl.createProgram(); if (!program) throw new Error('Unable to allocate physical scene program')
    for (const shader of shaders) gl.attachShader(program, shader)
    gl.linkProgram(program); if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'Physical scene program linking failed')
  } catch (error) { if (program) gl.deleteProgram(program); throw error }
  finally { for (const shader of shaders) gl.deleteShader(shader) }
  const ownedProgram = program, uniforms = Object.fromEntries(['uObjects', 'uMaterials', 'uObjectWidth', 'uMaterialWidth', 'uFlat', 'uLines', 'uLineOpacity'].map(name => [name, gl.getUniformLocation(ownedProgram, name)]))
  const metrics: PhysicalBackendMetrics = { geometryUploads: 0, geometryBytes: 0, draws: 0, buffers: 0, programs: 1, textures: 0, textureBytes: 0, instanceBytes: 0, instanceUploads: 0, statusUploads: 0, paletteUploads: 0, evictions: 0, peakRequiredBytes: 0, liveBuffersAfterDisposal: null, liveProgramsAfterDisposal: null, liveTexturesAfterDisposal: null }
  const texture = (): Texture => { const value = gl.createTexture(); if (!value) throw new Error('Unable to allocate physical material/status table'); metrics.textures++; return { texture: value, width: 0, height: 0, data: new Float32Array() } }
  const dimensions = (pixels: number) => { const width = Math.min(maxTextureSize, Math.max(1, pixels)), height = Math.max(1, Math.ceil(pixels / width)); if (height > maxTextureSize) throw new Error('Physical instance table exceeds this GPU texture allocation') ; return { width, height } }
  const resizeTexture = (value: Texture, pixels: number): boolean => {
    const next = dimensions(pixels); if (next.width === value.width && next.height === value.height) return false
    metrics.textureBytes -= value.data.byteLength; value.width = next.width; value.height = next.height; value.data = new Float32Array(value.width * value.height * 4); metrics.textureBytes += value.data.byteLength; return true
  }
  const uploadTexture = (value: Texture, allocation: boolean): void => {
    gl.bindTexture(gl.TEXTURE_2D, value.texture)
    if (allocation) { gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, value.width, value.height, 0, gl.RGBA, gl.FLOAT, value.data) }
    else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, value.width, value.height, gl.RGBA, gl.FLOAT, value.data)
  }
  const updatePalette = (asset: Asset): void => {
    const colors = asset.roles.map(role => role === 'line' ? palette.line : palette.materials[role] ?? palette.defaultMaterial), signature = JSON.stringify(colors)
    if (signature === asset.paletteSignature) return
    const allocation = resizeTexture(asset.materials, colors.length)
    colors.forEach((color, index) => asset.materials.data.set([color[0], color[1], color[2], 1], index * 4))
    gl.activeTexture(gl.TEXTURE0); uploadTexture(asset.materials, allocation); asset.paletteSignature = signature; metrics.paletteUploads++
  }
  const release = (asset: Asset): void => {
    gl.deleteBuffer(asset.solid); gl.deleteBuffer(asset.lines); gl.deleteBuffer(asset.instances); gl.deleteVertexArray(asset.vao); gl.deleteVertexArray(asset.lineVao); gl.deleteTexture(asset.materials.texture); gl.deleteTexture(asset.objects.texture)
    metrics.geometryBytes -= asset.geometryBytes; metrics.instanceBytes -= asset.instanceData.byteLength; metrics.textureBytes -= asset.materials.data.byteLength + asset.objects.data.byteLength; metrics.buffers -= 3; metrics.textures -= 2
  }
  const createAsset = (draw: PhysicalDraw): Asset => {
    const solid = gl.createBuffer(), lines = gl.createBuffer(), instances = gl.createBuffer(), vao = gl.createVertexArray(), lineVao = gl.createVertexArray()
    if (!solid || !lines || !instances || !vao || !lineVao) { for (const buffer of [solid, lines, instances]) if (buffer) gl.deleteBuffer(buffer); for (const array of [vao, lineVao]) if (array) gl.deleteVertexArray(array); throw new Error('Unable to allocate physical render buffers') }
    const setupInstances = (): void => { gl.bindBuffer(gl.ARRAY_BUFFER, instances); for (let column = 0; column < 4; column++) { const location = 5 + column; gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, 4, gl.FLOAT, false, 17 * 4, column * 16); gl.vertexAttribDivisor(location, 1) }; gl.enableVertexAttribArray(9); gl.vertexAttribPointer(9, 1, gl.FLOAT, false, 17 * 4, 64); gl.vertexAttribDivisor(9, 1) }
    gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, solid); gl.bufferData(gl.ARRAY_BUFFER, draw.asset.buffers.vertices, gl.STATIC_DRAW)
    for (const [location, components, offset] of [[0, 3, 0], [1, 3, 12], [2, 1, 24], [3, 1, 28]] as const) { gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, components, gl.FLOAT, false, 32, offset) }
    gl.disableVertexAttribArray(4); setupInstances()
    gl.bindVertexArray(lineVao); gl.bindBuffer(gl.ARRAY_BUFFER, lines); gl.bufferData(gl.ARRAY_BUFFER, draw.asset.buffers.lines, gl.STATIC_DRAW)
    for (const [location, components, offset] of [[0, 3, 0], [2, 1, 12], [3, 1, 16], [4, 1, 20]] as const) { gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, components, gl.FLOAT, false, 24, offset) }
    gl.disableVertexAttribArray(1); setupInstances()
    const geometryBytes = draw.asset.buffers.vertices.byteLength + draw.asset.buffers.lines.byteLength
    const value: Asset = { identity: draw.asset.identity, solid, lines, instances, vao, lineVao, count: draw.asset.buffers.vertices.length / 8, lineCount: draw.asset.buffers.lines.length / 6, geometryBytes, materials: texture(), objects: texture(), instanceData: new Float32Array(), lastUsed: frame, roles: draw.asset.buffers.roles, paletteSignature: '' }
    metrics.geometryUploads++; metrics.geometryBytes += geometryBytes; metrics.buffers += 3; return value
  }
  const setObject = (data: Float32Array, at: number, values: ReadonlyArray<number>): boolean => { let changed = false; for (let component = 0; component < values.length; component++) if (data[at + component] !== Math.fround(values[component]!)) { data[at + component] = values[component]!; changed = true }; return changed }
  const ownedBytes = () => metrics.geometryBytes + metrics.instanceBytes + metrics.textureBytes
  const evictUnused = (required: ReadonlySet<string>): void => {
    for (const [key, value] of [...cache].filter(([key]) => !required.has(key)).sort(([, a], [, b]) => a.lastUsed - b.lastUsed)) {
      if (ownedBytes() <= metrics.peakRequiredBytes) break
      release(value); cache.delete(key); metrics.evictions++
    }
  }
  return {
    metrics,
    setPalette(value: PhysicalScenePalette): void { palette = value },
    retainGeometryIdentities(identities: ReadonlySet<string>): void { let changed = false; for (const [key, value] of cache) if (!identities.has(value.identity)) { release(value); cache.delete(key); changed = true }; if (changed) metrics.peakRequiredBytes = 0 },
    draw(draws: ReadonlyArray<PhysicalDraw>): void {
      if (disposed) throw new Error('Physical scene renderer has been disposed')
      frame++
      const groups = new Map<string, PhysicalDraw[]>()
      for (const draw of draws) { const list = groups.get(draw.asset.key) ?? []; list.push(draw); groups.set(draw.asset.key, list) }
      let requiredBytes = 0
      for (const list of groups.values()) { const first = list[0]!; requiredBytes += first.asset.buffers.vertices.byteLength + first.asset.buffers.lines.byteLength + list.length * (17 + first.asset.meshes.length * 8) * 4 + first.asset.buffers.roles.length * 16 }
      metrics.peakRequiredBytes = Math.max(metrics.peakRequiredBytes, requiredBytes); const required = new Set(groups.keys()); evictUnused(required)
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true); gl.disable(gl.CULL_FACE); gl.disable(gl.STENCIL_TEST); gl.colorMask(true, true, true, true); gl.useProgram(ownedProgram)
      gl.uniform1i(uniforms.uMaterials!, 0); gl.uniform1i(uniforms.uObjects!, 1); gl.uniform2f(uniforms.uLineOpacity!, palette.lineOpacity ?? 1, palette.contextLineOpacity ?? palette.lineOpacity ?? 1)
      gl.lineWidth(palette.lineWidth ?? 1)
      for (const [key, list] of groups) {
        const first = list[0]!, asset = cache.get(key) ?? createAsset(first); cache.set(key, asset); asset.lastUsed = frame; updatePalette(asset)
        const objectCount = first.asset.meshes.length, allocation = resizeTexture(asset.objects, list.length * objectCount * 2)
        let statusChanged = allocation
        if (asset.instanceData.length !== list.length * 17) { metrics.instanceBytes -= asset.instanceData.byteLength; asset.instanceData = new Float32Array(list.length * 17); metrics.instanceBytes += asset.instanceData.byteLength }
        list.forEach((draw, instanceIndex) => {
          asset.instanceData.set(draw.matrix, instanceIndex * 17); asset.instanceData[instanceIndex * 17 + 16] = instanceIndex * objectCount * 2
          const shown = new Map(draw.meshes.map(mesh => [mesh.assetIndex ?? first.asset.meshes.indexOf(mesh), mesh]))
          first.asset.meshes.forEach((mesh, objectIndex) => {
            const displayed = shown.get(objectIndex), style = draw.styles[objectIndex], at = (instanceIndex * objectCount + objectIndex) * 8, color = style?.color ?? palette.defaultMaterial
            statusChanged = setObject(asset.objects.data, at, [color[0], color[1], color[2], style?.color ? style.emphasis : 0]) || statusChanged
            statusChanged = setObject(asset.objects.data, at + 4, [displayed?.offset[0] ?? mesh.offset[0], displayed?.offset[1] ?? mesh.offset[1], displayed?.offset[2] ?? mesh.offset[2], displayed ? 1 : 0]) || statusChanged
          })
        })
        gl.bindBuffer(gl.ARRAY_BUFFER, asset.instances); gl.bufferData(gl.ARRAY_BUFFER, asset.instanceData, gl.DYNAMIC_DRAW); metrics.instanceUploads++
        gl.activeTexture(gl.TEXTURE1); if (statusChanged) { uploadTexture(asset.objects, allocation); metrics.statusUploads++ } else gl.bindTexture(gl.TEXTURE_2D, asset.objects.texture)
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, asset.materials.texture); gl.uniform1i(uniforms.uMaterialWidth!, asset.materials.width); gl.uniform1i(uniforms.uObjectWidth!, asset.objects.width); gl.uniform1i(uniforms.uFlat!, Number(first.flat))
        gl.disable(gl.BLEND); gl.depthFunc(gl.LESS); gl.uniform1i(uniforms.uLines!, 0); gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1, 1); gl.bindVertexArray(asset.vao); gl.drawArraysInstanced(gl.TRIANGLES, 0, asset.count, list.length); metrics.draws++
        if (asset.lineCount) { gl.depthFunc(gl.LEQUAL); gl.disable(gl.POLYGON_OFFSET_FILL); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.uniform1i(uniforms.uLines!, 1); gl.bindVertexArray(asset.lineVao); gl.drawArraysInstanced(gl.LINES, 0, asset.lineCount, list.length); metrics.draws++ }
      }
      const actualRequired = [...required].reduce((bytes, key) => { const value = cache.get(key)!; return bytes + value.geometryBytes + value.instanceData.byteLength + value.materials.data.byteLength + value.objects.data.byteLength }, 0)
      metrics.peakRequiredBytes = Math.max(metrics.peakRequiredBytes, actualRequired); evictUnused(required)
    },
    dispose(): void {
      if (disposed) return
      const buffers = [...cache.values()].flatMap(value => [value.solid, value.lines, value.instances]), textures = [...cache.values()].flatMap(value => [value.materials.texture, value.objects.texture])
      for (const value of cache.values()) release(value)
      cache.clear(); gl.deleteProgram(ownedProgram); metrics.programs = 0; disposed = true; metrics.liveBuffersAfterDisposal = buffers.filter(buffer => gl.isBuffer(buffer)).length; metrics.liveProgramsAfterDisposal = Number(gl.isProgram(ownedProgram)); metrics.liveTexturesAfterDisposal = textures.filter(value => gl.isTexture(value)).length
    },
  }
}
