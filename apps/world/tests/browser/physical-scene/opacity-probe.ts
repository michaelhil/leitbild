import type { PackPhysicalScene } from '../../../src/core/packs/scene.ts'
import { createPhysicalBackend, type PhysicalDraw } from '../../../src/ui/map/physical-scene/backend.ts'
import { createPhysicalRenderPass } from '../../../src/ui/map/physical-scene/render-pass.ts'
import { createPhysicalSceneRenderer } from '../../../src/ui/map/physical-scene/renderer.ts'
import { preparePhysicalGeometry } from '../../../src/ui/map/physical-scene/preparation.ts'
import { captureSceneGlState, restoreSceneGlState } from '../../../src/ui/map/physical-scene/gl-state.ts'
import { inverse, localMercatorMatrix } from '../../../src/ui/map/physical-scene/math.ts'
import { defaultPhysicalSceneView, type PhysicalSceneView } from '../../../src/ui/map/physical-scene/types.ts'
import { fullGlState, stateDifferences } from './gl-probes.ts'

// Independent known-colour geometry, test-only. All colour/opacity work passes
// through the production buffers, shader, owned MSAA targets and compositor.
const canvas = document.querySelector('canvas')!, gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true })!
if (!gl) throw Error('Opacity fixture needs WebGL2')
canvas.width = canvas.height = 128 * devicePixelRatio
const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
const palette = { materials: { red: [1, 0, 0] as const, green: [0, 1, 0] as const, blue: [0, 0, 1] as const, yellow: [1, 1, 0] as const }, defaultMaterial: [0, 0, 0] as const, line: [0, 0, 0] as const }
const scene = (id: string, kind: 'wall' | 'slab' | 'equipment', material: string, z: number, left = -.8, right = .8): PackPhysicalScene => ({
  id, revision: 'opacity-probe', targetObjectId: id, anchor: [0, 0], bearing: 0, bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
  levels: [{ id: 'floor', label: 'Floor', elevation: -1, cutHeight: 1 }], objects: [{ id, label: id, kind, levelId: 'site', subjectIds: kind === 'equipment' ? [id] : [], edgePolicy: 'none', material,
    positions: [left, -.8, z, right, -.8, z, right, .8, z, left, -.8, z, right, .8, z, left, .8, z], normals: Array.from({ length: 6 }, () => [0, 0, 1]).flat() }],
})
const base = scene('blue', 'equipment', 'blue', .6), wall = scene('red', 'wall', 'red', -.4), floor = scene('green', 'slab', 'green', 0)
const view: PhysicalSceneView = { ...defaultPhysicalSceneView(base.levels), mode: '3d', levelId: 'all', cutaway: false }
let prepares = 0
const prepare = (value: PackPhysicalScene) => { prepares++; return preparePhysicalGeometry(value, view, value.id, value.id) }
const assets = [base, wall, floor].map(prepare), backend = createPhysicalBackend(gl, palette), pass = createPhysicalRenderPass(gl)
const before = captureSceneGlState(gl)
const state = () => { const value = fullGlState(gl), active = gl.getParameter(gl.ACTIVE_TEXTURE); gl.activeTexture(gl.TEXTURE2); value.set('texture2D/unit2', gl.getParameter(gl.TEXTURE_BINDING_2D)); value.set('sampler/unit2', gl.getParameter(gl.SAMPLER_BINDING)); gl.activeTexture(active); return value }
const hostTextures = [0, 1, 2].map(() => gl.createTexture()!), hostSamplers = [0, 1, 2].map(() => gl.createSampler()!)
hostTextures.forEach((texture, unit) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, texture); gl.bindSampler(unit, hostSamplers[unit]!) })
gl.activeTexture(gl.TEXTURE2); gl.viewport(0, 0, canvas.width, canvas.height); gl.enable(gl.SCISSOR_TEST); gl.scissor(2, 3, 12, 13); gl.depthRange(.2, .8)
const host = state(), results: unknown[] = []
const clear = () => { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.disable(gl.SCISSOR_TEST); gl.colorMask(true, true, true, true); gl.clearColor(1, 1, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT) }
const draw = (indexes: number[], opacity: number, useFractional = true, matrices: ReadonlyArray<Float32Array> = []) => {
  const saved = captureSceneGlState(gl), old = state()
  clear()
  const draws: PhysicalDraw[] = indexes.map((index, placement) => ({ asset: assets[index]!, meshes: assets[index]!.meshes, matrix: matrices[placement] ?? identity, flat: true, styles: [], architecture: { wallOpacity: opacity, floorOpacity: opacity } }))
  try { pass.begin(canvas.width, canvas.height); backend.draw(draws, 0, useFractional && opacity > 0 && opacity < 1 ? phase => pass.beginTransparency(phase) : undefined); pass.composite(null, null, [0, 0, canvas.width, canvas.height]) }
  finally { restoreSceneGlState(gl, saved) }
  const pixels = new Uint8Array(canvas.width * canvas.height * 4); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels); restoreSceneGlState(gl, saved)
  const at = (x: number, y: number) => [...pixels.slice((y * canvas.width + x) * 4, (y * canvas.width + x) * 4 + 4)]
  return { center: at(canvas.width / 2, canvas.height / 2), pixels, state: stateDifferences(old, state()), metrics: { ...backend.metrics, pass: pass.metrics() }, glError: gl.getError() }
}
for (const opacity of [0, .5, 1]) {
  const value = draw([0, 1], opacity), expected = opacity === 0 ? [0, 0, 255, 255] : opacity === 1 ? [255, 0, 0, 255] : [128, 0, 127, 255]
  results.push({ kind: 'single-red-over-blue', opacity, center: value.center, expected, passed: value.center.every((channel, index) => Math.abs(channel - expected[index]!) <= 1) && !value.state.length && !value.glError, state: value.state, glError: value.glError })
}
const forward = draw([0, 1, 2], .5), reverse = draw([2, 1, 0], .5)
let differentBytes = 0; for (let index = 0; index < forward.pixels.length; index++) if (forward.pixels[index] !== reverse.pixels[index]) differentBytes++
results.push({ kind: 'overlap-order', center: forward.center, reverse: reverse.center, differentBytes, expected: [128, 64, 64, 255], passed: differentBytes === 0 && forward.center.every((channel, index) => Math.abs(channel - [128, 64, 64, 255][index]!) <= 1) })
// At the same geometric silhouette, fractional red-over-blue must equal the
// average of opaque red and opaque blue at EVERY hardware antialiasing sample,
// including partially covered pixels. This oracle is independent of the OIT math.
const blueEdge = draw([0], 1), redEdge = draw([0, 1], 1), halfEdge = draw([0, 1], .5)
let edgeFailures = 0, edgeMaximumError = 0
const edgeExamples: unknown[] = []
for (let at = 0; at < halfEdge.pixels.length; at += 4) {
  if (!(redEdge.pixels[at + 1]! > 0 && redEdge.pixels[at + 1]! < 255)) continue
  let maximum = 0
  const expected = [0, 1, 2, 3].map(channel => (redEdge.pixels[at + channel]! + blueEdge.pixels[at + channel]!) / 2)
  for (let channel = 0; channel < 4; channel++) maximum = Math.max(maximum, Math.abs(halfEdge.pixels[at + channel]! - expected[channel]!))
  edgeMaximumError = Math.max(edgeMaximumError, maximum)
  if (maximum > 1) { edgeFailures++; if (edgeExamples.length < 4) edgeExamples.push({ x: at / 4 % canvas.width, y: Math.floor(at / 4 / canvas.width), expected, actual: [...halfEdge.pixels.slice(at, at + 4)], red: [...redEdge.pixels.slice(at, at + 4)], blue: [...blueEdge.pixels.slice(at, at + 4)] }) }
}
results.push({ kind: 'MSAA-shared-silhouette', edgeFailures, edgeMaximumError, edgeExamples, passed: edgeFailures === 0 })
const geometryBefore = backend.metrics.geometryUploads, prepBefore = prepares, allocationBefore = pass.metrics().allocations
for (const opacity of [.25, .75, 0, 1, .5]) draw([0, 1, 2], opacity)
results.push({ kind: 'slider-no-derived-geometry', geometryUploadsBefore: geometryBefore, geometryUploadsAfter: backend.metrics.geometryUploads, preparesBefore: prepBefore, preparesAfter: prepares, allocationsBefore: allocationBefore, allocationsAfter: pass.metrics().allocations, passed: geometryBefore === backend.metrics.geometryUploads && prepBefore === prepares && allocationBefore === pass.metrics().allocations })
const plane = (id: string, kind: 'wall' | 'slab', material: string, z: (x: number, y: number) => number): number => {
  const value = scene(id, kind, material, 0), object = value.objects[0]!
  const positions = [...object.positions]; for (let at = 0; at < positions.length; at += 3) positions[at + 2] = z(positions[at]!, positions[at + 1]!)
  assets.push(prepare({ ...value, objects: [{ ...object, positions }] })); return assets.length - 1
}
const slopeRed = plane('slope-red', 'wall', 'red', x => .4 * x), slopeGreen = plane('slope-green', 'slab', 'green', (_x, y) => .4 * y), slopeYellow = plane('slope-yellow', 'wall', 'yellow', (x, y) => -.4 * (x + y))
type Plane = { color: readonly number[]; depth: (x: number, y: number) => number }
const verifyAnalytic = (kind: string, indexes: number[], planes: ReadonlyArray<Plane>, matrices: ReadonlyArray<Float32Array> = []) => {
  const first = draw(indexes, .5, true, matrices), reverse = draw([...indexes].reverse(), .5, true, [...matrices].reverse())
  const samples: unknown[] = []; let errors = 0, maximumError = 0
  for (const targetX of [-.61, -.37, -.13, .11, .35, .59]) for (const targetY of [-.57, -.29, -.01, .27, .55]) {
    const px = Math.floor((targetX + 1) * canvas.width / 2), py = Math.floor((targetY + 1) * canvas.height / 2), x = (px + .5) / canvas.width * 2 - 1, y = (py + .5) / canvas.height * 2 - 1
    const sorted = planes.map(plane => ({ ...plane, z: plane.depth(x, y) })).sort((a, b) => b.z - a.z)
    // Stay away from exact intersection lines: their source-order tie semantics
    // are separately tested, not an order-independent colour claim.
    if (sorted.some((plane, at) => at > 0 && Math.abs(plane.z - sorted[at - 1]!.z) < 4 / canvas.width)) continue
    let color = [0, 0, 1]
    for (const plane of sorted) color = color.map((value, channel) => value * .5 + plane.color[channel]! * .5)
    const expected = [...color.map(value => Math.round(value * 255)), 255], at = (py * canvas.width + px) * 4, actual = [...first.pixels.slice(at, at + 4)], other = [...reverse.pixels.slice(at, at + 4)]
    // Three RGBA8 source-over operations can accumulate at most two integer
    // rounding units; this is a numeric-format oracle, not a quality threshold.
    const error = Math.max(...actual.map((value, channel) => Math.abs(value - expected[channel]!)), ...other.map((value, channel) => Math.abs(value - expected[channel]!)))
    maximumError = Math.max(maximumError, error); if (error > 2) errors++
    samples.push({ x, y, expected, actual, reverse: other })
  }
  results.push({ kind, samples, errors, maximumError, passed: samples.length > 0 && errors === 0 })
}
verifyAnalytic('three-intersecting-architecture-planes', [0, slopeRed, slopeGreen, slopeYellow], [{ color: [1, 0, 0], depth: x => .4 * x }, { color: [0, 1, 0], depth: (_x, y) => .4 * y }, { color: [1, 1, 0], depth: (x, y) => -.4 * (x + y) }])
const rotated = identity.slice(); rotated[0] = rotated[5] = -1
verifyAnalytic('shared-family-cross-placement-order', [0, slopeRed, slopeGreen, slopeRed], [{ color: [1, 0, 0], depth: x => .4 * x }, { color: [0, 1, 0], depth: (_x, y) => .4 * y }, { color: [1, 0, 0], depth: x => -.4 * x }], [identity, identity, identity, rotated])
// Negative capability is injected at the public GL boundary. This is NOT an
// assertion that the real test device lacks floating-point attachments.
const realExtension = gl.getExtension.bind(gl)
gl.getExtension = ((name: string) => name === 'EXT_color_buffer_float' ? null : realExtension(name)) as typeof gl.getExtension
const errors: string[] = [], negativeScene = scene('negative', 'wall', 'red', -.4), negativeAsset = prepare(negativeScene)
let negativeView = { ...view, wallOpacity: 1 }
const negative = createPhysicalSceneRenderer(gl, () => [{ scene: negativeScene, asset: negativeAsset, meshes: negativeAsset.meshes, view: negativeView, status: new Map() }], palette, () => ({ width: canvas.width, height: canvas.height }), error => errors.push(error.message))
const main = inverse(localMercatorMatrix(negativeScene.anchor, 0))
negative.render(main); const opaqueMetrics = negative.metrics(), initialPick = negative.pick({ x: canvas.width / 2, y: canvas.height / 2 })
const priorPixels = new Uint8Array(canvas.width * canvas.height * 4); gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, priorPixels)
negativeView = { ...negativeView, wallOpacity: .5 }; negative.render(main); const refusalMetrics = negative.metrics(), refusedPick = negative.pick({ x: canvas.width / 2, y: canvas.height / 2 })
const refusedPixels = new Uint8Array(priorPixels.length); gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, refusedPixels)
const changedRefusalBytes = refusedPixels.reduce((count, value, index) => count + Number(value !== priorPixels[index]), 0)
negativeView = { ...negativeView, wallOpacity: 1 }; negative.render(main); const recoveredMetrics = negative.metrics(), recoveredPick = negative.pick({ x: canvas.width / 2, y: canvas.height / 2 })
gl.getExtension = realExtension
const negativeCapability = { errors, initialPick: initialPick?.occurrenceId, refusedPick: refusedPick?.occurrenceId, changedRefusalBytes, recoveredPick: recoveredPick?.occurrenceId ?? null, opaqueDraws: opaqueMetrics.draws, refusedDraws: refusalMetrics.draws, recoveredDraws: recoveredMetrics.draws, recovered: recoveredMetrics.draws > refusalMetrics.draws && recoveredPick !== null && refusedPick?.occurrenceId === initialPick?.occurrenceId && changedRefusalBytes === 0 }
const hostState = stateDifferences(host, state())
restoreSceneGlState(gl, before); negative.dispose(); backend.dispose(); pass.dispose()
hostTextures.forEach(value => gl.deleteTexture(value)); hostSamplers.forEach(value => gl.deleteSampler(value))
const metrics = { ...backend.metrics, pass: pass.metrics(), negative: negative.metrics() }
const disposal = metrics.liveBuffersAfterDisposal === 0 && metrics.liveProgramsAfterDisposal === 0 && metrics.liveTexturesAfterDisposal === 0 && metrics.pass.liveTextures === 0 && metrics.pass.livePrograms === 0 && metrics.pass.liveFramebuffers === 0 && metrics.pass.liveRenderbuffers === 0
const result = { passed: (results as { passed: boolean }[]).every(value => value.passed) && disposal && negativeCapability.recovered && !hostState.length, results, negativeCapability, disposal, metrics, device: { dpr: devicePixelRatio, renderer: gl.getParameter(gl.RENDERER), version: gl.getParameter(gl.VERSION), samples: metrics.pass.samples }, hostState }
Object.assign(window, { opacityProbe: result })
document.querySelector('pre')!.textContent = JSON.stringify(result, null, 2)
