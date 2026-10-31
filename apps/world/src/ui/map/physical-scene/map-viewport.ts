import { fitPhysicalPerspective } from './perspective-fit.ts'
import { MercatorCoordinate, type Map as MapLibreMap, type MapMouseEvent } from 'maplibre-gl'
import type { PhysicalSceneBounds } from '../../../core/packs/scene.ts'
import { physicalHeightFootprint, overlapsPhysicalFootprint } from './visibility.ts'
import type { Vector3 } from './math.ts'
import { createPhysicalSceneLayer } from './layer.ts'
import { physicalSceneLayerId } from './order.ts'
import type { PhysicalViewport, PhysicalViewportEvent, PhysicalViewportRenderer } from './viewport.ts'
import type { PhysicalViewportFitOptions } from './types.ts'

/** Real MapLibre camera/custom-layer adapter. Canvas mode implements this port independently. */
export const createMapPhysicalViewport = (map: MapLibreMap, beforeId: () => string | undefined, suspendPickingForNavigation?: () => (() => void)): PhysicalViewport => {
  const canvas = map.getCanvas(), cleanups = new Set<() => void>()
  let pickingRelease: (() => void) | null = null
  const releasePicking = (): void => { const release = pickingRelease; pickingRelease = null; release?.() }
  let revision = 0, activePointer: { id: number; x: number; y: number; startX: number; startY: number; dragged: boolean } | null = null, cancelledPointer: number | null = null, tool: 'pan' | 'orbit' = 'pan'
  const revisionChanged = (): void => { revision++ }; map.on('move', revisionChanged); map.on('resize', revisionChanged)
  let active = true, elevatedInspection = false, priorClamp: boolean | null = null
  type PausedPose = { center: readonly [number, number]; bearing: number; pitch: number; zoom: number; elevation: number }
  let pausedPose: PausedPose | null = null
  let planarInspection = false, priorPitch: { min: number; max: number } | null = null
  const releasePlanar = (): void => {
    const prior = priorPitch; if (!prior) return
    priorPitch = null
    // Restore only bounds still owned by this lease. An operational camera
    // that deliberately replaced a bound retains its newer valid interval.
    if (map.getMaxPitch() === 0) map.setMaxPitch(prior.max)
    if (map.getMinPitch() === 0 && prior.min <= map.getMaxPitch()) map.setMinPitch(prior.min)
  }
  const syncPlanar = (): void => {
    if (!active || !planarInspection) { releasePlanar(); return }
    if (priorPitch !== null) return
    priorPitch = { min: map.getMinPitch(), max: map.getMaxPitch() }
    map.setMinPitch(0); map.setMaxPitch(0)
    if (map.getPitch() !== 0) map.jumpTo({ pitch: 0 })
  }
  const currentPose = (): PausedPose => { const point = map.getCenter(); return { center: [point.lng, point.lat], bearing: map.getBearing(), pitch: map.getPitch(), zoom: map.getZoom(), elevation: map.getCenterElevation() } }
  const acquireElevation = (): void => { if (!active || !elevatedInspection) return; if (priorClamp === null) priorClamp = map.getCenterClampedToGround(); map.setCenterClampedToGround(false) }
  const releaseElevation = (): void => { if (priorClamp === null) return; if (!map.getCenterClampedToGround()) map.setCenterClampedToGround(priorClamp); priorClamp = null }
  const leaveElevation = (): void => { elevatedInspection = false; pausedPose = null; releaseElevation() }
  let visibility: { revision: number; ground: PhysicalSceneBounds; eye?: Vector3 } | null = null
  const footprint = () => {
    if (visibility?.revision === revision) return visibility
    const bounds = map.getBounds(), west = MercatorCoordinate.fromLngLat([bounds.getWest(), bounds.getNorth()]), east = MercatorCoordinate.fromLngLat([bounds.getEast(), bounds.getSouth()])
    visibility = { revision, ground: { min: [west.x, west.y, 0], max: [east.x, east.y, 0] } }; return visibility
  }
  const subscribe = (event: PhysicalViewportEvent, listener: () => void): (() => void) => {
    const names = event === 'change' ? ['move'] : event === 'style' ? ['style.load', 'styledata'] : [event]
    const dom = event === 'contextlost' || event === 'contextrestored'
    if (dom) canvas.addEventListener(event === 'contextlost' ? 'webglcontextlost' : 'webglcontextrestored', listener)
    else for (const name of names) map.on(name as 'move', listener)
    const cleanup = (): void => { if (dom) canvas.removeEventListener(event === 'contextlost' ? 'webglcontextlost' : 'webglcontextrestored', listener); else for (const name of names) map.off(name as 'move', listener); cleanups.delete(cleanup) }
    cleanups.add(cleanup); return cleanup
  }
  // A custom Orbit owns its primary mouse gesture through activation, not just
  // camera deltas. Four CSS pixels is click slop, matching the explorer's
  // activation gesture; it is unrelated to scene/annotation admission.
  const dragSlop = 4
  const endTarget = canvas.ownerDocument?.defaultView ?? canvas
  let suppressClickPointer: number | null = null, clickTurn: ReturnType<typeof setTimeout> | null = null
  const clearClickGuard = (): void => { if (clickTurn !== null) clearTimeout(clickTurn); clickTurn = null; suppressClickPointer = null }
  const guardCompletedDrag = (id: number): void => {
    clearClickGuard(); suppressClickPointer = id
    // MapLibre's native drag handlers use the same event-turn boundary. A
    // pointer release can produce click/dblclick after pointerup listeners.
    clickTurn = setTimeout(clearClickGuard, 0)
  }
  const click = (event: MouseEvent): void => {
    if (suppressClickPointer === null || event.detail === 0) return
    if ('pointerId' in event && typeof event.pointerId === 'number' && event.pointerId > 0 && event.pointerId !== suppressClickPointer) return
    event.preventDefault(); event.stopImmediatePropagation()
  }
  const releasePointer = (): void => {
    const owned = activePointer; activePointer = null
    releasePicking()
    if (owned) { cancelledPointer = owned.id; if (canvas.hasPointerCapture(owned.id)) canvas.releasePointerCapture(owned.id) }
  }
  const pointerDown = (event: PointerEvent): void => {
    clearClickGuard(); cancelledPointer = null
    if (!active || tool !== 'orbit' || event.button !== 0 || event.defaultPrevented || event.pointerType === 'touch' || activePointer) return
    activePointer = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, dragged: false }
    canvas.setPointerCapture(event.pointerId)
    // Do not cancel pointerdown: compatibility mousedown must reach MapLibre
    // so its ordinary click records the current press position.
  }
  const mouseDown = (event: MapMouseEvent): void => {
    if (tool === 'orbit' && activePointer && event.originalEvent.button === 0 && !event.defaultPrevented) event.preventDefault()
  }
  const pointerMove = (event: PointerEvent): void => {
    const owned = activePointer
    if (!owned || owned.id !== event.pointerId || event.defaultPrevented) return
    if (!owned.dragged && Math.hypot(event.clientX - owned.startX, event.clientY - owned.startY) < dragSlop) return
    if (!owned.dragged) { owned.dragged = true; pickingRelease = suspendPickingForNavigation?.() ?? null }
    event.preventDefault()
    const size = canvas.getBoundingClientRect(), dx = event.clientX - owned.x, dy = event.clientY - owned.y
    owned.x = event.clientX; owned.y = event.clientY
    map.jumpTo({ bearing: map.getBearing() - dx / size.width * 360, pitch: Math.max(0, Math.min(map.getMaxPitch(), map.getPitch() + dy / size.height * 180)) }, { originalEvent: event })
  }
  const pointerEnd = (event: PointerEvent): void => {
    const owned = activePointer
    if (owned?.id === event.pointerId) {
      const consumed = owned.dragged || event.type === 'pointercancel'
      activePointer = null; releasePicking(); if (canvas.hasPointerCapture(owned.id)) canvas.releasePointerCapture(owned.id)
      if (consumed) guardCompletedDrag(owned.id)
    } else if (cancelledPointer === event.pointerId) guardCompletedDrag(event.pointerId)
    if (cancelledPointer === event.pointerId) cancelledPointer = null
  }
  const pointerLost = (event: PointerEvent): void => { if (activePointer?.id === event.pointerId) releasePointer() }
  const resetGesture = (): void => releasePointer()
  const visibilityChanged = (): void => { if (canvas.ownerDocument?.visibilityState === 'hidden') releasePointer() }
  map.on('mousedown', mouseDown)
  map.on('style.load', resetGesture)
  canvas.addEventListener('pointerdown', pointerDown); canvas.addEventListener('pointermove', pointerMove); canvas.addEventListener('lostpointercapture', pointerLost)
  canvas.addEventListener('webglcontextlost', resetGesture)
  endTarget.addEventListener('pointerup', pointerEnd as EventListener, true); endTarget.addEventListener('pointercancel', pointerEnd as EventListener, true)
  endTarget.addEventListener('blur', resetGesture)
  canvas.ownerDocument?.addEventListener('visibilitychange', visibilityChanged)
  canvas.addEventListener('click', click, true); canvas.addEventListener('dblclick', click, true)
  const fitPose = (options: PhysicalViewportFitOptions) => ({
    bearing: options.preservePose ? map.getBearing() : options.bearing,
    pitch: options.mode === '2d' ? 0 : Math.max(map.getMinPitch(), Math.min(options.preservePose ? map.getPitch() : options.pitch ?? 50, map.getMaxPitch())),
  })
  const geographicBounds = (bounds: PhysicalSceneBounds): [[number, number], [number, number]] => {
    const west = new MercatorCoordinate(bounds.min[0], bounds.max[1]).toLngLat(), east = new MercatorCoordinate(bounds.max[0], bounds.min[1]).toLngLat()
    return [[west.lng, west.lat], [east.lng, east.lat]]
  }
  const perspectiveFit = (bounds: PhysicalSceneBounds, options: PhysicalViewportFitOptions) => {
    const { bearing, pitch } = fitPose(options), size = canvas.getBoundingClientRect(), inherited = map.getPadding()
    const fit = fitPhysicalPerspective({ bounds, ...(options.target ? { target: options.target } : {}), width: size.width, height: size.height, padding: options.padding, verticalFieldOfView: map.getVerticalFieldOfView() * Math.PI / 180, bearing, pitch, projectionOffset: { x: ((inherited.left ?? 0) - (inherited.right ?? 0)) / size.width, y: ((inherited.bottom ?? 0) - (inherited.top ?? 0)) / size.height }, nearRatio: map.transform.nearZ / map.transform.cameraToCenterDistance })
    return { fit, bearing, pitch }
  }
  let installed: ReturnType<typeof createPhysicalSceneLayer> | null = null
  const port: PhysicalViewport = {
    surface: { kind: 'map', element: canvas, getSize: () => { const r = canvas.getBoundingClientRect(); return { width: r.width, height: r.height } }, getPadding: () => { const p = map.getPadding(); return { top: p.top ?? 0, right: p.right ?? 0, bottom: p.bottom ?? 0, left: p.left ?? 0 } }, on: (event, listener) => subscribe(event === 'move' ? 'change' : event, listener) },
    intersectsBounds(bounds, mode) {
      const frame = footprint()
      // A visible horizon has no finite ground footprint that proves exclusion.
      if (map.getPitch() + map.getVerticalFieldOfView() / 2 >= 90) return true
      if (mode === '2d') return overlapsPhysicalFootprint(bounds, frame.ground)
      if (!frame.eye) {
        const center = map.getCenter(), elevation = map.getCenterElevation(), target = MercatorCoordinate.fromLngLat(center, elevation)
        // Calibrate distance with the installed public camera API, avoiding
        // private transforms and assumptions about tile size, FOV or padding.
        const reference = map.calculateCameraOptionsFromTo(center, elevation + 1, center, elevation), distance = target.meterInMercatorCoordinateUnits() * Math.pow(2, reference.zoom! - map.getZoom()), p = map.getPitch() * Math.PI / 180, b = map.getBearing() * Math.PI / 180
        frame.eye = [target.x - distance * Math.sin(p) * Math.sin(b), target.y + distance * Math.sin(p) * Math.cos(b), target.z + distance * Math.cos(p)]
      }
      return overlapsPhysicalFootprint(bounds, physicalHeightFootprint(frame.ground, frame.eye, bounds.min[2], bounds.max[2]))
    },
    on: subscribe, ready: () => Boolean(map.isStyleLoaded()), projectGeographic: point => map.project(point), requestRender: () => map.triggerRepaint(),
    installRenderer(entries, palette, reportError, planFontFamily) { if (map.getLayer(physicalSceneLayerId)) map.removeLayer(physicalSceneLayerId); installed = createPhysicalSceneLayer(physicalSceneLayerId, entries, palette, reportError, planFontFamily); const before = beforeId(); map.addLayer(installed.layer, before && map.getLayer(before) ? before : undefined); return installed },
    registered: renderer => renderer === installed && Boolean(map.getLayer(physicalSceneLayerId)),
    orderRenderer() { const before = beforeId(); if (before && map.getLayer(before) && map.getLayer(physicalSceneLayerId)) { const order = map.getLayersOrder(); if (order.indexOf(physicalSceneLayerId) > order.indexOf(before)) map.moveLayer(physicalSceneLayerId, before) } },
    removeRenderer(renderer) { const lost = installed?.context()?.isContextLost(); renderer.dispose(); if (renderer === installed) { if (!lost && map.getLayer(physicalSceneLayerId)) map.removeLayer(physicalSceneLayerId); installed = null } },
    cameraPose() { const center = map.getCenter(); return { center: [center.lng, center.lat], pitch: map.getPitch(), bearing: map.getBearing(), zoom: map.getZoom(), revision, elevation: map.getCenterElevation() } },
    setPose(patch) {
      if (patch.pitch === 0 && patch.elevation === 0) leaveElevation()
      else if (patch.elevation !== undefined) { elevatedInspection = true; acquireElevation() }
      map.stop(); const { center, ...rest } = patch; map.jumpTo({ ...rest, ...(center ? { center: [center[0], center[1]] as [number, number] } : {}) })
      if (!active && elevatedInspection && patch.elevation !== undefined) pausedPose = { ...currentPose(), elevation: patch.elevation }
    },
    setActive(value) {
      if (active === value) return
      if (!value) { releasePointer(); if (elevatedInspection) pausedPose = currentPose(); active = false; releaseElevation(); syncPlanar(); return }
      active = true; acquireElevation(); syncPlanar()
      if (pausedPose) { const now = currentPose(); if (now.bearing === pausedPose.bearing && now.pitch === pausedPose.pitch && now.zoom === pausedPose.zoom && now.center[0] === pausedPose.center[0] && now.center[1] === pausedPose.center[1]) map.setCenterElevation(pausedPose.elevation); pausedPose = null }
    },
    setPlanarInspection(value) { planarInspection = value; syncPlanar() },
    measureFit(bounds, options) {
      if (options.mode === '2d') {
        const camera = map.cameraForBounds(geographicBounds(bounds), { padding: options.padding, bearing: fitPose(options).bearing })
        if (camera?.zoom === undefined || !Number.isFinite(camera.zoom)) throw new Error('The native map cannot fit this architectural Plan')
        return camera.zoom
      }
      return -perspectiveFit(bounds, options).fit.distance
    },
    fitWorld(bounds, options) {
      // Fit the camera the public host can actually apply. Authored poses remain
      // host-independent; native pitch constraints must precede the solve.
      if (options.mode === '2d') {
        const { bearing, pitch } = fitPose(options)
        leaveElevation()
        if (map.getCenterElevation() !== 0) map.jumpTo({ elevation: 0 })
        map.fitBounds(geographicBounds(bounds), { padding: options.padding, bearing, pitch, duration: 0 }); return
      }
      elevatedInspection = true; acquireElevation()
      // Read the pinned host's public typed projection quantities. Native near
      // clipping is part of fitting, not a guessed ratio or a depth workaround.
      const { fit, bearing, pitch } = perspectiveFit(bounds, options)
      const optical = new MercatorCoordinate(...fit.target), eye = new MercatorCoordinate(...fit.eye), destination = optical.toLngLat(), from = eye.toLngLat()
      const destinationScale = MercatorCoordinate.fromLngLat(destination).meterInMercatorCoordinateUnits(), eyeScale = MercatorCoordinate.fromLngLat(from).meterInMercatorCoordinateUnits()
      const camera = map.calculateCameraOptionsFromTo(from, eye.z / eyeScale, destination, optical.z / destinationScale)
      map.stop(); map.jumpTo({ ...camera, bearing, pitch })
      if (!active) pausedPose = { ...currentPose(), elevation: camera.elevation! }
    },
    panBy: (x, y) => map.panBy([x, y], { duration: 0 }),
    setNavigationTool(value) { releasePointer(); tool = value; /* Native camera handlers retain their global contract; mousedown claims this gesture. */ },
    cancelCamera() { map.stop(); releasePointer() },
    destroy() { releasePlanar(); leaveElevation(); for (const cleanup of [...cleanups]) cleanup(); map.off('move', revisionChanged); map.off('resize', revisionChanged); releasePointer(); clearClickGuard(); cancelledPointer = null; map.off('mousedown', mouseDown); map.off('style.load', resetGesture); canvas.removeEventListener('pointerdown', pointerDown); canvas.removeEventListener('pointermove', pointerMove); canvas.removeEventListener('lostpointercapture', pointerLost); canvas.removeEventListener('webglcontextlost', resetGesture); endTarget.removeEventListener('pointerup', pointerEnd as EventListener, true); endTarget.removeEventListener('pointercancel', pointerEnd as EventListener, true); endTarget.removeEventListener('blur', resetGesture); canvas.ownerDocument?.removeEventListener('visibilitychange', visibilityChanged); canvas.removeEventListener('click', click, true); canvas.removeEventListener('dblclick', click, true) },
  }
  return port
}
