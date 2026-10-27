import type { PackPhysicalScene } from '../../../src/core/packs/scene.ts'
import { createPhysicalBackend, type PhysicalDraw } from '../../../src/ui/map/physical-scene/backend.ts'
import { createPhysicalArchitectureBackend } from '../../../src/ui/map/physical-scene/architecture-backend.ts'
import { preparePhysicalArchitectureBsp } from '../../../src/ui/map/physical-scene/architecture-bsp.ts'
import type { PhysicalArchitectureBsp } from '../../../src/ui/map/physical-scene/architecture-bsp-types.ts'
import { createPhysicalRenderPass } from '../../../src/ui/map/physical-scene/render-pass.ts'
import { createPhysicalSceneRenderer } from '../../../src/ui/map/physical-scene/renderer.ts'
import { preparePhysicalGeometry } from '../../../src/ui/map/physical-scene/preparation.ts'
import { captureSceneGlState, restoreSceneGlState } from '../../../src/ui/map/physical-scene/gl-state.ts'
import { inverse, localMercatorMatrix, multiply } from '../../../src/ui/map/physical-scene/math.ts'
import { defaultPhysicalSceneView, type PhysicalSceneView } from '../../../src/ui/map/physical-scene/types.ts'
import { fullGlState, stateDifferences } from './gl-probes.ts'

// Independent known-colour geometry, test-only. All colour/opacity work passes
// through the production buffers, shader, owned MSAA targets and compositor.
const canvas = document.querySelector('canvas')!, gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true })!
if (!gl) throw Error('Opacity fixture needs WebGL2')
canvas.width = canvas.height = 128 * devicePixelRatio
const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
const palette = { materials: { red: [1, 0, 0] as const, green: [0, 1, 0] as const, blue: [0, 0, 1] as const, yellow: [1, 1, 0] as const }, defaultMaterial: [0, 0, 0] as const, line: [0, 0, 0] as const }
const scene = (id: string, kind: 'wall' | 'slab' | 'equipment' | 'context', material: string, z: number, left = -.8, right = .8): PackPhysicalScene => ({
  id, revision: 'opacity-probe', targetObjectId: id, anchor: [0, 0], bearing: 0, bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
  levels: [{ id: 'floor', label: 'Floor', elevation: -1, cutHeight: 1 }], objects: [{ id, label: id, kind, levelId: 'site', subjectIds: kind === 'equipment' ? [id] : [], edgePolicy: 'none', material,
    positions: [left, -.8, z, right, -.8, z, right, .8, z, left, -.8, z, right, .8, z, left, .8, z], normals: Array.from({ length: 6 }, () => [0, 0, 1]).flat() }],
})
const base = scene('blue', 'equipment', 'blue', .6), wall = scene('red', 'wall', 'red', -.4), floor = scene('green', 'slab', 'green', 0)
const view: PhysicalSceneView = { ...defaultPhysicalSceneView(base.levels), mode: '3d', levelId: 'all', cutaway: false }
let prepares = 0
const prepare = (value: PackPhysicalScene) => { prepares++; return preparePhysicalGeometry(value, view, value.id, value.id) }
const assets = [base, wall, floor].map(prepare), backend = createPhysicalBackend(gl, palette), architecture = createPhysicalArchitectureBackend(gl, palette), pass = createPhysicalRenderPass(gl)
const cohorts = new Map<string, PhysicalArchitectureBsp>(); let bspPrepares = 0
const before = captureSceneGlState(gl)
const state = () => { const value = fullGlState(gl), active = gl.getParameter(gl.ACTIVE_TEXTURE); gl.activeTexture(gl.TEXTURE2); value.set('texture2D/unit2', gl.getParameter(gl.TEXTURE_BINDING_2D)); value.set('sampler/unit2', gl.getParameter(gl.SAMPLER_BINDING)); gl.activeTexture(active); return value }
const hostTextures = [0, 1, 2].map(() => gl.createTexture()!), hostSamplers = [0, 1, 2].map(() => gl.createSampler()!)
hostTextures.forEach((texture, unit) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, texture); gl.bindSampler(unit, hostSamplers[unit]!) })
gl.activeTexture(gl.TEXTURE2); gl.viewport(0, 0, canvas.width, canvas.height); gl.enable(gl.SCISSOR_TEST); gl.scissor(2, 3, 12, 13); gl.depthRange(.2, .8)
const host = state(), results: unknown[] = []
const clear = () => { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.disable(gl.SCISSOR_TEST); gl.colorMask(true, true, true, true); gl.clearColor(1, 1, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT) }
const draw = (indexes: number[], opacity: number, _useFractional = true, matrices: ReadonlyArray<Float32Array> = [], projection = identity, flat = true, near = 0) => {
  const saved = captureSceneGlState(gl), old = state()
  clear()
  const placements = indexes.map((index, placement) => { const matrix = matrices[placement] ?? identity; return { sceneId: `${assets[index]!.key}/${JSON.stringify([...matrix])}`, asset: assets[index]!, matrix } })
  const draws: PhysicalDraw[] = placements.map(placement => ({ sceneId: placement.sceneId, asset: placement.asset, meshes: placement.asset.meshes, matrix: new Float32Array(multiply(projection, placement.matrix)), flat, styles: [], architecture: { wallOpacity: opacity, floorOpacity: opacity } }))
  const owners = placements.flatMap(placement => placement.asset.meshes.flatMap((mesh, meshIndex) => mesh.object.kind === 'wall' || mesh.object.kind === 'slab' ? [{ placement, mesh, meshIndex, id: `${placement.sceneId}/${meshIndex}` }] : [])).sort((a, b) => a.id.localeCompare(b.id))
  const key = JSON.stringify(owners.map(owner => owner.id))
  let cohort = cohorts.get(key)
  if (!cohort && owners.length) {
    const common = inverse(owners[0]!.placement.matrix)
    cohort = preparePhysicalArchitectureBsp({ key, sources: owners.map(({ placement, mesh, meshIndex, id }) => {
      const offset = new Float64Array(identity); offset.set(mesh.offset, 12)
      return { id, sceneId: placement.sceneId, assetKey: placement.asset.key, meshIndex, occurrenceId: mesh.object.id, matrix: multiply(common, multiply(placement.matrix, offset)), vertices: mesh.vertices, lines: mesh.lines, materials: mesh.materials ?? mesh.object.materials ?? [mesh.object.material ?? mesh.object.kind], lineMaterials: mesh.lineMaterials ?? Array.from({ length: mesh.lines.length / 6 }, () => 'line'), ...(mesh.lineStyles ? { lineStyles: mesh.lineStyles } : {}) }
    }) }); bspPrepares++; cohorts.set(key, cohort)
  }
  try { architecture.setAsset(cohort ?? null); pass.begin(canvas.width, canvas.height); backend.draw(draws, near); architecture.draw(draws, near); pass.composite(null, null, [0, 0, canvas.width, canvas.height]) }
  finally { restoreSceneGlState(gl, saved) }
  const pixels = new Uint8Array(canvas.width * canvas.height * 4); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels); restoreSceneGlState(gl, saved)
  const at = (x: number, y: number) => [...pixels.slice((y * canvas.width + x) * 4, (y * canvas.width + x) * 4 + 4)]
  return { center: at(canvas.width / 2, canvas.height / 2), pixels, draws, cohort, state: stateDifferences(old, state()), metrics: { ...backend.metrics, architecture: architecture.metrics(), pass: pass.metrics() }, glError: gl.getError() }
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
draw([0, 1, 2], .5)
const geometryUploads = () => backend.metrics.geometryUploads + architecture.metrics().geometryUploads
const geometryBefore = geometryUploads(), prepBefore = prepares, bspBefore = bspPrepares, allocationBefore = pass.metrics().allocations
for (const opacity of [.25, .75, 0, 1, .5]) draw([0, 1, 2], opacity)
results.push({ kind: 'slider-no-derived-geometry', geometryUploadsBefore: geometryBefore, geometryUploadsAfter: geometryUploads(), preparesBefore: prepBefore, preparesAfter: prepares, bspPreparesBefore: bspBefore, bspPreparesAfter: bspPrepares, allocationsBefore: allocationBefore, allocationsAfter: pass.metrics().allocations, passed: geometryBefore === geometryUploads() && prepBefore === prepares && bspBefore === bspPrepares && allocationBefore === pass.metrics().allocations })
const withDetail = draw([0, 1, 2], .5), contextAsset = prepare(scene('coarse-context', 'context', 'blue', 0)), outside = identity.slice(); outside[12] = 3
const referenceOwner = withDetail.cohort!.owners[0]!, referenceDraw = withDetail.draws.find(value => value.sceneId === referenceOwner.sceneId && value.asset.key === referenceOwner.assetKey)!
const contextDraw: PhysicalDraw = { ...referenceDraw, asset: contextAsset, meshes: contextAsset.meshes, matrix: outside }
const contextHost = captureSceneGlState(gl)
clear(); pass.begin(canvas.width, canvas.height); backend.draw([...withDetail.draws, contextDraw]); architecture.draw([...withDetail.draws, contextDraw]); pass.composite(null, null, [0, 0, canvas.width, canvas.height])
const contextPixels = new Uint8Array(withDetail.pixels.length); gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, contextPixels); restoreSceneGlState(gl, contextHost)
const contextDifferences = contextPixels.reduce((count, value, index) => count + Number(value !== withDetail.pixels[index]), 0)
results.push({ kind: 'same-scene-overview-does-not-replace-detailed-asset', sameSceneId: contextDraw.sceneId === referenceDraw.sceneId, distinctAsset: contextDraw.asset.key !== referenceDraw.asset.key, differentBytes: contextDifferences, passed: contextDifferences === 0 })
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
const lineScene = scene('far-authored-line', 'wall', 'red', .4), farLine = assets.length
assets.push(prepare({ ...lineScene, objects: [{ ...lineScene.objects[0]!, edgePolicy: 'authored', featureLines: [{ positions: [-.7, 0, .4, .7, 0, .4], material: 'line' }] }] }))
const nearGreen = assets.length; assets.push(prepare(scene('near-green', 'slab', 'green', -.2)))
const lineFrame = draw([0, farLine, nearGreen], .5), lineReverse = draw([nearGreen, farLine, 0], .5)
let linePixels = 0, lineErrors = 0, lineOrderBytes = 0
for (let index = 0; index < lineFrame.pixels.length; index++) if (lineFrame.pixels[index] !== lineReverse.pixels[index]) lineOrderBytes++
for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
  const nx = (x + .5) / canvas.width * 2 - 1, ny = (y + .5) / canvas.height * 2 - 1
  if (Math.abs(nx) > .65 || Math.abs(ny) > .05) continue
  const at = (y * canvas.width + x) * 4
  if (lineFrame.pixels[at]! >= 62) continue
  linePixels++
  // Far-wall ink must be attenuated BEFORE the near green surface. Drawing
  // every line last would also attenuate green and fails this independent test.
  if (Math.abs(lineFrame.pixels[at + 1]! - 128) > 1) lineErrors++
}
results.push({ kind: 'authored-line-traverses-with-its-far-wall', linePixels, errors: lineErrors, orderDifferentBytes: lineOrderBytes, passed: linePixels > 0 && lineErrors === 0 && lineOrderBytes === 0 })
const perspectiveBase = assets.length; assets.push(prepare(scene('perspective-blue', 'equipment', 'blue', -.9)))
const near = .1, far = 10, distance = 3, focal = 1 / Math.tan(Math.PI / 8)
const perspective = new Float32Array([focal, 0, 0, 0, 0, focal, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, -distance * (far + near) / (near - far) + 2 * far * near / (near - far), distance])
const perspectiveIndexes = [perspectiveBase, slopeRed, slopeGreen, slopeYellow]
const perspectiveFirst = draw(perspectiveIndexes, .5, true, [], perspective, false, near), perspectiveReverse = draw([...perspectiveIndexes].reverse(), .5, true, [], perspective, false, near)
const light = .6 + .1 + .28 * .88 / Math.hypot(.45, .55, .88) + .12 * .4 / Math.hypot(.65, .8, .4)
const perspectiveSamples: unknown[] = []; let perspectiveErrors = 0, perspectiveMaximumError = 0
for (const targetX of [-.17, -.07, .03, .13]) for (const targetY of [-.19, -.09, .01, .11]) {
  const px = Math.floor((targetX + 1) * canvas.width / 2), py = Math.floor((targetY + 1) * canvas.height / 2), x = (px + .5) / canvas.width * 2 - 1, y = (py + .5) / canvas.height * 2 - 1
  const ordered = [{ a: .4, b: 0, rgb: [1, 0, 0] }, { a: 0, b: .4, rgb: [0, 1, 0] }, { a: -.4, b: -.4, rgb: [1, 1, 0] }].map(plane => ({ ...plane, z: (plane.a * x + plane.b * y) * distance / (focal + plane.a * x + plane.b * y) })).sort((a, b) => a.z - b.z)
  if (ordered.some((plane, at) => at > 0 && Math.abs(plane.z - ordered[at - 1]!.z) < 4 / canvas.width)) continue
  let color = [0, 0, light]
  for (const plane of ordered) color = color.map((value, channel) => value * .5 + plane.rgb[channel]! * light * .5)
  const expected = [...color.map(value => Math.round(value * 255)), 255], at = (py * canvas.width + px) * 4, actual = [...perspectiveFirst.pixels.slice(at, at + 4)], reverse = [...perspectiveReverse.pixels.slice(at, at + 4)]
  const error = Math.max(...actual.map((value, channel) => Math.abs(value - expected[channel]!)), ...reverse.map((value, channel) => Math.abs(value - expected[channel]!)))
  if (error > 2) perspectiveErrors++; perspectiveMaximumError = Math.max(perspectiveMaximumError, error)
  perspectiveSamples.push({ x, y, expected, actual, reverse })
}
results.push({ kind: 'perspective-cyclic-order-and-original-lighting', samples: perspectiveSamples, errors: perspectiveErrors, maximumError: perspectiveMaximumError, passed: perspectiveSamples.length > 0 && perspectiveErrors === 0 })
// Ordered native-MSAA transparency must not require the rejected extra
// floating-colour capability. Inject its refusal at the public GL boundary.
const realExtension = gl.getExtension.bind(gl)
let floatQueries = 0
gl.getExtension = ((name: string) => name === 'EXT_color_buffer_float' ? (floatQueries++, null) : realExtension(name)) as typeof gl.getExtension
const errors: string[] = [], negativeScene = scene('negative', 'wall', 'red', -.4), negativeAsset = prepare(negativeScene)
let negativeView = { ...view, wallOpacity: 1 }
const negative = createPhysicalSceneRenderer(gl, () => [{ scene: negativeScene, asset: negativeAsset, meshes: negativeAsset.meshes, view: negativeView, status: new Map() }], palette, () => ({ width: canvas.width, height: canvas.height }), error => errors.push(error.message))
negative.setArchitectureBsp(preparePhysicalArchitectureBsp({ key: 'no-float-extension', sources: negativeAsset.meshes.map((mesh, meshIndex) => ({ id: `negative/${meshIndex}`, sceneId: negativeScene.id, assetKey: negativeAsset.key, meshIndex, occurrenceId: mesh.object.id, matrix: identity, vertices: mesh.vertices, lines: mesh.lines, materials: mesh.materials ?? [mesh.object.material!], lineMaterials: mesh.lineMaterials ?? [] })) }))
const main = inverse(localMercatorMatrix(negativeScene.anchor, 0))
negative.render(main); const opaqueMetrics = negative.metrics(), initialPick = negative.pick({ x: canvas.width / 2, y: canvas.height / 2 })
const priorPixels = new Uint8Array(canvas.width * canvas.height * 4); gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, priorPixels)
negativeView = { ...negativeView, wallOpacity: .5 }; negative.render(main); const refusalMetrics = negative.metrics(), refusedPick = negative.pick({ x: canvas.width / 2, y: canvas.height / 2 })
const refusedPixels = new Uint8Array(priorPixels.length); gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, refusedPixels)
const changedRefusalBytes = refusedPixels.reduce((count, value, index) => count + Number(value !== priorPixels[index]), 0)
negativeView = { ...negativeView, wallOpacity: 1 }; negative.render(main); const recoveredMetrics = negative.metrics(), recoveredPick = negative.pick({ x: canvas.width / 2, y: canvas.height / 2 })
gl.getExtension = realExtension
const negativeCapability = { errors, floatQueries, initialPick: initialPick?.occurrenceId, fractionalPick: refusedPick?.occurrenceId ?? null, changedFractionalBytes: changedRefusalBytes, recoveredPick: recoveredPick?.occurrenceId ?? null, opaqueDraws: opaqueMetrics.draws, fractionalDraws: refusalMetrics.draws, recoveredDraws: recoveredMetrics.draws, recovered: errors.length === 0 && floatQueries === 0 && recoveredMetrics.draws > refusalMetrics.draws && refusalMetrics.draws > opaqueMetrics.draws && recoveredPick !== null && changedRefusalBytes > 0 }
const contactScene: PackPhysicalScene = { ...base, id: 'contact', targetObjectId: 'contact', objects: [{ ...scene('floor', 'slab', 'red', 0).objects[0]! }, { ...scene('contact-equipment', 'equipment', 'blue', 0).objects[0]! }] }
const contactAsset = prepare(contactScene), contactErrors: string[] = []
let contactView = { ...view, floorOpacity: 1 }
const contact = createPhysicalSceneRenderer(gl, () => [{ scene: contactScene, asset: contactAsset, meshes: contactAsset.meshes, view: contactView, status: new Map() }], palette, () => ({ width: canvas.width, height: canvas.height }), error => contactErrors.push(error.message))
const contactHost = captureSceneGlState(gl)
clear(); contact.render(main); restoreSceneGlState(gl, contactHost); const contactUploads = contact.metrics().geometryUploads
contactView = { ...contactView, floorOpacity: 0 }; clear(); contact.render(main); restoreSceneGlState(gl, contactHost)
const contactPixel = new Uint8Array(4); gl.readPixels(canvas.width / 2, canvas.height / 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, contactPixel)
const contactPick = contact.pick({ x: canvas.width / 2, y: canvas.height / 2 })
results.push({ kind: 'hidden-architecture-reveals-coplanar-equipment', pixel: [...contactPixel], picked: contactPick?.occurrenceId ?? null, errors: contactErrors, geometryUploadsBefore: contactUploads, geometryUploadsAfter: contact.metrics().geometryUploads, passed: contactPixel[2]! > 100 && contactPixel[0]! < 2 && contactPixel[1]! < 2 && contactPick?.occurrenceId === 'contact-equipment' && !contactErrors.length && contactUploads === contact.metrics().geometryUploads })
const hostState = stateDifferences(host, state())
restoreSceneGlState(gl, before); negative.dispose(); contact.dispose(); backend.dispose(); architecture.dispose(); pass.dispose()
hostTextures.forEach(value => gl.deleteTexture(value)); hostSamplers.forEach(value => gl.deleteSampler(value))
const metrics = { ...backend.metrics, architecture: architecture.metrics(), pass: pass.metrics(), negative: negative.metrics(), contact: contact.metrics() }
const disposal = [metrics, metrics.architecture, metrics.negative, metrics.contact].every(value => value.liveBuffersAfterDisposal === 0 && value.liveProgramsAfterDisposal === 0 && value.liveTexturesAfterDisposal === 0) && metrics.pass.liveTextures === 0 && metrics.pass.livePrograms === 0 && metrics.pass.liveFramebuffers === 0 && metrics.pass.liveRenderbuffers === 0
const result = { passed: (results as { passed: boolean }[]).every(value => value.passed) && disposal && negativeCapability.recovered && !hostState.length, results, negativeCapability, disposal, metrics, device: { dpr: devicePixelRatio, renderer: gl.getParameter(gl.RENDERER), version: gl.getParameter(gl.VERSION), samples: metrics.pass.samples }, hostState }
Object.assign(window, { opacityProbe: result })
document.querySelector('pre')!.textContent = JSON.stringify(result, null, 2)
