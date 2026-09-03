import { type GeoJSONSource, type Map as MapLibreMap, type MapMouseEvent } from 'maplibre-gl'
import type { PackMapFeature } from '../../core/packs/protocol.ts'

const sourceId = 'leitbild-pack-features'
const layerIds = ['leitbild-pack-fills', 'leitbild-pack-lines', 'leitbild-pack-points']

/** One native map source for Pack geometry. Evidence remains a Pack record, not a fake operational object. */
export const createPackFeatureLayer = (onSelect: (selection: NonNullable<PackMapFeature['selection']>) => void) => {
  let map: MapLibreMap | null = null
  let byId = new Map<string, PackMapFeature>()
  const click = (event: MapMouseEvent) => {
    if (!map) return
    const selection = map.queryRenderedFeatures(event.point, { layers: layerIds.filter(id => map!.getLayer(id)) }).map(feature => byId.get(String(feature.properties.id))?.selection).find(Boolean)
    if (selection) onSelect(selection)
  }
  const attach = (next: MapLibreMap) => {
    if (map === next) return
    map?.off('click', click)
    map = next; map.on('click', click)
  }
  return {
    update(next: MapLibreMap, features: ReadonlyArray<PackMapFeature>, visibleLayers: ReadonlySet<string>) {
      attach(next)
      const visible = features.filter(feature => visibleLayers.has(feature.layerId ?? 'objects')).sort((a,b) => (a.sortKey ?? 0) - (b.sortKey ?? 0))
      byId = new Map(visible.map(feature => [feature.id, feature]))
      const data = JSON.parse(JSON.stringify({ type: 'FeatureCollection', features: visible.map(feature => ({ type: 'Feature', geometry: feature.geometry, properties: { id: feature.id, color: feature.color, opacity: feature.opacity ?? .1, lineColor: feature.lineColor ?? feature.color, lineOpacity: feature.lineOpacity ?? .5, lineWidth: feature.lineWidth ?? 1 } })) })) as Parameters<GeoJSONSource['setData']>[0]
      const source = next.getSource(sourceId) as GeoJSONSource | undefined
      if (source) { source.setData(data); return }
      next.addSource(sourceId, { type: 'geojson', data })
      next.addLayer({ id: layerIds[0]!, type: 'fill', source: sourceId, filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': ['get','color'], 'fill-opacity': ['get','opacity'] } })
      next.addLayer({ id: layerIds[1]!, type: 'line', source: sourceId, filter: ['!=', ['geometry-type'], 'Point'], paint: { 'line-color': ['get','lineColor'], 'line-width': ['get','lineWidth'], 'line-opacity': ['get','lineOpacity'] } })
      next.addLayer({ id: layerIds[2]!, type: 'circle', source: sourceId, filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 6, 'circle-color': ['get','color'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1, 'circle-opacity': .85 } })
    },
    destroy() { map?.off('click', click); map = null; byId.clear() },
  }
}
