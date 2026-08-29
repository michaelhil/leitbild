import type { OperationalObject } from '../core/model/index.ts'
import type { WorldPack, PackCreateObjectType } from '../core/packs/protocol.ts'
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
  pack: WorldPack,
): OperationalObject | null =>
  objects.find(object => object.id === selectedControllerId && pack.commands.isController(object)) ?? null

const compareOperationalObjectsForRail = (left: OperationalObject, right: OperationalObject): number => {
  const labelComparison = left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: 'base' })
  if (labelComparison !== 0) return labelComparison
  return left.id.localeCompare(right.id, undefined, { numeric: true, sensitivity: 'base' })
}

export const categoryRowsFor = (
  objects: ReadonlyArray<OperationalObject>,
  pack: WorldPack,
): ReadonlyArray<CategoryRow> =>
  pack.presentation.categories.map(category => {
    const createType = pack.commands.createObjectTypes.find(type => type.categoryId === category.id)
    return {
      category,
      objects: [...objects.filter(object => category.matches(object))].sort(compareOperationalObjectsForRail),
      ...(createType === undefined ? {} : { createType }),
    }
  })

export const placementCursorFor = (
  placementMode: PackCreateObjectType | null,
  pack: WorldPack,
): PlacementCursor | null => {
  if (!placementMode) return null
  if (!isIconName(placementMode.icon)) {
    throw new Error(`pack ${pack.descriptor.id} requested unknown create cursor icon: ${placementMode.icon}`)
  }
  return { icon: placementMode.icon, color: placementMode.color }
}
