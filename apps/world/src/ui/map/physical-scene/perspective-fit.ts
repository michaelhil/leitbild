import type { PhysicalSceneBounds } from '../../../core/packs/scene.ts'
import { boundsCorners, dot, type Vector3 } from './math.ts'

export interface PhysicalFitPadding { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number }
export interface PhysicalPerspectiveFit {
  readonly bounds: PhysicalSceneBounds
  readonly target?: Vector3
  readonly width: number
  readonly height: number
  readonly padding: PhysicalFitPadding
  readonly verticalFieldOfView: number
  readonly bearing: number
  readonly pitch: number
  /** Native projection centre in NDC, e.g. MapLibre's existing map padding. */
  readonly projectionOffset?: { readonly x: number; readonly y: number }
  /** Actual host near-plane distance divided by eye-to-optical-target distance. */
  readonly nearRatio: number
}

/** Solve all eight padded perspective-frustum inequalities. The authored focus
 * lands at the usable rectangle's centre by translating the optical target in
 * its view plane, rather than panning after a fit and changing corner depths. */
export const fitPhysicalPerspective = (input: PhysicalPerspectiveFit) => {
  const { width, height, padding, bounds, nearRatio } = input
  if (![width, height, input.bearing, input.pitch, input.verticalFieldOfView, nearRatio, ...bounds.min, ...bounds.max, ...Object.values(padding), ...(input.target ?? []), input.projectionOffset?.x ?? 0, input.projectionOffset?.y ?? 0].every(Number.isFinite)
    || !(width > 0 && height > 0) || !(input.pitch >= 0 && input.pitch < 90) || !(input.verticalFieldOfView > 0 && input.verticalFieldOfView < Math.PI)
    || !(nearRatio >= 0 && nearRatio < 1) || Object.values(padding).some(value => value < 0)
    || !(width > padding.left + padding.right && height > padding.top + padding.bottom) || bounds.min.some((value, axis) => value > bounds.max[axis]!)) throw Error('A physical perspective fit requires finite bounds and usable frustum space')
  const focus = input.target ?? bounds.min.map((value, axis) => (value + bounds.max[axis]!) / 2) as unknown as Vector3
  const b = input.bearing * Math.PI / 180, p = input.pitch * Math.PI / 180
  const right: Vector3 = [Math.cos(b), Math.sin(b), 0], up: Vector3 = [Math.sin(b) * Math.cos(p), -Math.cos(b) * Math.cos(p), Math.sin(p)], back: Vector3 = [-Math.sin(b) * Math.sin(p), Math.cos(b) * Math.sin(p), Math.cos(p)]
  const tanY = Math.tan(input.verticalFieldOfView / 2), tanX = tanY * width / height
  const left = 2 * padding.left / width - 1, rightEdge = 1 - 2 * padding.right / width, bottom = 2 * padding.bottom / height - 1, top = 1 - 2 * padding.top / height
  const cx = (left + rightEdge) / 2, cy = (bottom + top) / 2, sx = (rightEdge - left) / 2, sy = (top - bottom) / 2, px = input.projectionOffset?.x ?? 0, py = input.projectionOffset?.y ?? 0
  let distance = 0
  for (const point of boundsCorners(bounds)) {
    const q = point.map((value, axis) => value - focus[axis]!) as unknown as Vector3, x = dot(q, right), y = dot(q, up), z = dot(q, back)
    distance = Math.max(distance, (x / tanX + (rightEdge - px) * z) / sx, (-x / tanX - (left - px) * z) / sx, (y / tanY + (top - py) * z) / sy, (-y / tanY - (bottom - py) * z) / sy, z / (1 - nearRatio))
  }
  if (!(distance > 0) || !Number.isFinite(distance)) throw Error('An authored physical focus must yield a positive camera distance')
  const dx = (px - cx) * distance * tanX, dy = (py - cy) * distance * tanY
  const target = focus.map((value, axis) => value + right[axis]! * dx + up[axis]! * dy) as unknown as Vector3
  const eye = target.map((value, axis) => value + back[axis]! * distance) as unknown as Vector3
  return { distance, target, eye, focus }
}
