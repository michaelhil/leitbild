import { MercatorCoordinate } from 'maplibre-gl'
import { intersectsPhysicalFrustum } from './visibility.ts'
import { fitPhysicalPerspective } from './perspective-fit.ts'
import { boundsCorners, inverse, localMercatorMatrix, multiply, transform, type Vector3 } from './math.ts'
import { createPhysicalSceneRenderer } from './renderer.ts'
import type { PhysicalViewport, PhysicalViewportEvent, PhysicalViewportRenderer } from './viewport.ts'
import type { PhysicalScenePalette } from './types.ts'

const perspective = (angle: number, aspect: number, near: number, far: number): Float64Array => {
  const f = 1 / Math.tan(angle / 2), r = 1 / (near - far)
  return new Float64Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * r, -1, 0, 0, 2 * far * near * r, 0])
}
/** Dedicated real WebGL canvas and camera; it implements no pretend MapLibre methods. */
export const createCanvasPhysicalViewport = (canvas: HTMLCanvasElement): PhysicalViewport => {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false })
  if (!gl) throw new Error('The physical layout browser requires WebGL 2')
  const listeners = new Map<PhysicalViewportEvent, Set<() => void>>()
  let center: [number, number] = [0, 0], targetZ = 0, pitch = 0, bearing = 0, zoom = 0, revision = 0, queued: number | null = null, destroyed = false, lost = false
  let renderer: ReturnType<typeof createPhysicalSceneRenderer> | null = null, entries: Parameters<typeof createPhysicalSceneRenderer>[1] = () => [], palette: PhysicalScenePalette | null = null
  let tool: 'pan' | 'orbit' = 'pan'
  const pointers = new Map<number, { x: number; y: number; button: number }>(), oldTouchAction = canvas.style.touchAction
  canvas.style.touchAction = 'none'
  const size = () => { const box = canvas.getBoundingClientRect(); return { width: box.width, height: box.height } }
  const emit = (event: PhysicalViewportEvent): void => { for (const listener of listeners.get(event) ?? []) listener() }
  const subscribe: PhysicalViewport['on'] = (event, listener) => { const set = listeners.get(event) ?? new Set(); set.add(listener); listeners.set(event, set); return () => { set.delete(listener) } }
  // Zoom follows the common normalized Mercator 512-CSS-pixel world convention;
  // this is a camera coordinate unit, not a scene/object admission threshold.
  const worldUnitsPerPixel = () => Math.pow(2, -zoom) / 512
  const fov = Math.PI / 4
  const matrix = (): Float64Array => {
    const surface = size(), target = MercatorCoordinate.fromLngLat(center), worldHeight = surface.height * worldUnitsPerPixel(), distance = worldHeight / (2 * Math.tan(fov / 2)), b = bearing * Math.PI / 180, p = pitch * Math.PI / 180
    const right: Vector3 = [Math.cos(b), Math.sin(b), 0], up: Vector3 = [Math.sin(b) * Math.cos(p), -Math.cos(b) * Math.cos(p), Math.sin(p)], back: Vector3 = [-Math.sin(b) * Math.sin(p), Math.cos(b) * Math.sin(p), Math.cos(p)]
    const eye: Vector3 = [target.x + back[0] * distance, target.y + back[1] * distance, targetZ + back[2] * distance]
    const view = new Float64Array([right[0], up[0], back[0], 0, right[1], up[1], back[1], 0, right[2], up[2], back[2], 0,
      -(right[0] * eye[0] + right[1] * eye[1] + right[2] * eye[2]), -(up[0] * eye[0] + up[1] * eye[1] + up[2] * eye[2]), -(back[0] * eye[0] + back[1] * eye[1] + back[2] * eye[2]), 1])
    let far = distance + worldHeight
    for (const entry of entries()) {
      const placement = localMercatorMatrix(entry.scene.anchor, entry.scene.bearing)
      for (const point of boundsCorners(entry.scene.bounds)) { const world = transform(placement, point); far = Math.max(far, Math.hypot(world[0] - eye[0], world[1] - eye[1], world[2] - eye[2])) }
    }
    const near = Math.max(Number.EPSILON, Math.min(distance / 2, worldUnitsPerPixel()))
    return multiply(perspective(fov, Math.max(Number.EPSILON, surface.width / surface.height), near, far + worldHeight), view)
  }
  const requestRender = (): void => {
    if (destroyed || lost || queued !== null) return
    queued = requestAnimationFrame(() => {
      queued = null; const dimensions = size(), ratio = window.devicePixelRatio || 1, width = Math.round(dimensions.width * ratio), height = Math.round(dimensions.height * ratio)
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
      if (!width || !height) return
      gl.viewport(0, 0, width, height)
      const background = palette?.materials.background ?? palette?.materials.ground ?? palette?.materials.floor ?? palette?.defaultMaterial ?? [1, 1, 1]
      gl.clearColor(background[0]!, background[1]!, background[2]!, 1); gl.depthMask(true); gl.stencilMask(0xff); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT)
      renderer?.render(matrix()); emit('render'); emit('idle')
    })
  }
  const changed = (): void => { revision++; emit('change'); requestRender() }
  const groundPoint = (x: number, y: number): Vector3 | null => {
    const dimensions = size(), m = inverse(matrix()), a = transform(m, [x / dimensions.width * 2 - 1, 1 - y / dimensions.height * 2, -1]), b = transform(m, [x / dimensions.width * 2 - 1, 1 - y / dimensions.height * 2, 1]), dz = b[2] - a[2]
    if (Math.abs(dz) < Number.EPSILON) return null
    const t = (targetZ - a[2]) / dz
    if (!(t >= 0) || !Number.isFinite(t)) return null
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, targetZ]
  }
  const pan = (x: number, y: number): void => {
    const dimensions = size(), a = groundPoint(dimensions.width / 2, dimensions.height / 2), b = groundPoint(dimensions.width / 2 + x, dimensions.height / 2 + y)
    if (!a || !b) return
    const target = MercatorCoordinate.fromLngLat(center), next = new MercatorCoordinate(target.x + b[0] - a[0], target.y + b[1] - a[1]).toLngLat(); center = [next.lng, next.lat]; changed()
  }
  const releasePointers = (): void => { for (const id of pointers.keys()) if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id); pointers.clear() }
  const down = (event: PointerEvent): void => { if (event.button !== 0 && event.button !== 2) return; event.preventDefault(); pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, button: event.button }); canvas.setPointerCapture(event.pointerId); emit('movestart') }
  const move = (event: PointerEvent): void => {
    const prior = pointers.get(event.pointerId); if (!prior) return
    const before = [...pointers.values()]; pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, button: prior.button }); const after = [...pointers.values()], dimensions = size()
    if (before.length > 1 && after.length > 1) {
      const oldDistance = Math.hypot(before[1]!.x - before[0]!.x, before[1]!.y - before[0]!.y), newDistance = Math.hypot(after[1]!.x - after[0]!.x, after[1]!.y - after[0]!.y)
      if (oldDistance > 0 && newDistance > 0) zoom += Math.log2(newDistance / oldDistance)
      pan((before[0]!.x + before[1]!.x - after[0]!.x - after[1]!.x) / 2, (before[0]!.y + before[1]!.y - after[0]!.y - after[1]!.y) / 2)
    } else if (tool === 'orbit' || prior.button === 2 || event.ctrlKey) { bearing -= (event.clientX - prior.x) / dimensions.width * 360; pitch = Math.max(0, Math.min(85, pitch + (event.clientY - prior.y) / dimensions.height * 180)); changed() }
    else pan(prior.x - event.clientX, prior.y - event.clientY)
  }
  const up = (event: PointerEvent): void => { if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId); pointers.delete(event.pointerId) }
  const wheel = (event: WheelEvent): void => {
    event.preventDefault(); const box = canvas.getBoundingClientRect(), x = event.clientX - box.left, y = event.clientY - box.top, before = groundPoint(x, y)
    const lineHeight = Number.parseFloat(getComputedStyle(canvas).lineHeight), unit = event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? box.height : event.deltaMode === WheelEvent.DOM_DELTA_LINE && Number.isFinite(lineHeight) ? lineHeight : 1
    zoom -= event.deltaY * unit / box.height
    const after = groundPoint(x, y)
    if (before && after) { const current = MercatorCoordinate.fromLngLat(center), next = new MercatorCoordinate(current.x + before[0] - after[0], current.y + before[1] - after[1]).toLngLat(); center = [next.lng, next.lat] }
    changed()
  }
  const contextMenu = (event: Event): void => event.preventDefault()
  const onLost = (event: Event): void => { event.preventDefault(); lost = true; if (queued !== null) cancelAnimationFrame(queued); queued = null; emit('contextlost') }
  const onRestored = (): void => { lost = false; emit('contextrestored'); requestRender() }
  canvas.addEventListener('pointerdown', down); canvas.addEventListener('pointermove', move); canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up); canvas.addEventListener('wheel', wheel, { passive: false }); canvas.addEventListener('contextmenu', contextMenu); canvas.addEventListener('webglcontextlost', onLost); canvas.addEventListener('webglcontextrestored', onRestored)
  const observer = new ResizeObserver(() => { revision++; emit('resize'); requestRender() }); observer.observe(canvas)
  let handle: PhysicalViewportRenderer | null = null
  const port: PhysicalViewport = {
    surface: { kind: 'canvas', element: canvas, getSize: size, getPadding: () => ({ top: 0, right: 0, bottom: 0, left: 0 }), on: (event, listener) => subscribe(event === 'move' ? 'change' : event, listener) }, on: subscribe,
    intersectsBounds(bounds, mode) { const value = mode === '2d' ? { min: [bounds.min[0], bounds.min[1], 0] as [number, number, number], max: [bounds.max[0], bounds.max[1], 0] as [number, number, number] } : bounds; return intersectsPhysicalFrustum(matrix(), value) },
    ready: () => !lost && !destroyed, projectGeographic(point) { const p = MercatorCoordinate.fromLngLat(point), projected = transform(matrix(), [p.x, p.y, 0]), dimensions = size(); return { x: (projected[0] + 1) * dimensions.width / 2, y: (1 - projected[1]) * dimensions.height / 2 } }, requestRender,
    installRenderer(getEntries, nextPalette, reportError) { entries = getEntries; palette = nextPalette; renderer = createPhysicalSceneRenderer(gl, entries, palette, size, reportError); const owned = renderer; handle = { ...owned, setPalette(value) { palette = value; owned.setPalette(value) }, dispose() { owned.dispose(); if (renderer === owned) renderer = null; requestRender() } }; return handle },
    registered: candidate => candidate === handle && renderer !== null, orderRenderer() {},
    removeRenderer(candidate) { candidate.dispose(); if (candidate === handle) handle = null },
    cameraPose: () => ({ center, pitch, bearing, zoom, revision, elevation: targetZ / MercatorCoordinate.fromLngLat(center).meterInMercatorCoordinateUnits() }),
    setPose(patch) { if (patch.center) center = [patch.center[0], patch.center[1]]; if (patch.elevation !== undefined) targetZ = patch.elevation * MercatorCoordinate.fromLngLat(center).meterInMercatorCoordinateUnits(); if (patch.pitch !== undefined) pitch = Math.max(0, Math.min(85, patch.pitch)); if (patch.bearing !== undefined) bearing = patch.bearing; if (patch.zoom !== undefined) zoom = patch.zoom; changed() },
    fitWorld(bounds, options) {
      const midpoint = bounds.min.map((value, axis) => (value + bounds.max[axis]!) / 2), location = new MercatorCoordinate(midpoint[0]!, midpoint[1]!).toLngLat(); center = [location.lng, location.lat]; targetZ = midpoint[2]!
      if (!options.preservePose) { bearing = options.bearing; pitch = options.mode === '2d' ? 0 : options.pitch ?? 50 } else if (options.mode === '2d') pitch = 0
      const dimensions = size(), width = dimensions.width - options.padding.left - options.padding.right, height = dimensions.height - options.padding.top - options.padding.bottom, radius = Math.hypot(...bounds.max.map((value, axis) => (value - bounds.min[axis]!) / 2))
      if (!(width > 0) || !(height > 0) || !(radius > 0)) throw new Error('A physical focus requires nonempty bounds and visible viewport space')
      if (options.mode === '2d') {
        const angle = bearing * Math.PI / 180, points = boundsCorners(bounds).map(point => [Math.cos(angle) * (point[0] - midpoint[0]!) + Math.sin(angle) * (point[1] - midpoint[1]!), Math.sin(angle) * (point[0] - midpoint[0]!) - Math.cos(angle) * (point[1] - midpoint[1]!)])
        const spanX = Math.max(...points.map(point => point[0]!)) - Math.min(...points.map(point => point[0]!)), spanY = Math.max(...points.map(point => point[1]!)) - Math.min(...points.map(point => point[1]!)), perPixel = Math.max(spanX / width, spanY / height)
        targetZ = 0; zoom = Math.log2(1 / (512 * perPixel)); changed(); pan((options.padding.right - options.padding.left) / 2, (options.padding.bottom - options.padding.top) / 2); return
      }
      const fit = fitPhysicalPerspective({ bounds, ...(options.target ? { target: options.target } : {}), width: dimensions.width, height: dimensions.height, padding: options.padding, verticalFieldOfView: fov, bearing, pitch, nearRatio: Math.min(.5, 2 * Math.tan(fov / 2) / dimensions.height) })
      const opticalLocation = new MercatorCoordinate(fit.target[0], fit.target[1]).toLngLat(); center = [opticalLocation.lng, opticalLocation.lat]; targetZ = fit.target[2]
      const worldHeight = 2 * fit.distance * Math.tan(fov / 2)
      zoom = Math.log2(dimensions.height / (512 * worldHeight)); changed()
    },
    panBy: pan, setNavigationTool(value) { releasePointers(); tool = value }, cancelCamera: releasePointers,
    destroy() { if (destroyed) return; destroyed = true; if (queued !== null) cancelAnimationFrame(queued); observer.disconnect(); releasePointers(); renderer?.dispose(); renderer = null; listeners.clear(); canvas.style.touchAction = oldTouchAction; canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); canvas.removeEventListener('pointercancel', up); canvas.removeEventListener('wheel', wheel); canvas.removeEventListener('contextmenu', contextMenu); canvas.removeEventListener('webglcontextlost', onLost); canvas.removeEventListener('webglcontextrestored', onRestored) },
  }
  return port
}
