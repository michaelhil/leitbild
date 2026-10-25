import type { OperationalObject } from '../../core/model/index.ts'
import type { PackObjectPresentation, WorldPackView } from '../../core/packs/protocol.ts'
import type { PhysicalSceneSource } from '../map/physical-scene/types.ts'

export interface PhysicalLayoutBinding {
  readonly packId: string
  readonly contribution: NonNullable<WorldPackView['physicalScenes']>
}
export interface PhysicalLayoutMapInteraction {
  readonly activate: (point: { readonly x: number; readonly y: number }) => boolean
  readonly dismiss: () => void
}

/** The scene never widens the operational map's object/category visibility. */
export const physicalLayoutSources = (input: {
  readonly bindings: ReadonlyArray<PhysicalLayoutBinding>
  readonly objects: ReadonlyArray<OperationalObject>
  readonly hiddenCategoryIds: ReadonlyArray<string>
  readonly presentationFor: (object: OperationalObject) => PackObjectPresentation
}): ReadonlyArray<PhysicalSceneSource> => {
  const hidden = new Set(input.hiddenCategoryIds)
  const visible = input.objects.filter(object => !hidden.has(input.presentationFor(object).categoryId))
  const byId = new Map(visible.map(object => [object.id as string, object]))
  return input.bindings.flatMap(({ packId, contribution }) => visible.filter(object => object.packId === packId).flatMap(object => {
    const descriptor = contribution.describe(object, visible)
    if (descriptor === null || !byId.has(descriptor.targetObjectId)) return []
    return [{ descriptor, load: () => contribution.load(object) }]
  }))
}
