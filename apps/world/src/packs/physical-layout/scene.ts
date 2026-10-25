import type { OperationalObject } from '../../core/model/index.ts'
import type { PackPhysicalScene, PackPhysicalSceneDescriptor } from '../../core/packs/scene.ts'
import { canonicalPhysicalJson, physicalLayoutDataSchema, physicalLayoutPackId, type PhysicalLayoutData } from './model.ts'

const parsed = new WeakMap<OperationalObject, PhysicalLayoutData>()
const dataFor = (object: OperationalObject): PhysicalLayoutData => {
  const cached = parsed.get(object)
  if (cached) return cached
  const data = physicalLayoutDataSchema.parse(object.packData)
  parsed.set(object, data)
  return data
}

export const describePhysicalLayoutScene = (object: OperationalObject, objects: ReadonlyArray<OperationalObject>): PackPhysicalSceneDescriptor | null => {
  if (object.packId !== physicalLayoutPackId) return null
  const data = dataFor(object)
  const owner = objects.find(candidate => candidate.id === data.owner.objectId && candidate.packId === data.owner.packId)
  const point = owner?.spatial?.position?.point.coordinates
  const [lon, lat] = data.placement.anchor
  const delta = point ? Math.hypot((point[0] - lon) * Math.cos(lat * Math.PI / 180), point[1] - lat) * 111_320 : Infinity
  const locationValid = delta < 0.5
  return {
    id: object.id, revision: data.design.digest, targetObjectId: data.owner.objectId,
    anchor: data.placement.anchor, bearing: data.placement.bearing, bounds: data.bounds,
    levels: data.source.levels.map(level => ({ ...level, cutHeight: level.elevation + level.cutHeight })),
    subjectIds: data.coverage.representedSubjectIds, modelDigest: data.owner.modelDigest,
    locationValid, ...(locationValid ? {} : { reason: owner ? 'Location mismatch: the owner moved after layout admission' : 'Layout owner is unavailable' }),
  }
}

/** Check retained source before compiling it. A mutable library head is never read. */
export const loadPhysicalLayoutScene = async (object: OperationalObject): Promise<PackPhysicalScene> => {
  const data = dataFor(object)
  const hash = async (value: unknown): Promise<string> => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalPhysicalJson(value))))).map(value => value.toString(16).padStart(2, '0')).join('')
  if (await hash(data.source) !== data.sourceDigest || await hash(data.bindings) !== data.bindingDigest) throw new Error(`Physical layout ${object.id} retained source/binding digest mismatch`)
  const manifestDigest = await hash({ sourceDigest: data.sourceDigest, bindingDigest: data.bindingDigest, modelRequirement: { modelRef: data.owner.modelRef, modelDigest: data.owner.modelDigest }, compiler: data.compiler })
  if (manifestDigest !== data.design.digest || data.design.id !== data.source.id) throw new Error(`Physical layout ${object.id} retained Design digest mismatch`)
  const { compilePhysicalScene } = await import('./native/compile-scene.ts')
  return compilePhysicalScene(object.id, data)
}
