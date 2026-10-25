import { MercatorCoordinate, type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl'
import { physicalOverviewFootprintSchema } from '../../../core/packs/scene.ts'
import { localMercatorMatrix, transform } from './math.ts'
import { physicalSceneLayerId, physicalSceneOverviewLayerId, physicalSceneOverviewSourceId } from './order.ts'
import type { PhysicalScenePalette, PhysicalScenePresentation } from './types.ts'

interface OverviewProperties { sceneId: string; objectId: string; label: string; base: number; height: number }
export type PhysicalOverviewData = GeoJSON.FeatureCollection<GeoJSON.Polygon, OverviewProperties>

/** Coarse authored buildings require neither source compilation nor a live query. */
export const physicalOverviewFeatures = (scenes: ReadonlyArray<PhysicalScenePresentation>): PhysicalOverviewData => ({
  type: 'FeatureCollection',
  features: scenes.flatMap(scene => {
    if (!scene.descriptor.locationValid || scene.status === 'ready' || scene.status === 'unavailable') return []
    const matrix = localMercatorMatrix(scene.descriptor.anchor, scene.descriptor.bearing)
    const footprints = scene.descriptor.overviewFootprints ?? []
    if (footprints.length > 1024 || new Set(footprints.map(footprint => footprint.id)).size !== footprints.length) throw new Error('Invalid physical overview footprint identity/budget')
    return footprints.map(value => {
      const footprint = physicalOverviewFootprintSchema.parse(value)
      const ring = footprint.ring.map(([x, y]) => {
        const point = transform(matrix, [x, y, 0])
        const geographic = new MercatorCoordinate(point[0], point[1]).toLngLat()
        return [geographic.lng, geographic.lat]
      })
      return { type: 'Feature' as const, id: `${scene.descriptor.id}/${footprint.id}`, geometry: { type: 'Polygon' as const, coordinates: [ring] },
        properties: { sceneId: scene.descriptor.id, objectId: scene.descriptor.targetObjectId, label: footprint.label, base: footprint.base, height: footprint.base + footprint.height } }
    })
  }),
})

/** Own one bounded native source/layer across style changes; detailed geometry replaces it. */
export const createPhysicalSceneOverview = (options: {
  readonly map: MapLibreMap
  readonly beforeId: () => string | undefined
  readonly palette: PhysicalScenePalette
  readonly reportError: (error: Error) => void
}) => {
  const { map } = options
  let data: PhysicalOverviewData = { type: 'FeatureCollection', features: [] }
  let signature = ''
  let published = ''
  let palette = options.palette
  let destroyed = false
  let queued = false
  const color = (): string => `rgb(${(palette.materials.wall ?? palette.defaultMaterial).map(channel => Math.round(channel * 255)).join(' ')})`
  const reconcile = (): void => {
    if (destroyed || !map.isStyleLoaded()) return
    try {
      if (!data.features.length) {
        if (map.getLayer(physicalSceneOverviewLayerId)) map.removeLayer(physicalSceneOverviewLayerId)
        if (map.getSource(physicalSceneOverviewSourceId)) map.removeSource(physicalSceneOverviewSourceId)
        published = ''
        return
      }
      let source = map.getSource(physicalSceneOverviewSourceId) as GeoJSONSource | undefined
      if (!source) {
        map.addSource(physicalSceneOverviewSourceId, { type: 'geojson', data })
        source = map.getSource(physicalSceneOverviewSourceId) as GeoJSONSource
        published = signature
      } else if (published !== signature) { source.setData(data); published = signature }
      const anchor = map.getLayer(physicalSceneLayerId) ? physicalSceneLayerId : options.beforeId()
      if (!map.getLayer(physicalSceneOverviewLayerId)) map.addLayer({
        id: physicalSceneOverviewLayerId, type: 'fill-extrusion', source: physicalSceneOverviewSourceId, minzoom: 11,
        paint: { 'fill-extrusion-color': color(), 'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-height': ['get', 'height'], 'fill-extrusion-opacity': 0.85 },
      }, anchor && map.getLayer(anchor) ? anchor : undefined)
      else {
        map.setPaintProperty(physicalSceneOverviewLayerId, 'fill-extrusion-color', color())
        const order = map.getLayersOrder()
        if (anchor && order.indexOf(physicalSceneOverviewLayerId) > order.indexOf(anchor)) map.moveLayer(physicalSceneOverviewLayerId, anchor)
      }
    } catch (error) { options.reportError(error instanceof Error ? error : new Error(String(error))) }
  }
  const onStyle = (): void => {
    if (destroyed || queued) return
    queued = true
    queueMicrotask(() => { queued = false; reconcile() })
  }
  map.on('style.load', onStyle)
  return {
    update(scenes: ReadonlyArray<PhysicalScenePresentation>): void {
      if (destroyed) return
      data = physicalOverviewFeatures(scenes)
      signature = JSON.stringify(data)
      reconcile()
    },
    setPalette(next: PhysicalScenePalette): void { palette = next; reconcile() },
    sceneAt(point: { readonly x: number; readonly y: number }): string | null {
      if (!map.getLayer(physicalSceneOverviewLayerId)) return null
      const value = map.queryRenderedFeatures([point.x, point.y], { layers: [physicalSceneOverviewLayerId] })[0]?.properties?.sceneId
      return typeof value === 'string' ? value : null
    },
    destroy(): void {
      if (destroyed) return
      destroyed = true
      map.off('style.load', onStyle)
      if (map.getLayer(physicalSceneOverviewLayerId)) map.removeLayer(physicalSceneOverviewLayerId)
      if (map.getSource(physicalSceneOverviewSourceId)) map.removeSource(physicalSceneOverviewSourceId)
    },
  }
}
