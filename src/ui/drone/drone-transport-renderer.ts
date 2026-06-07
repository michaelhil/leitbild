import * as THREE from 'three'
import type {
  DroneMapWorldSnapshot,
  DroneWorldLineFeature,
  DroneWorldPoint,
} from './drone-map-world.ts'

const roadPalette = (
  feature: DroneWorldLineFeature,
): string => {
  if (feature.kind === 'rail') return '#64748b'
  if (feature.kind === 'waterway') return '#38bdf8'
  if (feature.className === 'motorway') return '#f97316'
  if (feature.className === 'trunk') return '#f59e0b'
  if (feature.className === 'primary') return '#facc15'
  if (feature.className === 'secondary') return '#fde68a'
  if (feature.className === 'tertiary') return '#f6e7bd'
  return '#e7e5dc'
}

const stableHash = (value: string): number => {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

const roadPriority = (
  className: string,
): number => {
  if (className === 'motorway') return 90
  if (className === 'trunk') return 80
  if (className === 'primary') return 70
  if (className === 'secondary') return 60
  if (className === 'tertiary') return 50
  if (className === 'minor') return 40
  return 30
}

const transportDrawOrder = (
  line: DroneWorldLineFeature,
): number => {
  if (line.kind === 'waterway') return 10
  if (line.kind === 'rail') return 20
  return 100 + roadPriority(line.className)
}

const transportLinesForDrawing = (
  lines: ReadonlyArray<DroneWorldLineFeature>,
): ReadonlyArray<DroneWorldLineFeature> =>
  [...lines].sort((left, right) => {
    const orderDelta = transportDrawOrder(left) - transportDrawOrder(right)
    if (orderDelta !== 0) return orderDelta
    return left.id.localeCompare(right.id)
  })

const simplifiedLinePath = (
  path: ReadonlyArray<DroneWorldPoint>,
  minDistanceM: number,
): ReadonlyArray<DroneWorldPoint> => {
  const first = path[0]
  const last = path[path.length - 1]
  if (!first || !last || path.length <= 2) return path
  const simplified: DroneWorldPoint[] = [first]
  let previous = first
  for (const point of path.slice(1, -1)) {
    if (Math.hypot(point.x - previous.x, point.z - previous.z) < minDistanceM) continue
    simplified.push(point)
    previous = point
  }
  if (last !== simplified[simplified.length - 1]) simplified.push(last)
  return simplified
}

const transportPointToCanvas = (
  point: DroneWorldPoint,
  halfExtentM: number,
  canvasSize: number,
): { readonly x: number; readonly y: number } => ({
  x: (point.x + halfExtentM) / (halfExtentM * 2) * canvasSize,
  y: (-point.z + halfExtentM) / (halfExtentM * 2) * canvasSize,
})

const strokeTransportPath = (
  context: CanvasRenderingContext2D,
  line: DroneWorldLineFeature,
  halfExtentM: number,
  canvasSize: number,
  simplifyDistanceM: number,
): void => {
  const path = simplifiedLinePath(line.path, simplifyDistanceM)
  const first = path[0]
  if (!first || path.length < 2) return
  const start = transportPointToCanvas(first, halfExtentM, canvasSize)
  context.beginPath()
  context.moveTo(start.x, start.y)
  for (const point of path.slice(1)) {
    const projected = transportPointToCanvas(point, halfExtentM, canvasSize)
    context.lineTo(projected.x, projected.y)
  }
  context.stroke()
}

const lineWidthPxFor = (
  line: DroneWorldLineFeature,
  metersToPixels: number,
): number =>
  Math.max(line.kind === 'road' ? 2.4 : 1.8, line.widthM * metersToPixels)

const drawTransportCasings = (
  context: CanvasRenderingContext2D,
  lines: ReadonlyArray<DroneWorldLineFeature>,
  halfExtentM: number,
  canvasSize: number,
  metersToPixels: number,
): void => {
  context.save()
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.setLineDash([])
  for (const line of lines) {
    const lineWidth = lineWidthPxFor(line, metersToPixels)
    if (line.kind === 'waterway') {
      context.globalAlpha = 0.4
      context.strokeStyle = '#075985'
      context.lineWidth = Math.max(lineWidth + 2.2, lineWidth * 1.25)
    } else if (line.kind === 'rail') {
      context.globalAlpha = 0.5
      context.strokeStyle = '#1f2937'
      context.lineWidth = Math.max(lineWidth + 2.4, lineWidth * 1.35)
    } else {
      context.globalAlpha = roadPriority(line.className) >= 60 ? 0.54 : 0.34
      context.strokeStyle = '#475569'
      context.lineWidth = Math.max(lineWidth + 4, lineWidth * 1.24)
    }
    strokeTransportPath(context, line, halfExtentM, canvasSize, 1.1)
  }
  context.restore()
}

const drawTransportFills = (
  context: CanvasRenderingContext2D,
  lines: ReadonlyArray<DroneWorldLineFeature>,
  halfExtentM: number,
  canvasSize: number,
  metersToPixels: number,
): void => {
  context.save()
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.setLineDash([])
  for (const line of lines) {
    const lineWidth = lineWidthPxFor(line, metersToPixels)
    context.globalAlpha = line.kind === 'waterway' ? 0.82 : 1
    context.strokeStyle = roadPalette(line)
    context.lineWidth = lineWidth
    strokeTransportPath(context, line, halfExtentM, canvasSize, 0.75)
  }
  context.restore()
}

const drawRailDetails = (
  context: CanvasRenderingContext2D,
  lines: ReadonlyArray<DroneWorldLineFeature>,
  halfExtentM: number,
  canvasSize: number,
  metersToPixels: number,
): void => {
  context.save()
  context.lineCap = 'butt'
  context.lineJoin = 'round'
  context.strokeStyle = '#111827'
  context.globalAlpha = 0.64
  for (const line of lines) {
    if (line.kind !== 'rail') continue
    const lineWidth = lineWidthPxFor(line, metersToPixels)
    context.lineWidth = Math.max(1.2, lineWidth * 0.32)
    context.setLineDash([Math.max(1.5, 2.5 * metersToPixels), Math.max(5, 9 * metersToPixels)])
    context.lineDashOffset = stableHash(line.id) % 19
    strokeTransportPath(context, line, halfExtentM, canvasSize, 0.75)
  }
  context.restore()
}

const drawRoadMarkings = (
  context: CanvasRenderingContext2D,
  lines: ReadonlyArray<DroneWorldLineFeature>,
  halfExtentM: number,
  canvasSize: number,
  metersToPixels: number,
): void => {
  const markedRoads = lines.filter(line => line.kind === 'road' && line.widthM >= 8)
  if (markedRoads.length === 0) return
  context.save()
  context.lineCap = 'round'
  context.lineJoin = 'round'
  for (const line of markedRoads) {
    const lineWidth = lineWidthPxFor(line, metersToPixels)
    const dash = Math.max(7, 11 * metersToPixels)
    const gap = Math.max(7, 13 * metersToPixels)
    const dashOffset = stableHash(line.id) % Math.max(1, Math.round(dash + gap))

    context.setLineDash([dash, gap])
    context.lineDashOffset = dashOffset
    context.globalAlpha = 0.36
    context.strokeStyle = '#0f172a'
    context.lineWidth = Math.max(2.4, lineWidth * 0.17)
    strokeTransportPath(context, line, halfExtentM, canvasSize, 0.6)

    context.globalAlpha = 0.94
    context.strokeStyle = '#fff7ed'
    context.lineWidth = Math.max(1.45, lineWidth * 0.09)
    strokeTransportPath(context, line, halfExtentM, canvasSize, 0.6)
  }
  context.restore()
}

const createTransportCanvas = (
  lines: ReadonlyArray<DroneWorldLineFeature>,
  halfExtentM: number,
): HTMLCanvasElement | null => {
  if (typeof document === 'undefined' || lines.length === 0) return null
  const canvasSize = 2048
  const canvas = document.createElement('canvas')
  canvas.width = canvasSize
  canvas.height = canvasSize
  const context = canvas.getContext('2d', { alpha: true })
  if (!context) return null
  context.clearRect(0, 0, canvasSize, canvasSize)
  const metersToPixels = canvasSize / (halfExtentM * 2)
  const sortedLines = transportLinesForDrawing(lines)
  drawTransportCasings(context, sortedLines, halfExtentM, canvasSize, metersToPixels)
  drawTransportFills(context, sortedLines, halfExtentM, canvasSize, metersToPixels)
  drawRailDetails(context, sortedLines, halfExtentM, canvasSize, metersToPixels)
  drawRoadMarkings(context, sortedLines, halfExtentM, canvasSize, metersToPixels)
  return canvas
}

export const createTransportDecal = (
  snapshot: DroneMapWorldSnapshot,
): THREE.Mesh | null => {
  const halfExtentM = snapshot.radiusM * 1.08
  const canvas = createTransportCanvas(snapshot.lines, halfExtentM)
  if (!canvas) return null
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.generateMipmaps = true
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.anisotropy = 4
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    alphaTest: 0.015,
    depthWrite: false,
    opacity: 1,
  })
  material.polygonOffset = true
  material.polygonOffsetFactor = -2
  material.polygonOffsetUnits = -2
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(halfExtentM * 2, halfExtentM * 2, 1, 1), material)
  mesh.rotation.x = -Math.PI / 2
  mesh.position.y = 0.14
  mesh.renderOrder = 2
  mesh.receiveShadow = false
  mesh.userData.receiveShadow = false
  return mesh
}
