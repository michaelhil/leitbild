import type { OperationalObject } from '../../core/model/index.ts'
import type { PackPhysicalScene, PackPhysicalSceneDescriptor } from '../../core/packs/scene.ts'
import { campusLayoutDataSchema, canonicalPhysicalJson, physicalDesignManifest, physicalLayoutDataSchema, physicalLayoutPackId, turbineIslandLayoutDataSchema, type RetainedPhysicalLayoutData } from './model.ts'
import { physicalBuildingFootprints } from './native/campus/footprints.ts'

const parsed = new WeakMap<OperationalObject, RetainedPhysicalLayoutData>()
const footprints = new WeakMap<OperationalObject, ReturnType<typeof physicalBuildingFootprints>>()
const dataFor = (object: OperationalObject): RetainedPhysicalLayoutData => {
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
  const attached = (candidate: OperationalObject | undefined, anchor: readonly [number, number]): boolean => {
    const point = candidate?.spatial?.position?.point.coordinates
    return point !== undefined && Math.hypot((point[0] - anchor[0]) * Math.cos(anchor[1] * Math.PI / 180), point[1] - anchor[1]) * 111_320 < 0.5
  }
  const relatedMembers = 'relatedMembers' in data ? data.relatedMembers : []
  const invalidMember = relatedMembers.find(member => !attached(objects.find(candidate => candidate.id === member.objectId && candidate.packId === member.packId), member.anchor))
  const locationValid = attached(owner, data.placement.anchor) && invalidMember === undefined
  let overviewFootprints = footprints.get(object)
  if (overviewFootprints === undefined && 'requirements' in data) {
    overviewFootprints = physicalBuildingFootprints(data.source)
    footprints.set(object, overviewFootprints)
  }
  return {
    id: object.id, revision: data.design.digest, targetObjectId: data.owner.objectId,
    anchor: data.placement.anchor, bearing: data.placement.bearing, bounds: data.bounds,
    levels: data.source.levels.map(level => ({ ...level, cutHeight: level.elevation + level.cutHeight })),
    subjectIds: data.coverage.representedSubjectIds, modelDigest: data.owner.modelDigest,
    ...(relatedMembers.length === 0 ? {} : { relatedTargets: relatedMembers.map(member => ({ objectId: member.objectId, packId: member.packId, modelDigest: member.modelDigest })) }),
    ...(overviewFootprints === undefined ? {} : { overviewFootprints }),
    locationValid, ...(locationValid ? {} : { reason: invalidMember ? `Location mismatch: related member ${invalidMember.role} moved or is unavailable` : owner ? 'Location mismatch: the owner moved after layout admission' : 'Layout owner is unavailable' }),
  }
}

/** Check retained source before compiling it. A mutable library head is never read. */
export const loadPhysicalLayoutScene = async (object: OperationalObject): Promise<PackPhysicalScene> => {
  const data = dataFor(object)
  const hash = async (value: unknown): Promise<string> => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalPhysicalJson(value))))).map(value => value.toString(16).padStart(2, '0')).join('')
  if (await hash(data.source) !== data.sourceDigest || await hash(data.bindings) !== data.bindingDigest) throw new Error(`Physical layout ${object.id} retained source/binding digest mismatch`)
  if ('coverageDigest' in data && await hash(data.coverageEvidence) !== data.coverageDigest) throw new Error(`Physical layout ${object.id} retained coverage digest mismatch`)
  const manifestDigest = await hash(physicalDesignManifest(data))
  if (manifestDigest !== data.design.digest || data.design.id !== data.source.id) throw new Error(`Physical layout ${object.id} retained Design digest mismatch`)
  if (data.compiler.id === 'physical-layout-native') {
    const { compilePhysicalScene } = await import('./native/compile-scene.ts')
    return compilePhysicalScene(object.id, turbineIslandLayoutDataSchema.parse(data))
  }
  const { compilePhysicalScene } = await import('./native/campus/compile-scene.ts')
  return compilePhysicalScene(object.id, campusLayoutDataSchema.parse(data))
}
