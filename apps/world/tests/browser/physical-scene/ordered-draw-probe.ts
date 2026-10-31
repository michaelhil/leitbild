import type { PackPhysicalScene } from '../../../src/core/packs/scene.ts'
import { createPhysicalRenderPass } from '../../../src/ui/map/physical-scene/render-pass.ts'
import { createPhysicalBackend, type PhysicalDraw } from '../../../src/ui/map/physical-scene/backend.ts'
import { preparePhysicalGeometry } from '../../../src/ui/map/physical-scene/preparation.ts'
import { captureSceneGlState, restoreSceneGlState } from '../../../src/ui/map/physical-scene/gl-state.ts'
import { pickPhysicalMesh } from '../../../src/ui/map/physical-scene/picking.ts'
import { defaultPhysicalSceneView } from '../../../src/ui/map/physical-scene/types.ts'
import { fullGlState, stateDifferences } from './gl-probes.ts'

/** Adversarial GPU receipt: shared A geometry surrounds unrelated B in source order. */
export const probePhysicalCoplanarDrawOrder = (gl: WebGL2RenderingContext) => {
  const before = captureSceneGlState(gl), independentlyBefore = fullGlState(gl)
  const texture = gl.createTexture()!, target = gl.createFramebuffer()!, depth = gl.createRenderbuffer()!
  const results: { flat: boolean; interleaved: boolean; picked: string | undefined; pixel: number[]; draws: number; geometryUploads: number; passed: boolean }[] = []
  let backend: ReturnType<typeof createPhysicalBackend> | null = null, physicalPass: ReturnType<typeof createPhysicalRenderPass> | null = null
  try {
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 32, 32, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, target); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, 32, 32); gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth)
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw Error('Coplanar probe target is incomplete')
    gl.viewport(0, 0, 32, 32); gl.disable(gl.SCISSOR_TEST); gl.depthRange(0, 1)
    const scene = (id: string, material: string): PackPhysicalScene => ({ id, revision: 'probe', targetObjectId: id, anchor: [0, 0], bearing: 0, bounds: { min: [-1, -1, 0], max: [1, 1, 1] }, levels: [{ id: 'floor', label: 'Floor', elevation: 0, cutHeight: 1 }], objects: [{ id, label: id, kind: 'context', levelId: 'site', subjectIds: [], edgePolicy: 'none', material, positions: [-.8, -.8, 0, .8, -.8, 0, 0, .8, 0] }] })
    const a = scene('A', 'red'), b = scene('B', 'green'), view = { ...defaultPhysicalSceneView(a.levels), mode: '3d' as const, levelId: 'all' }
    const assetA = preparePhysicalGeometry(a, view, 'A', 'A'), assetB = preparePhysicalGeometry(b, view, 'B', 'B')
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), outside = identity.slice(); outside[12] = 3
    backend = createPhysicalBackend(gl, { materials: { red: [1, 0, 0], green: [0, 1, 0] }, defaultMaterial: [0, 0, 0], line: [0, 0, 0] })
    physicalPass = createPhysicalRenderPass(gl)
    for (const flat of [false, true]) for (const interleaved of [true, false]) {
      const draw = (asset: typeof assetA, matrix: Float32Array): PhysicalDraw => ({ asset, meshes: asset.meshes, matrix, flat, styles: [] })
      const a1 = draw(assetA, outside), a2 = draw(assetA, identity), middle = draw(assetB, identity), draws = interleaved ? [a1, middle, a2] : [a1, a2, middle]
      gl.clearColor(0, 0, 0, 0); gl.clearDepth(1); gl.depthMask(true); gl.colorMask(true, true, true, true); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      const start = backend.metrics.draws; physicalPass.begin(32, 32); backend.draw(draws); physicalPass.composite(target, target, [0, 0, 32, 32])
      const pixel = new Uint8Array(4); gl.readPixels(16, 16, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
      const picked = pickPhysicalMesh(draws.map((value, index) => ({ sceneId: value === middle ? 'B' : index === 0 ? 'A1' : 'A2', meshes: value.meshes, matrix: value.matrix })), { x: 16, y: 16 }, 32, 32)?.sceneId
      const expected = interleaved ? 'B' : 'A2', green = pixel[1]! > pixel[0]!
      results.push({ flat, interleaved, picked, pixel: [...pixel], draws: backend.metrics.draws - start, geometryUploads: backend.metrics.geometryUploads, passed: picked === expected && pixel[3] === 255 && pixel[0]! + pixel[1]! > 100 && green === interleaved && backend.metrics.geometryUploads === 2 })
    }
    // Production hosts restore their program before disposing a renderer;
    // unbind this direct test draw too, so GL deletion is no longer deferred.
    gl.useProgram(before.program); gl.bindVertexArray(before.vao); backend.dispose(); physicalPass.dispose()
    return { passed: results.every(result => result.passed) && backend.metrics.liveProgramsAfterDisposal === 0 && backend.metrics.liveBuffersAfterDisposal === 0 && backend.metrics.liveTexturesAfterDisposal === 0, results, disposal: { ...backend.metrics, renderPass: physicalPass.metrics() } }
  } finally {
    backend?.dispose(); physicalPass?.dispose(); gl.deleteTexture(texture); gl.deleteFramebuffer(target); gl.deleteRenderbuffer(depth); restoreSceneGlState(gl, before)
    const differences = stateDifferences(independentlyBefore, fullGlState(gl)); if (differences.length) throw Error(`Coplanar probe changed host state: ${differences.join(', ')}`)
  }
}
