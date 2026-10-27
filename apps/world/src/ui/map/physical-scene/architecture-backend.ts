import { physicalArchitectureOpacity } from './architecture-opacity.ts'
import { orderedPhysicalArchitectureFragments } from './architecture-bsp.ts'
import type { PhysicalArchitectureBsp } from './architecture-bsp-types.ts'
import { physicalFragmentSource, physicalMaterialColor, physicalVertexSource, type PhysicalDraw } from './backend.ts'
import { inverse } from './math.ts'
import type { PhysicalScenePalette } from './types.ts'

interface Table { readonly handle: WebGLTexture; width: number; height: number; data: Float32Array }
interface Packet {
  readonly solid: WebGLBuffer; readonly order: WebGLBuffer; readonly instance: WebGLBuffer; readonly vao: WebGLVertexArrayObject
  readonly objects: Table; readonly materials: Table; readonly vertices: Float32Array; readonly roles: readonly string[]
  indices: Uint32Array; fragments: readonly number[]; paletteKey: string
  runs: readonly { readonly kind: 'triangle' | 'line'; readonly start: number; readonly count: number }[]
}

/** Derived architecture only. Correctly ordered faces and authored lines blend
 * into the opaque pass's SAME multisampled target before its single resolve.
 * The original shader owns light, hatches, material and operational emphasis. */
export const createPhysicalArchitectureBackend = (gl: WebGL2RenderingContext, initialPalette: PhysicalScenePalette) => {
  let palette = initialPalette, bsp: PhysicalArchitectureBsp | null = null, packet: Packet | null = null, program: WebGLProgram | null = null, disposed = false
  let uniforms: Record<string, WebGLUniformLocation | null> = {}
  const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
  const counts = { geometryUploads: 0, orderUploads: 0, instanceUploads: 0, statusUploads: 0, paletteUploads: 0, draws: 0 }
  const final = { liveBuffersAfterDisposal: null as number | null, liveProgramsAfterDisposal: null as number | null, liveTexturesAfterDisposal: null as number | null }
  const createProgram = (): WebGLProgram => {
    const shaders: WebGLShader[] = [], value = gl.createProgram()
    if (!value) throw Error('Unable to allocate architecture ordering shader')
    try {
      for (const [kind, source] of [[gl.VERTEX_SHADER, physicalVertexSource], [gl.FRAGMENT_SHADER, physicalFragmentSource]] as const) {
        const shader = gl.createShader(kind); if (!shader) throw Error('Unable to allocate architecture shader')
        shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader)
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(shader) ?? 'Architecture shader compilation failed')
        gl.attachShader(value, shader)
      }
      gl.linkProgram(value); if (!gl.getProgramParameter(value, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(value) ?? 'Architecture shader linking failed')
      uniforms = Object.fromEntries(['uDepthNear', 'uObjects', 'uMaterials', 'uObjectWidth', 'uMaterialWidth', 'uFlat', 'uLines', 'uTranslucent', 'uOrdered', 'uLineOpacity', 'uIllustrationLine'].map(name => [name, gl.getUniformLocation(value, name)]))
      return value
    } catch (error) { gl.deleteProgram(value); throw error }
    finally { for (const shader of shaders) gl.deleteShader(shader) }
  }
  const table = (): Table => {
    const handle = gl.createTexture(); if (!handle) throw Error('Unable to allocate architecture material/owner table')
    return { handle, width: 0, height: 0, data: new Float32Array() }
  }
  const upload = (value: Table, pixels: number, fill: (data: Float32Array) => void): boolean => {
    const width = Math.min(maxTextureSize, Math.max(1, pixels)), height = Math.max(1, Math.ceil(pixels / width))
    if (height > maxTextureSize) throw Error('Architecture owner table exceeds this GPU texture allocation')
    const allocate = width !== value.width || height !== value.height
    const next = new Float32Array(width * height * 4); fill(next)
    const changed = allocate || next.some((item, index) => item !== value.data[index])
    gl.bindTexture(gl.TEXTURE_2D, value.handle)
    if (!changed) return false
    value.width = width; value.height = height; value.data = next
    if (allocate) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, next)
    } else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.FLOAT, next)
    return true
  }
  const release = (value: Packet): void => {
    gl.deleteBuffer(value.solid); gl.deleteBuffer(value.order); gl.deleteBuffer(value.instance); gl.deleteVertexArray(value.vao); gl.deleteTexture(value.objects.handle); gl.deleteTexture(value.materials.handle)
  }
  const allocate = (source: PhysicalArchitectureBsp): Packet => {
    const solid = gl.createBuffer(), order = gl.createBuffer(), instance = gl.createBuffer(), vao = gl.createVertexArray()
    if (!solid || !order || !instance || !vao) {
      for (const value of [solid, order, instance]) if (value) gl.deleteBuffer(value); if (vao) gl.deleteVertexArray(vao)
      throw Error('Unable to allocate derived architecture buffers')
    }
    let objects: Table | null = null, materials: Table | null = null
    try {
      objects = table(); materials = table()
      const roles: string[] = [], byRole = new Map<string, number>(), vertices = new Float32Array(source.vertices.length / 9 * 12)
      for (const fragment of source.fragments) {
        let role = byRole.get(fragment.material)
        if (role === undefined) { role = roles.length; roles.push(fragment.material); byRole.set(fragment.material, role) }
        for (let index = fragment.first; index < fragment.first + fragment.count; index++) {
          const at = index * 12, from = index * 9
          for (let component = 0; component < 6; component++) vertices[at + component] = source.vertices[from + component]!
          vertices[at + 6] = role; vertices[at + 7] = fragment.ownerIndex; vertices[at + 8] = fragment.strokeStyle === 'section' ? 2 : fragment.strokeStyle === 'context' ? 1 : 0
          for (let component = 0; component < 3; component++) vertices[at + 9 + component] = source.vertices[from + 6 + component]!
        }
      }
      gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, solid); gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW)
      for (const [location, size, offset] of [[0, 3, 0], [1, 3, 12], [2, 1, 24], [3, 1, 28], [4, 1, 32], [10, 3, 36]] as const) { gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, size, gl.FLOAT, false, 48, offset) }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, order); gl.bindBuffer(gl.ARRAY_BUFFER, instance)
      for (let column = 0; column < 4; column++) { const location = 5 + column; gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, 4, gl.FLOAT, false, 68, column * 16); gl.vertexAttribDivisor(location, 1) }
      gl.enableVertexAttribArray(9); gl.vertexAttribIPointer(9, 1, gl.UNSIGNED_INT, 68, 64); gl.vertexAttribDivisor(9, 1)
      counts.geometryUploads++
      return { solid, order, instance, vao, objects, materials, vertices, roles, indices: new Uint32Array(), fragments: [], runs: [], paletteKey: '' }
    } catch (error) {
      for (const value of [solid, order, instance]) gl.deleteBuffer(value); gl.deleteVertexArray(vao)
      if (objects) gl.deleteTexture(objects.handle); if (materials) gl.deleteTexture(materials.handle); throw error
    }
  }
  return {
    setAsset(value: PhysicalArchitectureBsp | null): void {
      if (disposed) return
      if (bsp === value) return
      if (bsp?.key === value?.key && value !== null) throw Error('Immutable architecture cohort changed its prepared asset')
      if (packet) release(packet); packet = null; bsp = value
    },
    setPalette(value: PhysicalScenePalette): void { palette = value },
    draw(draws: readonly PhysicalDraw[], depthNear = 0): void {
      if (disposed) throw Error('Architecture renderer has been disposed')
      if (!bsp || !bsp.owners.length) return
      if (!draws.some(draw => [draw.architecture?.wallOpacity ?? 1, draw.architecture?.floorOpacity ?? 1].some(alpha => alpha > 0 && alpha < 1))) return
      const placementKey = (sceneId: string, assetKey: string): string => JSON.stringify([sceneId, assetKey])
      const byPlacement = new Map(draws.filter(draw => draw.sceneId !== undefined).map(draw => [placementKey(draw.sceneId!, draw.asset.key), draw]))
      const shown = new Map(draws.map(draw => [draw, new Set(draw.meshes.map(mesh => mesh.assetIndex ?? draw.asset.meshes.indexOf(mesh)))]))
      const basis = bsp.owners[0]!, base = byPlacement.get(placementKey(basis.sceneId, basis.assetKey))
      if (!base) throw Error('Architecture cohort lost its reference placement')
      const visible = new Set<number>(), ownerData = new Float32Array(bsp.owners.length * 12)
      bsp.owners.forEach((owner, index) => {
        const draw = byPlacement.get(placementKey(owner.sceneId, owner.assetKey))
        if (!draw) return
        const mesh = draw.asset.meshes[owner.meshIndex]
        if (!mesh || mesh.object.id !== owner.occurrenceId) throw Error('Architecture owner provenance differs from its prepared source')
        const displayed = shown.get(draw)!.has(owner.meshIndex)
        const alpha = displayed ? physicalArchitectureOpacity(mesh.object, draw.architecture ?? {}) : 0
        if (alpha <= 0 || alpha >= 1) return
        visible.add(index)
        const at = index * 12, style = draw.styles[owner.meshIndex], color = style?.color ?? palette.defaultMaterial
        ownerData.set([...color, style?.color ? style.emphasis : 0], at); ownerData[at + 7] = alpha
        if (draw.highlight?.occurrenceId === owner.occurrenceId) ownerData.set([...draw.highlight.color, .24], at + 8)
      })
      if (!visible.size) return
      const projection = inverse(base.matrix), eye = [-projection[8]!, -projection[9]!, -projection[10]!, -projection[11]!] as const
      const ordered = orderedPhysicalArchitectureFragments(bsp, eye, visible)
      if (!ordered.length) return
      program ??= createProgram(); packet ??= allocate(bsp)
      const value = packet
      gl.useProgram(program); gl.bindVertexArray(value.vao)
      if (ordered !== value.fragments && (ordered.length !== value.fragments.length || ordered.some((id, at) => id !== value.fragments[at]))) {
        const indices = new Uint32Array(ordered.reduce((sum, id) => sum + bsp!.fragments[id]!.count, 0)); let at = 0
        const runs: { kind: 'triangle' | 'line'; start: number; count: number }[] = []
        for (const id of ordered) {
          const fragment = bsp.fragments[id]!, previous = runs.at(-1)
          if (previous?.kind === fragment.kind) previous.count += fragment.count
          else runs.push({ kind: fragment.kind, start: at, count: fragment.count })
          for (let index = 0; index < fragment.count; index++) indices[at++] = fragment.first + index
        }
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, value.order); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.DYNAMIC_DRAW); value.indices = indices; value.runs = runs; counts.orderUploads++
      }
      value.fragments = ordered
      const instance = new Float32Array(17); instance.set(base.matrix)
      gl.bindBuffer(gl.ARRAY_BUFFER, value.instance); gl.bufferData(gl.ARRAY_BUFFER, instance, gl.DYNAMIC_DRAW); counts.instanceUploads++
      gl.activeTexture(gl.TEXTURE1); if (upload(value.objects, bsp.owners.length * 3, data => data.set(ownerData))) counts.statusUploads++
      gl.activeTexture(gl.TEXTURE0)
      const colors = value.roles.map(role => physicalMaterialColor(palette, role)), paletteKey = JSON.stringify(colors)
      if (value.paletteKey !== paletteKey) {
        if (upload(value.materials, colors.length, data => colors.forEach((color, at) => { const role = value.roles[at]!, pattern = role.startsWith('continuation/') ? -Number(role.split('/')[2]) : role.startsWith('surface/outage/') ? 1 : 0; data.set([...color, pattern], at * 4) }))) counts.paletteUploads++
        value.paletteKey = paletteKey
      } else gl.bindTexture(gl.TEXTURE_2D, value.materials.handle)
      gl.bindSampler(0, null); gl.bindSampler(1, null); gl.uniform1i(uniforms.uMaterials!, 0); gl.uniform1i(uniforms.uObjects!, 1); gl.uniform1i(uniforms.uMaterialWidth!, value.materials.width); gl.uniform1i(uniforms.uObjectWidth!, value.objects.width)
      gl.uniform1i(uniforms.uFlat!, Number(base.flat)); gl.uniform1i(uniforms.uOrdered!, 1); gl.uniform1i(uniforms.uTranslucent!, 1); gl.uniform1f(uniforms.uDepthNear!, depthNear)
      gl.uniform2f(uniforms.uLineOpacity!, palette.lineOpacity ?? 1, palette.contextLineOpacity ?? palette.lineOpacity ?? 1); gl.uniform3f(uniforms.uIllustrationLine!, ...palette.line); gl.lineWidth(palette.lineWidth ?? 1)
      gl.enable(gl.DEPTH_TEST); gl.depthMask(false); gl.disable(gl.CULL_FACE); gl.disable(gl.STENCIL_TEST); gl.disable(gl.POLYGON_OFFSET_FILL); gl.colorMask(true, true, true, true); gl.enable(gl.BLEND)
      gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      for (const run of value.runs) { gl.uniform1i(uniforms.uLines!, Number(run.kind === 'line')); gl.depthFunc(run.kind === 'line' ? gl.GEQUAL : gl.GREATER); gl.drawElementsInstanced(run.kind === 'line' ? gl.LINES : gl.TRIANGLES, run.count, gl.UNSIGNED_INT, run.start * 4, 1); counts.draws++ }
    },
    metrics: () => ({ ...counts, geometryBytes: packet?.vertices.byteLength ?? 0, orderBytes: packet?.indices.byteLength ?? 0, instanceBytes: packet ? 68 : 0, residentCpuBytes: (bsp?.vertices.byteLength ?? 0) + (packet?.vertices.byteLength ?? 0) + (packet?.indices.byteLength ?? 0), buffers: packet ? 3 : 0, programs: program ? 1 : 0, textures: packet ? 2 : 0, textureBytes: packet ? packet.objects.data.byteLength + packet.materials.data.byteLength : 0, ...final }),
    dispose(): void {
      if (disposed) return
      const prior = packet, priorProgram = program
      if (prior) release(prior); if (priorProgram) gl.deleteProgram(priorProgram)
      final.liveBuffersAfterDisposal = prior ? [prior.solid, prior.order, prior.instance].filter(value => gl.isBuffer(value)).length : 0
      final.liveTexturesAfterDisposal = prior ? [prior.objects.handle, prior.materials.handle].filter(value => gl.isTexture(value)).length : 0
      final.liveProgramsAfterDisposal = priorProgram ? Number(gl.isProgram(priorProgram)) : 0
      packet = null; bsp = null; program = null; disposed = true
    },
  }
}

export type PhysicalArchitectureBackendMetrics = ReturnType<ReturnType<typeof createPhysicalArchitectureBackend>['metrics']>
