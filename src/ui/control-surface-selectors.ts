import type { OperationalObject } from '../core/model/index.ts'
import type { LeitbildPack, PackCreateObjectType } from '../core/packs/protocol.ts'
import type { IconName } from './icons.ts'
import { isIconName } from './icons.ts'
import type { CategoryRow } from './types.ts'

export interface PlacementCursor {
  readonly icon: IconName
  readonly color: string
}

export const selectedControllerObjectFor = (
  objects: ReadonlyArray<OperationalObject>,
  selectedControllerId: string | null,
  pack: LeitbildPack,
): OperationalObject | null =>
  objects.find(object => object.id === selectedControllerId && pack.isController(object)) ?? null

export const categoryRowsFor = (
  objects: ReadonlyArray<OperationalObject>,
  pack: LeitbildPack,
): ReadonlyArray<CategoryRow> =>
  pack.categories.map(category => {
    const createType = pack.createObjectTypes.find(type => type.categoryId === category.id)
    return {
      category,
      objects: objects.filter(object => category.matches(object)),
      ...(createType === undefined ? {} : { createType }),
    }
  })

export const placementCursorFor = (
  placementMode: PackCreateObjectType | null,
  pack: LeitbildPack,
): PlacementCursor | null => {
  if (!placementMode) return null
  if (!isIconName(placementMode.icon)) {
    throw new Error(`pack ${pack.id} requested unknown create cursor icon: ${placementMode.icon}`)
  }
  return { icon: placementMode.icon, color: placementMode.color }
}
