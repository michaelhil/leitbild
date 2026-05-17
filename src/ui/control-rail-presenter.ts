import type { OperationalObject } from '../core/model/index.ts'
import type { PackObjectField, PackObjectPresentation, PackObjectStatusPresentation } from '../core/packs/protocol.ts'
import { isIconName, type IconName } from './icons.ts'
import type { CategoryRow } from './types.ts'

export interface FieldVisibilityOption {
  readonly key: string
  readonly label: string
}

export type FieldVisibilityState = Record<string, ReadonlyArray<string>>

export interface PresentedObjectRow {
  readonly object: OperationalObject
  readonly presentation: PackObjectPresentation
  readonly status: PackObjectStatusPresentation
  readonly visibleFields: ReadonlyArray<PackObjectField>
  readonly hasNewInfo: boolean
}

export interface PresentedCategoryRow {
  readonly row: CategoryRow
  readonly headerIcon: IconName | null
  readonly collapsed: boolean
  readonly fieldMenuOpen: boolean
  readonly visibleFields: ReadonlyArray<string>
  readonly fieldOptions: ReadonlyArray<FieldVisibilityOption>
  readonly presentedRows: ReadonlyArray<PresentedObjectRow>
}

const objectStatus = (
  object: OperationalObject,
  presentation: PackObjectPresentation,
): PackObjectStatusPresentation =>
  presentation.status ?? { tone: 'idle', label: object.operational.status, indicator: { shape: 'dot' } }

const categoryIcon = (row: CategoryRow): IconName | null => {
  const icon = row.createType?.icon ?? ''
  if (!icon) return null
  if (!isIconName(icon)) throw new Error(`category ${row.category.id} requested unknown icon: ${icon}`)
  return icon
}

const visibleFieldsFor = (
  visibility: FieldVisibilityState,
  categoryId: string,
): ReadonlyArray<string> =>
  visibility[categoryId] ?? []

const visibleFieldsForObject = (
  selectedFieldKeys: ReadonlyArray<string>,
  presentation: PackObjectPresentation,
): ReadonlyArray<PackObjectField> => {
  if (selectedFieldKeys.length === 0) return []
  const selected = new Set(selectedFieldKeys)
  return presentation.fields.filter(field => selected.has(field.key))
}

const fieldOptionsFor = (
  presentedRows: ReadonlyArray<PresentedObjectRow>,
): ReadonlyArray<FieldVisibilityOption> => {
  const fields = new Map<string, string>()
  for (const row of presentedRows) {
    for (const field of row.presentation.fields) fields.set(field.key, field.label)
  }
  return [...fields.entries()]
    .sort((left, right) => left[1].localeCompare(right[1], undefined, { numeric: true, sensitivity: 'base' }))
    .map(([key, label]) => ({ key, label }))
}

const presentedRowsFor = (config: {
  readonly row: CategoryRow
  readonly visibleFields: ReadonlyArray<string>
  readonly presentationFor: (object: OperationalObject) => PackObjectPresentation
  readonly hasNewInfo: (object: OperationalObject) => boolean
}): ReadonlyArray<PresentedObjectRow> =>
  config.row.objects.map(object => {
    const presentation = config.presentationFor(object)
    return {
      object,
      presentation,
      status: objectStatus(object, presentation),
      visibleFields: visibleFieldsForObject(config.visibleFields, presentation),
      hasNewInfo: config.hasNewInfo(object),
    }
  })

export const buildPresentedCategoryRows = (config: {
  readonly categoryRows: ReadonlyArray<CategoryRow>
  readonly collapsedCategoryIds: Record<string, boolean>
  readonly openFieldCategoryId: string | null
  readonly visibleFieldsByCategory: FieldVisibilityState
  readonly presentationFor: (object: OperationalObject) => PackObjectPresentation
  readonly hasNewInfo: (object: OperationalObject) => boolean
}): ReadonlyArray<PresentedCategoryRow> =>
  config.categoryRows.map(row => {
    const visibleFields = visibleFieldsFor(config.visibleFieldsByCategory, row.category.id)
    const presentedRows = presentedRowsFor({
      row,
      visibleFields,
      presentationFor: config.presentationFor,
      hasNewInfo: config.hasNewInfo,
    })
    return {
      row,
      headerIcon: categoryIcon(row),
      collapsed: config.collapsedCategoryIds[row.category.id] === true,
      fieldMenuOpen: config.openFieldCategoryId === row.category.id,
      visibleFields,
      fieldOptions: fieldOptionsFor(presentedRows),
      presentedRows,
    }
  })
