import { visiblePhysicalSurfaceOwners } from './surface-ownership.ts'
import type { PhysicalRenderPassMetrics } from './render-pass.ts'
import type { PhysicalMesh } from './geometry.ts'
import type { PhysicalPreparedGeometry } from './preparation.ts'
import type { Color, PhysicalSceneHighlight, PhysicalScenePalette, PhysicalSubjectStyle } from './types.ts'
import type { PhysicalSceneView } from './types.ts'
import { physicalArchitectureOpacity } from './architecture-opacity.ts'

/** Quiet illustrative surface colour, precomposited against its actual material
 * before the common lighting pass. No second coincident translucent surface. */
export const physicalMaterialColor = (palette: PhysicalScenePalette, role: string): Color => {
  if (role === 'line') return palette.line
  if (role.startsWith('continuation/')) {
    const [, material, radius] = role.split('/')
    if (!material || !Number.isFinite(Number(radius)) || !(Number(radius) > 0)) throw Error(`Invalid physical continuation material: ${role}`)
    return palette.materials[material] ?? palette.defaultMaterial
  }
  if (role.startsWith('surface/')) {
    const [, accent, material] = role.split('/')
    if (accent !== 'access' && accent !== 'outage' || !material) throw Error(`Invalid physical surface decoration role: ${role}`)
    const base = palette.materials[material] ?? palette.defaultMaterial, overlay = palette.materials[accent] ?? palette.defaultMaterial
    return base.map((value, axis) => value * .58 + overlay[axis]! * .42) as unknown as Color
  }
  return palette.materials[role] ?? palette.defaultMaterial
}

export const physicalVertexSource = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in vec3 position;
layout(location=1) in vec3 normal;
layout(location=2) in float materialIndex;
layout(location=3) in float objectIndex;
layout(location=4) in float strokeStyle;
layout(location=5) in mat4 instanceMatrix;
layout(location=9) in uint instanceData;
layout(location=10) in vec3 sourcePosition;
uniform sampler2D uObjects;
uniform int uObjectWidth;
uniform bool uOrdered;
out vec3 vNormal;
out vec3 vLocalPosition;
out float vCameraDepth;
flat out int vMaterial;
flat out int vObject;
flat out float vStroke;
flat out float vOpacity;
vec4 objectData(int i){return texelFetch(uObjects,ivec2(i%uObjectWidth,i/uObjectWidth),0);}
void main(){
  int i=int(instanceData)+int(objectIndex)*3;
  vec4 placement=objectData(i+1);
  gl_Position=placement.w<=0.?vec4(2.,2.,2.,1.):instanceMatrix*vec4(position+placement.xyz,1.);
  vCameraDepth=gl_Position.w;
  vLocalPosition=uOrdered?sourcePosition:position;
  vNormal=normal;vMaterial=int(materialIndex);vObject=i;vStroke=strokeStyle;vOpacity=placement.w;
}
`
export const physicalFragmentSource = `#version 300 es
precision highp float;
precision highp int;
in vec3 vNormal;
in vec3 vLocalPosition;
in float vCameraDepth;
flat in int vMaterial;
flat in int vObject;
flat in float vStroke;
flat in float vOpacity;
uniform sampler2D uMaterials;
uniform sampler2D uObjects;
uniform int uMaterialWidth;
uniform int uObjectWidth;
uniform float uDepthNear;
uniform bool uFlat;
uniform bool uLines;
uniform bool uTranslucent;
uniform vec2 uLineOpacity;
uniform vec3 uIllustrationLine;
out vec4 outColor;
void main(){
  if(vOpacity<=0.||(!uTranslucent&&vOpacity<1.)||(uTranslucent&&vOpacity>=1.))discard;
  // Original clip coordinates still own clipping and screen coverage. A
  // reversed floating camera depth avoids subtracting two almost equal clip
  // coordinates for widely viewed, genuinely thin physical objects.
  gl_FragDepth=uFlat||uDepthNear==0.?1.-gl_FragCoord.z:uDepthNear/vCameraDepth;
  vec3 n=normalize(vNormal);
  // Preserve the accepted illustration's Y-up lighting in scene-local Z-up.
  float light=uFlat?1.:.60+.10*n.z+.28*max(dot(n,normalize(vec3(-.45,.55,.88))),0.)+.12*max(dot(n,normalize(vec3(.65,-.8,.4))),0.);
  vec4 surface=texelFetch(uMaterials,ivec2(vMaterial%uMaterialWidth,vMaterial/uMaterialWidth),0);
  vec3 material=surface.rgb;
  vec4 state=texelFetch(uObjects,ivec2(vObject%uObjectWidth,vObject/uObjectWidth),0);
  float edgeAlpha=uFlat||vStroke>1.5?1.:vStroke>.5?uLineOpacity.y:uLineOpacity.x;
  // Operational severity accents the existing drawing contours. Recolouring
  // solid faces destroys the authored material hierarchy and, in Plan, turns
  // neighbouring machines into one opaque alarm block. The owner-qualified
  // status badge remains the explicit alarm/count target in either view.
  vec3 edge=mix(material,state.rgb,state.a);
  vec3 solid=material*light;
  // Interaction tint belongs to the existing surface, so it has exactly the
  // same depth/occlusion as its machinery. It is independent of alarm colour.
  int selectionAt=vObject+2;
  vec4 selection=texelFetch(uObjects,ivec2(selectionAt%uObjectWidth,selectionAt/uObjectWidth),0);
  solid=mix(solid,selection.rgb*light,selection.a);
  if(selection.a>0.)edge=selection.rgb;
  if(!uLines&&surface.a>.5){
    // Hatch is part of the owning floor fragment's material. Its local metre
    // coordinates are stable under pan/orbit; derivatives keep a fine stroke
    // without another coincident depth-tested line surface.
    float phase=(vLocalPosition.x-vLocalPosition.y)/.8;
    float width=fwidth(phase);
    float ink=1.-smoothstep(.5*width,1.5*width,abs(fract(phase+.5)-.5));
    solid=mix(solid,uIllustrationLine,ink*uLineOpacity.x*.42);
  }
  if(!uLines&&surface.a<0.){
    // A true clipping cap carries an architectural continuation hatch in its
    // owning material; no coplanar decal, added Z, or new physical occurrence.
    vec3 axis=abs(n);
    vec2 uv=axis.z>=axis.x&&axis.z>=axis.y?vLocalPosition.xy:axis.y>=axis.x?vLocalPosition.xz:vLocalPosition.yz;
    float phase=(uv.x-uv.y)/(-surface.a*.5);
    float width=fwidth(phase);
    float ink=1.-smoothstep(.5*width,1.5*width,abs(fract(phase+.5)-.5));
    solid=mix(solid,uIllustrationLine,ink*.65);
  }
  float alpha=(uLines?max(max(edgeAlpha,state.a),selection.a>0.?1.:0.):1.)*vOpacity;
  vec3 color=uLines?edge:solid;
  outColor=vec4(color,alpha);
}
`
export interface PhysicalBackendMetrics {
  readonly architecture?: import('./architecture-backend.ts').PhysicalArchitectureBackendMetrics
  readonly cpuResidency?: import('./prepared-residency.ts').PhysicalPreparedResidencyMetrics
  readonly renderPass?: PhysicalRenderPassMetrics | null
  geometryUploads: number; geometryBytes: number; residentCpuBytes: number; draws: number; buffers: number; programs: number
  textures: number; textureBytes: number; instanceBytes: number; instanceUploads: number; statusUploads: number; paletteUploads: number; evictions: number; peakRequiredBytes: number
  liveBuffersAfterDisposal: number | null; liveProgramsAfterDisposal: number | null; liveTexturesAfterDisposal: number | null
}
export interface PhysicalDraw {
  /** Required when a placed global architecture cohort is presented. */
  readonly sceneId?: string
  readonly asset: PhysicalPreparedGeometry
  readonly matrix: Float32Array
  readonly flat: boolean
  readonly meshes: ReadonlyArray<PhysicalMesh>
  readonly styles: ReadonlyArray<PhysicalSubjectStyle | null>
  readonly highlight?: PhysicalSceneHighlight
  readonly architecture?: Pick<PhysicalSceneView, 'wallOpacity' | 'floorOpacity'>
}
interface Texture { readonly texture: WebGLTexture; width: number; height: number; data: Float32Array }
interface Asset {
  readonly identity: string; readonly solid: WebGLBuffer; readonly lines: WebGLBuffer; readonly instances: WebGLBuffer; readonly vao: WebGLVertexArrayObject; readonly lineVao: WebGLVertexArrayObject
  readonly count: number; readonly lineCount: number; readonly geometryBytes: number; readonly materials: Texture; readonly objects: Texture
  instanceData: Float32Array; instanceWords: Uint32Array; lastUsed: number; roles: ReadonlyArray<string>; paletteSignature: string
}

/** Retained local buffers, instanced placements and separate palette/status tables. */
export const createPhysicalBackend = (gl: WebGL2RenderingContext, initialPalette: PhysicalScenePalette) => {
  let palette = initialPalette, disposed = false, frame = 0
  const shaders: WebGLShader[] = [], cache = new Map<string, Asset>(), maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
  let program: WebGLProgram | null = null
  try {
    for (const [kind, source] of [[gl.VERTEX_SHADER, physicalVertexSource], [gl.FRAGMENT_SHADER, physicalFragmentSource]] as const) {
      const shader = gl.createShader(kind); if (!shader) throw new Error('Unable to allocate physical scene shader')
      shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader); if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'Physical scene shader compilation failed')
    }
    program = gl.createProgram(); if (!program) throw new Error('Unable to allocate physical scene program')
    for (const shader of shaders) gl.attachShader(program, shader)
    gl.linkProgram(program); if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'Physical scene program linking failed')
  } catch (error) { if (program) gl.deleteProgram(program); throw error }
  finally { for (const shader of shaders) gl.deleteShader(shader) }
  const ownedProgram = program, uniforms = Object.fromEntries(['uDepthNear', 'uObjects', 'uMaterials', 'uObjectWidth', 'uMaterialWidth', 'uFlat', 'uLines', 'uTranslucent', 'uOrdered', 'uLineOpacity', 'uIllustrationLine'].map(name => [name, gl.getUniformLocation(ownedProgram, name)]))
  const metrics: PhysicalBackendMetrics = { geometryUploads: 0, geometryBytes: 0, residentCpuBytes: 0, draws: 0, buffers: 0, programs: 1, textures: 0, textureBytes: 0, instanceBytes: 0, instanceUploads: 0, statusUploads: 0, paletteUploads: 0, evictions: 0, peakRequiredBytes: 0, liveBuffersAfterDisposal: null, liveProgramsAfterDisposal: null, liveTexturesAfterDisposal: null }
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
    const colors = asset.roles.map(role => physicalMaterialColor(palette, role)), signature = JSON.stringify(colors)
    if (signature === asset.paletteSignature) return
    const allocation = resizeTexture(asset.materials, colors.length)
    colors.forEach((color, index) => { const role = asset.roles[index]!, pattern = role.startsWith('continuation/') ? -Number(role.split('/')[2]) : role.startsWith('surface/outage/') ? 1 : 0; asset.materials.data.set([color[0], color[1], color[2], pattern], index * 4) })
    gl.activeTexture(gl.TEXTURE0); uploadTexture(asset.materials, allocation); asset.paletteSignature = signature; metrics.paletteUploads++
  }
  const release = (asset: Asset): void => {
    gl.deleteBuffer(asset.solid); gl.deleteBuffer(asset.lines); gl.deleteBuffer(asset.instances); gl.deleteVertexArray(asset.vao); gl.deleteVertexArray(asset.lineVao); gl.deleteTexture(asset.materials.texture); gl.deleteTexture(asset.objects.texture)
    metrics.geometryBytes -= asset.geometryBytes; metrics.instanceBytes -= asset.instanceData.byteLength; metrics.textureBytes -= asset.materials.data.byteLength + asset.objects.data.byteLength; metrics.buffers -= 3; metrics.textures -= 2
  }
  const createAsset = (draw: PhysicalDraw): Asset => {
    const solid = gl.createBuffer(), lines = gl.createBuffer(), instances = gl.createBuffer(), vao = gl.createVertexArray(), lineVao = gl.createVertexArray()
    if (!solid || !lines || !instances || !vao || !lineVao) { for (const buffer of [solid, lines, instances]) if (buffer) gl.deleteBuffer(buffer); for (const array of [vao, lineVao]) if (array) gl.deleteVertexArray(array); throw new Error('Unable to allocate physical render buffers') }
    let materials: Texture | null = null, objects: Texture | null = null
    try {
    materials = texture(); objects = texture()
    const setupInstances = (): void => { gl.bindBuffer(gl.ARRAY_BUFFER, instances); for (let column = 0; column < 4; column++) { const location = 5 + column; gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, 4, gl.FLOAT, false, 17 * 4, column * 16); gl.vertexAttribDivisor(location, 1) }; gl.enableVertexAttribArray(9); gl.vertexAttribIPointer(9, 1, gl.UNSIGNED_INT, 17 * 4, 64); gl.vertexAttribDivisor(9, 1) }
    gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, solid); gl.bufferData(gl.ARRAY_BUFFER, draw.asset.buffers.vertices, gl.STATIC_DRAW)
    for (const [location, components, offset] of [[0, 3, 0], [1, 3, 12], [2, 1, 24], [3, 1, 28]] as const) { gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, components, gl.FLOAT, false, 32, offset) }
    gl.disableVertexAttribArray(4); setupInstances()
    gl.bindVertexArray(lineVao); gl.bindBuffer(gl.ARRAY_BUFFER, lines); gl.bufferData(gl.ARRAY_BUFFER, draw.asset.buffers.lines, gl.STATIC_DRAW)
    for (const [location, components, offset] of [[0, 3, 0], [2, 1, 12], [3, 1, 16], [4, 1, 20]] as const) { gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, components, gl.FLOAT, false, 24, offset) }
    gl.disableVertexAttribArray(1); setupInstances()
    const geometryBytes = draw.asset.buffers.vertices.byteLength + draw.asset.buffers.lines.byteLength
    const value: Asset = { identity: draw.asset.identity, solid, lines, instances, vao, lineVao, count: draw.asset.buffers.vertices.length / 8, lineCount: draw.asset.buffers.lines.length / 6, geometryBytes, materials, objects, instanceData: new Float32Array(), instanceWords: new Uint32Array(), lastUsed: frame, roles: draw.asset.buffers.roles, paletteSignature: '' }
    metrics.geometryUploads++; metrics.geometryBytes += geometryBytes; metrics.buffers += 3; return value
    } catch (error) { for (const buffer of [solid, lines, instances]) gl.deleteBuffer(buffer); gl.deleteVertexArray(vao); gl.deleteVertexArray(lineVao); for (const table of [materials, objects]) if (table) { gl.deleteTexture(table.texture); metrics.textures-- }; throw error }
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
    draw(draws: ReadonlyArray<PhysicalDraw>, depthNear = 0): void {
      if (disposed) throw new Error('Physical scene renderer has been disposed')
      frame++
      const groups = new Map<string, PhysicalDraw[]>()
      draws = draws.map(draw => ({ ...draw, meshes: visiblePhysicalSurfaceOwners(draw.meshes) }))
      for (const draw of draws) { const list = groups.get(draw.asset.key) ?? []; list.push(draw); groups.set(draw.asset.key, list) }
      let requiredBytes = 0
      for (const list of groups.values()) { const first = list[0]!; requiredBytes += first.asset.buffers.vertices.byteLength + first.asset.buffers.lines.byteLength + list.length * (17 + first.asset.meshes.length * 12) * 4 + first.asset.buffers.roles.length * 16 }
      metrics.peakRequiredBytes = Math.max(metrics.peakRequiredBytes, requiredBytes); const required = new Set(groups.keys()); evictUnused(required)
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.GEQUAL); gl.depthMask(true); gl.disable(gl.CULL_FACE); gl.disable(gl.STENCIL_TEST); gl.colorMask(true, true, true, true); gl.useProgram(ownedProgram); gl.uniform1f(uniforms.uDepthNear!, depthNear)
      gl.bindSampler(0, null); gl.bindSampler(1, null); gl.uniform1i(uniforms.uMaterials!, 0); gl.uniform1i(uniforms.uObjects!, 1); gl.uniform1i(uniforms.uOrdered!, 0); gl.uniform2f(uniforms.uLineOpacity!, palette.lineOpacity ?? 1, palette.contextLineOpacity ?? palette.lineOpacity ?? 1)
      gl.uniform3f(uniforms.uIllustrationLine!, ...palette.line)
      gl.lineWidth(palette.lineWidth ?? 1)
      // Populate each retained asset's complete instance/status table once.
      for (const [key, list] of groups) {
        const first = list[0]!, asset = cache.get(key) ?? createAsset(first); cache.set(key, asset); asset.lastUsed = frame; updatePalette(asset)
        const objectCount = first.asset.meshes.length, allocation = resizeTexture(asset.objects, list.length * objectCount * 3)
        let statusChanged = allocation
        if (asset.instanceData.length !== list.length * 17) { metrics.instanceBytes -= asset.instanceData.byteLength; asset.instanceData = new Float32Array(list.length * 17); asset.instanceWords = new Uint32Array(asset.instanceData.buffer); metrics.instanceBytes += asset.instanceData.byteLength }
        list.forEach((draw, instanceIndex) => {
          asset.instanceData.set(draw.matrix, instanceIndex * 17); asset.instanceWords[instanceIndex * 17 + 16] = instanceIndex * objectCount * 3
          const shown = new Map(draw.meshes.map(mesh => [mesh.assetIndex ?? first.asset.meshes.indexOf(mesh), mesh]))
          first.asset.meshes.forEach((mesh, objectIndex) => {
            const displayed = shown.get(objectIndex), style = draw.styles[objectIndex], at = (instanceIndex * objectCount + objectIndex) * 12, color = style?.color ?? palette.defaultMaterial
            statusChanged = setObject(asset.objects.data, at, [color[0], color[1], color[2], style?.color ? style.emphasis : 0]) || statusChanged
            statusChanged = setObject(asset.objects.data, at + 4, [displayed?.offset[0] ?? mesh.offset[0], displayed?.offset[1] ?? mesh.offset[1], displayed?.offset[2] ?? mesh.offset[2], displayed ? physicalArchitectureOpacity(mesh.object, draw.architecture ?? {}) : 0]) || statusChanged
            const selection = draw.highlight?.occurrenceId === mesh.object.id ? draw.highlight.color : null
            statusChanged = setObject(asset.objects.data, at + 8, selection ? [...selection, .24] : [0, 0, 0, 0]) || statusChanged
          })
        })
        gl.bindBuffer(gl.ARRAY_BUFFER, asset.instances); gl.bufferData(gl.ARRAY_BUFFER, asset.instanceData, gl.DYNAMIC_DRAW); metrics.instanceUploads++
        gl.activeTexture(gl.TEXTURE1); if (statusChanged) { uploadTexture(asset.objects, allocation); metrics.statusUploads++ } else gl.bindTexture(gl.TEXTURE_2D, asset.objects.texture)
      }
      // Instancing may combine contiguous placements, but must never reorder
      // A1,B,A2 into A1,A2,B: exact coplanar identity is first-source-wins in
      // both the depth buffer and picker. Runs share the tables uploaded above.
      const runs: { key: string; start: number; count: number; flat: boolean }[] = [], next = new Map<string, number>()
      for (const draw of draws) {
        const key = draw.asset.key, start = next.get(key) ?? 0, previous = runs.at(-1); next.set(key, start + 1)
        if (previous?.key === key && previous.flat === draw.flat) previous.count++
        else runs.push({ key, start, count: 1, flat: draw.flat })
      }
      // Opaque surfaces retain the original shared depth/antialiasing pass.
      // Fractional architecture is blended in spatial order into this same
      // target by the derived architecture backend, before its single resolve.
      gl.uniform1i(uniforms.uTranslucent!, 0); gl.depthMask(true)
      for (const run of runs) {
        const asset = cache.get(run.key)!
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, asset.objects.texture)
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, asset.materials.texture); gl.uniform1i(uniforms.uMaterialWidth!, asset.materials.width); gl.uniform1i(uniforms.uObjectWidth!, asset.objects.width); gl.uniform1i(uniforms.uFlat!, Number(run.flat))
        const instancesAt = (vao: WebGLVertexArrayObject): void => {
          gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, asset.instances)
          for (let column = 0; column < 4; column++) gl.vertexAttribPointer(5 + column, 4, gl.FLOAT, false, 17 * 4, run.start * 17 * 4 + column * 16)
          gl.vertexAttribIPointer(9, 1, gl.UNSIGNED_INT, 17 * 4, run.start * 17 * 4 + 64)
        }
        gl.disable(gl.BLEND)
        gl.depthFunc(gl.GREATER); gl.uniform1i(uniforms.uLines!, 0); gl.disable(gl.POLYGON_OFFSET_FILL); instancesAt(asset.vao); gl.drawArraysInstanced(gl.TRIANGLES, 0, asset.count, run.count); metrics.draws++
        if (asset.lineCount) { gl.depthFunc(gl.GEQUAL); gl.disable(gl.POLYGON_OFFSET_FILL); gl.enable(gl.BLEND); gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.uniform1i(uniforms.uLines!, 1); instancesAt(asset.lineVao); gl.drawArraysInstanced(gl.LINES, 0, asset.lineCount, run.count); metrics.draws++ }
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
