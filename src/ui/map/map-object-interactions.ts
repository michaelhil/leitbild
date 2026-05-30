import type { Map as MapLibreMap, MapLayerMouseEvent } from 'maplibre-gl'
import type { OperationalObject } from '../../core/model/index.ts'

export const objectFromMapEvent = (
  event: MapLayerMouseEvent,
  objects: ReadonlyArray<OperationalObject>,
): OperationalObject | null => {
  const objectId = String(event.features?.[0]?.properties?.id ?? '')
  return objects.find(candidate => candidate.id === objectId) ?? null
}

export const addObjectInteractions = (config: {
  readonly map: MapLibreMap
  readonly layerIds: ReadonlyArray<string>
  readonly objects: () => ReadonlyArray<OperationalObject>
  readonly placementCursorActive: () => boolean
  readonly placementCursorCss: () => string
  readonly refreshCanvasCursor: () => void
  readonly onObjectSelected: (object: OperationalObject) => void
  readonly onObjectSeen: (object: OperationalObject) => void
  readonly onRenderRevision: () => void
  readonly showPopup: (object: OperationalObject) => void
  readonly hidePopup: () => void
}): void => {
  for (const layerId of config.layerIds) {
    config.map.on('click', layerId, (event) => {
      const object = objectFromMapEvent(event, config.objects())
      if (object) config.onObjectSelected(object)
    })
    config.map.on('mouseenter', layerId, (event) => {
      config.map.getCanvas().style.cursor = config.placementCursorActive() ? config.placementCursorCss() : 'pointer'
      const object = objectFromMapEvent(event, config.objects())
      if (!object) return
      config.onObjectSeen(object)
      config.onRenderRevision()
      config.showPopup(object)
    })
    config.map.on('mouseleave', layerId, () => {
      config.refreshCanvasCursor()
      config.hidePopup()
    })
  }
}
