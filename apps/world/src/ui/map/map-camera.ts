import type { Map as MapLibreMap } from 'maplibre-gl'

interface CameraInteractionHandler {
  readonly enable: () => void
  readonly isEnabled: () => boolean
}

const cameraInteractionHandlers = (current: MapLibreMap): ReadonlyArray<{
  readonly name: string
  readonly handler: CameraInteractionHandler
}> => [
  { name: 'dragPan', handler: current.dragPan },
  { name: 'scrollZoom', handler: current.scrollZoom },
  { name: 'boxZoom', handler: current.boxZoom },
  { name: 'doubleClickZoom', handler: current.doubleClickZoom },
  { name: 'touchZoomRotate', handler: current.touchZoomRotate },
  { name: 'keyboard', handler: current.keyboard },
]

export const cameraInteractionDebug = (current: MapLibreMap | null): string => {
  if (!current) return 'handlers=no-map'
  return cameraInteractionHandlers(current)
    .map(({ name, handler }) => `${name}:${handler.isEnabled() ? 'on' : 'off'}`)
    .join(' ')
}

export const assertCameraInteractionContract = (current: MapLibreMap): void => {
  if (current.cooperativeGestures.isEnabled()) current.cooperativeGestures.disable()
  for (const { handler } of cameraInteractionHandlers(current)) {
    if (!handler.isEnabled()) handler.enable()
  }
  const disabled = cameraInteractionHandlers(current)
    .filter(({ handler }) => !handler.isEnabled())
    .map(({ name }) => name)
  if (disabled.length > 0) {
    throw new Error(`Map camera interactions disabled: ${disabled.join(', ')}`)
  }
}
