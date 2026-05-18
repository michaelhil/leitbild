import type {
  SurfaceDefinition,
  SurfaceMapRegionConfig,
  SurfaceObjectRailRegionConfig,
  SurfaceObjectRailSectionConfig,
  SurfaceRegionDefinition,
} from '../core/model/index.ts'
import type { CategoryRow } from './types.ts'

export const visibleSurfaceRegion = <T extends SurfaceRegionDefinition['primitive']>(
  surface: SurfaceDefinition | null,
  primitive: T,
): Extract<SurfaceRegionDefinition, { readonly primitive: T }> | null => {
  const region = surface?.regions.find(candidate => candidate.primitive === primitive && candidate.visible)
  return region ? region as Extract<SurfaceRegionDefinition, { readonly primitive: T }> : null
}

export const surfaceHasPrimitive = (
  surface: SurfaceDefinition | null,
  primitive: SurfaceRegionDefinition['primitive'],
): boolean =>
  visibleSurfaceRegion(surface, primitive) !== null

export const surfaceMapConfig = (
  surface: SurfaceDefinition | null,
): SurfaceMapRegionConfig | null =>
  visibleSurfaceRegion(surface, 'map')?.config ?? null

export const surfaceObjectRailConfig = (
  surface: SurfaceDefinition | null,
): SurfaceObjectRailRegionConfig | null =>
  visibleSurfaceRegion(surface, 'objectRail')?.config ?? null

export const railSectionByCategory = (
  railConfig: SurfaceObjectRailRegionConfig | null,
): ReadonlyMap<string, SurfaceObjectRailSectionConfig> =>
  new Map((railConfig?.sections ?? []).map(section => [section.categoryId, section]))

export const categoryRowsForSurface = (
  categoryRows: ReadonlyArray<CategoryRow>,
  railConfig: SurfaceObjectRailRegionConfig | null,
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

export const collapsedCategoryIdsForSurface = (
  railConfig: SurfaceObjectRailRegionConfig | null,
): Record<string, boolean> =>
  Object.fromEntries((railConfig?.sections ?? []).map(section => [section.categoryId, section.collapsed]))

export const visibleFieldsForSurface = (
  railConfig: SurfaceObjectRailRegionConfig | null,
): Record<string, ReadonlyArray<string>> =>
  Object.fromEntries((railConfig?.sections ?? []).map(section => [section.categoryId, section.visibleFields]))

export const surfaceConfigKey = (
  railConfig: SurfaceObjectRailRegionConfig | null,
): string =>
  JSON.stringify((railConfig?.sections ?? []).map(section => ({
    categoryId: section.categoryId,
    visible: section.visible,
    collapsed: section.collapsed,
    visibleFields: section.visibleFields,
  })))
