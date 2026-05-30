import type { OperationalObject } from '../../core/model/index.ts'
import type { PackObjectPresentation } from '../../core/packs/protocol.ts'
import type { MapSourceDirty } from './map-source-controller.ts'

export interface MapSourceFamilySignatures {
  readonly weather: string
  readonly traffic: string
  readonly grid: string
}

const geometrySignatureFor = (object: OperationalObject): string =>
  object.spatial.geometry ? JSON.stringify(object.spatial.geometry) : 'none'

const visualSignatureFor = (presentation: PackObjectPresentation): string =>
  [
    presentation.categoryId,
    presentation.color,
    presentation.summary,
    presentation.status?.tone ?? 'none',
  ].join(':')

const gridVisualSignatureFor = (presentation: PackObjectPresentation): string =>
  [
    presentation.categoryId,
    presentation.color,
    presentation.status?.tone ?? 'none',
  ].join(':')

export const sourceFamilySignaturesFor = (
  objects: ReadonlyArray<OperationalObject>,
  presentationFor: (object: OperationalObject) => PackObjectPresentation,
): MapSourceFamilySignatures => {
  const byFamily: Record<keyof MapSourceFamilySignatures, string[]> = {
    weather: [],
    traffic: [],
    grid: [],
  }
  for (const object of objects) {
    const presentation = presentationFor(object)
    const geometrySignature = geometrySignatureFor(object)
    if (presentation.categoryId === 'weather') byFamily.weather.push(`${object.id}:${geometrySignature}:${visualSignatureFor(presentation)}`)
    if (presentation.categoryId === 'traffic') byFamily.traffic.push(`${object.id}:${geometrySignature}:${visualSignatureFor(presentation)}`)
    if (presentation.categoryId === 'grid-branches') byFamily.grid.push(`${object.id}:${geometrySignature}:${gridVisualSignatureFor(presentation)}`)
  }
  return {
    weather: byFamily.weather.join('|'),
    traffic: byFamily.traffic.join('|'),
    grid: byFamily.grid.join('|'),
  }
}

export const sourceFamilyDirtyFor = (
  previous: MapSourceFamilySignatures | null,
  next: MapSourceFamilySignatures,
): Pick<MapSourceDirty, 'weather' | 'traffic' | 'grid'> => ({
  weather: previous === null || previous.weather !== next.weather,
  traffic: previous === null || previous.traffic !== next.traffic,
  grid: previous === null || previous.grid !== next.grid,
})
