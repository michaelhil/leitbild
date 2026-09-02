import type { StartingRailSection, StartingRailView } from '../core/model/index.ts'
import type { CategoryRow } from './types.ts'

export const railSectionByCategory = (
  railConfig: StartingRailView | null,
): ReadonlyMap<string, StartingRailSection> =>
  new Map((railConfig?.sections ?? []).map(section => [section.categoryId, section]))

export const categoryRowsForStartingView = (
  categoryRows: ReadonlyArray<CategoryRow>,
  railConfig: StartingRailView | null,
): ReadonlyArray<CategoryRow> => {
  if (!railConfig) return []
  const rowsByCategoryId = new Map(categoryRows.map(row => [row.category.id, row]))
  return railConfig.sections
    .filter(section => section.visible)
    .flatMap(section => {
      const row = rowsByCategoryId.get(section.categoryId)
      return row ? [row] : []
    })
}

export const collapsedCategoryIdsForStartingView = (
  railConfig: StartingRailView | null,
): Record<string, boolean> =>
  Object.fromEntries((railConfig?.sections ?? []).map(section => [section.categoryId, section.collapsed]))

export const visibleFieldsForStartingView = (
  railConfig: StartingRailView | null,
): Record<string, ReadonlyArray<string>> =>
  Object.fromEntries((railConfig?.sections ?? []).map(section => [section.categoryId, section.visibleFields]))

export const startingViewKey = (
  railConfig: StartingRailView | null,
): string =>
  JSON.stringify((railConfig?.sections ?? []).map(section => ({
    categoryId: section.categoryId,
    visible: section.visible,
    collapsed: section.collapsed,
    visibleFields: section.visibleFields,
  })))
