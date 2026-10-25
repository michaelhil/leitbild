import { MercatorCoordinate, type Map as MapLibreMap } from 'maplibre-gl'
import { createPhysicalSceneLayer } from './layer.ts'
import { physicalSceneLayerId } from './order.ts'
import type { PhysicalViewport, PhysicalViewportEvent, PhysicalViewportRenderer } from './viewport.ts'

/** Real MapLibre camera/custom-layer adapter. Canvas mode implements this port independently. */
export const createMapPhysicalViewport = (map: MapLibreMap, beforeId: () => string | undefined): PhysicalViewport => {
  const canvas = map.getCanvas(), cleanups = new Set<() => void>()
  let revision = 0, activePointer: { id: number; x: number; y: number } | null = null, tool: 'pan' | 'orbit' = 'pan'
  const revisionChanged = (): void => { revision++ }; map.on('move', revisionChanged)
  const subscribe = (event: PhysicalViewportEvent, listener: () => void): (() => void) => {
    const names = event === 'change' ? ['move'] : event === 'style' ? ['style.load', 'styledata'] : [event]
    const dom = event === 'contextlost' || event === 'contextrestored'
    if (dom) canvas.addEventListener(event === 'contextlost' ? 'webglcontextlost' : 'webglcontextrestored', listener)
    else for (const name of names) map.on(name as 'move', listener)
    const cleanup = (): void => { if (dom) canvas.removeEventListener(event === 'contextlost' ? 'webglcontextlost' : 'webglcontextrestored', listener); else for (const name of names) map.off(name as 'move', listener); cleanups.delete(cleanup) }
    cleanups.add(cleanup); return cleanup
  }
  const pointerDown = (event: PointerEvent): void => { if (tool !== 'orbit' || event.button !== 0) return; event.preventDefault(); activePointer = { id: event.pointerId, x: event.clientX, y: event.clientY }; canvas.setPointerCapture(event.pointerId) }
  const pointerMove = (event: PointerEvent): void => {
    if (!activePointer || activePointer.id !== event.pointerId) return
    const size = canvas.getBoundingClientRect(), dx = event.clientX - activePointer.x, dy = event.clientY - activePointer.y
    activePointer = { id: event.pointerId, x: event.clientX, y: event.clientY }
    map.jumpTo({ bearing: map.getBearing() - dx / size.width * 360, pitch: Math.max(0, Math.min(map.getMaxPitch(), map.getPitch() + dy / size.height * 180)) })
  }
  const releasePointer = (): void => { if (activePointer && canvas.hasPointerCapture(activePointer.id)) canvas.releasePointerCapture(activePointer.id); activePointer = null }
  canvas.addEventListener('pointerdown', pointerDown); canvas.addEventListener('pointermove', pointerMove); canvas.addEventListener('pointerup', releasePointer); canvas.addEventListener('pointercancel', releasePointer)
  let installed: ReturnType<typeof createPhysicalSceneLayer> | null = null
  const port: PhysicalViewport = {
    surface: { kind: 'map', element: canvas, getSize: () => { const r = canvas.getBoundingClientRect(); return { width: r.width, height: r.height } }, getPadding: () => { const p = map.getPadding(); return { top: p.top ?? 0, right: p.right ?? 0, bottom: p.bottom ?? 0, left: p.left ?? 0 } }, on: (event, listener) => subscribe(event === 'move' ? 'change' : event, listener) },
    on: subscribe, ready: () => Boolean(map.isStyleLoaded()), projectGeographic: point => map.project(point), requestRender: () => map.triggerRepaint(),
    installRenderer(entries, palette, reportError) { if (map.getLayer(physicalSceneLayerId)) map.removeLayer(physicalSceneLayerId); installed = createPhysicalSceneLayer(physicalSceneLayerId, entries, palette, reportError); const before = beforeId(); map.addLayer(installed.layer, before && map.getLayer(before) ? before : undefined); return installed },
    registered: renderer => renderer === installed && Boolean(map.getLayer(physicalSceneLayerId)),
    orderRenderer() { const before = beforeId(); if (before && map.getLayer(before) && map.getLayer(physicalSceneLayerId)) { const order = map.getLayersOrder(); if (order.indexOf(physicalSceneLayerId) > order.indexOf(before)) map.moveLayer(physicalSceneLayerId, before) } },
    removeRenderer(renderer) { const lost = installed?.context()?.isContextLost(); renderer.dispose(); if (renderer === installed) { if (!lost && map.getLayer(physicalSceneLayerId)) map.removeLayer(physicalSceneLayerId); installed = null } },
    cameraPose() { const center = map.getCenter(); return { center: [center.lng, center.lat], pitch: map.getPitch(), bearing: map.getBearing(), zoom: map.getZoom(), revision } },
    setPose(patch) { map.stop(); const { center, ...rest } = patch; map.jumpTo({ ...rest, ...(center ? { center: [center[0], center[1]] as [number, number] } : {}) }) },
    fitWorld(bounds, options) {
      const center = bounds.min.map((value, axis) => (value + bounds.max[axis]!) / 2), target = new MercatorCoordinate(center[0]!, center[1]!, center[2]!), geographic = target.toLngLat(), scale = MercatorCoordinate.fromLngLat(geographic).meterInMercatorCoordinateUnits()
      const bearing = options.preservePose ? map.getBearing() : options.bearing, pitch = options.mode === '2d' ? 0 : options.preservePose ? map.getPitch() : 50
      if (options.mode === '2d') {
        const west = new MercatorCoordinate(bounds.min[0], bounds.max[1]).toLngLat(), east = new MercatorCoordinate(bounds.max[0], bounds.min[1]).toLngLat()
        map.fitBounds([[west.lng, west.lat], [east.lng, east.lat]], { padding: options.padding, bearing, pitch, duration: 0 }); return
      }
      const size = canvas.getBoundingClientRect(), available = Math.min(size.width - options.padding.left - options.padding.right, size.height - options.padding.top - options.padding.bottom), radius = Math.hypot(...bounds.max.map((value, axis) => (value - bounds.min[axis]!) / 2)) / scale
      if (!(radius > 0) || !(available > 0)) throw new Error('A physical focus requires nonempty bounds and visible viewport space')
      const angle = Math.atan(Math.tan(map.getVerticalFieldOfView() * Math.PI / 360) * available / size.height), distance = radius / Math.sin(angle), p = pitch * Math.PI / 180, b = bearing * Math.PI / 180
      const eye = new MercatorCoordinate(target.x - distance * Math.sin(p) * Math.sin(b) * scale, target.y + distance * Math.sin(p) * Math.cos(b) * scale).toLngLat()
      const camera = map.calculateCameraOptionsFromTo(eye, target.z / scale + distance * Math.cos(p), geographic, target.z / scale)
      const inherited = map.getPadding(), offset: [number, number] = [(options.padding.left - options.padding.right - (inherited.left ?? 0) + (inherited.right ?? 0)) / 2, (options.padding.top - options.padding.bottom - (inherited.top ?? 0) + (inherited.bottom ?? 0)) / 2]
      map.easeTo({ ...camera, bearing, pitch, offset, duration: 0 })
    },
    panBy: (x, y) => map.panBy([x, y], { duration: 0 }),
    setNavigationTool(value) { releasePointer(); tool = value; if (tool === 'orbit') map.dragPan.disable(); else map.dragPan.enable() },
    cancelCamera() { map.stop(); releasePointer() },
    destroy() { for (const cleanup of [...cleanups]) cleanup(); map.off('move', revisionChanged); releasePointer(); map.dragPan.enable(); canvas.removeEventListener('pointerdown', pointerDown); canvas.removeEventListener('pointermove', pointerMove); canvas.removeEventListener('pointerup', releasePointer); canvas.removeEventListener('pointercancel', releasePointer) },
  }
  return port
}
