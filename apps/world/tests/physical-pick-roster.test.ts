import { expect, test } from 'bun:test'
import type { PhysicalSceneObject } from '../src/core/packs/scene.ts'
import type { PhysicalMesh } from '../src/ui/map/physical-scene/geometry.ts'
import { pickPhysicalMesh, preparePhysicalPickAcceleration, type PhysicalPickEntry } from '../src/ui/map/physical-scene/picking.ts'
import { pickPhysicalMesh as frozenPick } from './fixtures/physical-layout/picking-before-scalar.ts'
import { visiblePhysicalSurfaceOwners } from '../src/ui/map/physical-scene/surface-ownership.ts'
const identity = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
const mesh = (id: string, z = 0, offset: PhysicalMesh['offset'] = [0, 0, 0]): PhysicalMesh => {
  const object: PhysicalSceneObject = { id, label: id, kind: 'equipment', positions: [-.7, -.7, z, .7, -.7, z, 0, .7, z], subjectIds: [id], levelId: 'ground' }
  return { key: id, object, vertices: [-.7, -.7, z, 0, 0, 1, 0, .7, -.7, z, 0, 0, 1, 0, 0, .7, z, 0, 0, 1, 0], lines: [], bounds: { min: [-.7, -.7, z], max: [.7, .7, z] }, offset }
}
const compare = (entries: ReadonlyArray<PhysicalPickEntry>, point = { x: 100, y: 100 }) => {
  const actual = pickPhysicalMesh(entries, point, 200, 200), prior = frozenPick(entries, point, 200, 200)
  expect(actual?.sceneId).toBe(prior?.sceneId); expect(actual?.mesh).toBe(prior?.mesh)
  expect(Object.is(actual?.depth, prior?.depth)).toBe(true); expect(actual?.position).toEqual(prior?.position)
  return actual
}

test('active subset wins in its exact first-source order, including reordered and duplicate identities', () => {
  const a = mesh('a'), b = mesh('b'), behind = mesh('behind', .3), roster = [behind, a, b, a]
  for (const meshes of [[a, b], [b, a], [b, a, b], [a, a, b], [behind], [a], [], roster]) {
    const actual = compare([{ sceneId: 'scene', roster, meshes, matrix: identity }])
    expect(actual?.mesh).toBe(meshes.includes(a) || meshes.includes(b) ? meshes.find(value => value === a || value === b) : meshes[0])
  }
  expect(compare([{ sceneId: 'first', roster, meshes: [b], matrix: identity }, { sceneId: 'second', roster, meshes: [a], matrix: identity }])?.sceneId).toBe('first')
})

test('stable acceleration never reads excluded source geometry or rebuilds broad phase for a fresh camera subset', () => {
  const inactive = mesh('inactive'), active = mesh('active', .2), roster = [inactive, active]
  const acceleration = preparePhysicalPickAcceleration(roster)
  Object.defineProperty(inactive, 'vertices', { get: () => { throw Error('An excluded triangle was tested') } })
  Object.defineProperty(inactive, 'bounds', { get: () => { throw Error('A camera subset rebuilt the broad phase') } })
  for (let index = 0; index < 8; index++) {
    expect(pickPhysicalMesh([{ sceneId: 'scene', roster, meshes: [active], matrix: identity }], { x: 100, y: 100 }, 200, 200)?.mesh).toBe(active)
    expect(preparePhysicalPickAcceleration(roster)).toBe(acceleration)
  }
})

test('only the latest weak active mask is reused, so returning after a different selection reindexes it', () => {
  const a = mesh('a'), b = mesh('b'), roster = [a, b]
  let reads = 0
  const subset = new Proxy([a], { get(target, key, receiver) { if (key === '0') reads++; return Reflect.get(target, key, receiver) } })
  const pick = (meshes: ReadonlyArray<PhysicalMesh>) => pickPhysicalMesh([{ sceneId: 'scene', roster, meshes, matrix: identity }], { x: 100, y: 100 }, 200, 200)
  expect(pick(subset)?.mesh).toBe(a); const first = reads
  expect(pick(subset)?.mesh).toBe(a); expect(reads).toBe(first)
  expect(pick([b])?.mesh).toBe(b)
  expect(pick(subset)?.mesh).toBe(a); expect(reads).toBeGreaterThan(first)
})

test('real separated offsets, nearest depths and scene ties remain exactly equal to frozen subset picking', () => {
  const roster = [mesh('left', -.2, [-.2, 0, .4]), mesh('right', -.4, [.2, 0, .2]), mesh('behind', .6), mesh('outside', 0, [3, 0, 0])]
  for (const meshes of [roster, [roster[0]!, roster[2]!], [roster[1]!], [roster[2]!, roster[0]!], []]) {
    for (const x of [0, 30, 70, 100, 130, 170, 200]) for (const y of [0, 50, 100, 150, 200]) compare([{ sceneId: 'scene', roster, meshes, matrix: identity }], { x, y })
  }
})

test('ownership fallback and complementary boundary selection admit only their exact displayed alternatives', () => {
  const full = { ...mesh('full'), inspectionPart: 'full' as const }, cut = { ...mesh('cut'), inspectionPart: 'cut' as const }, later = { ...mesh('later'), occludedBy: ['full'] }, roster = [full, cut, later]
  const fullView = visiblePhysicalSurfaceOwners([full, later]), cutView = visiblePhysicalSurfaceOwners([cut, later])
  expect(compare([{ sceneId: 'scene', roster, meshes: fullView, matrix: identity }])?.mesh).toBe(full)
  expect(compare([{ sceneId: 'scene', roster, meshes: cutView, matrix: identity }])?.mesh).toBe(cut)
  expect(compare([{ sceneId: 'scene', roster, meshes: visiblePhysicalSurfaceOwners([later]), matrix: identity }])?.mesh).toBe(later)
})

test('a shifted clone or unrelated mesh cannot silently borrow a different roster acceleration', () => {
  const original = mesh('original'), clone = { ...original, offset: [0, 0, .5] as const }
  expect(() => pickPhysicalMesh([{ sceneId: 'scene', roster: [original], meshes: [clone], matrix: identity }], { x: 100, y: 100 }, 200, 200)).toThrow('exact prepared roster')
})
