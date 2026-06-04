export interface FloatingWindowBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface FloatingWindowViewport {
  readonly width: number
  readonly height: number
}

export interface FloatingWindowConstraints {
  readonly minWidth: number
  readonly minHeight: number
  readonly margin: number
}

export type FloatingWindowDragMode =
  | 'move'
  | 'resize-north'
  | 'resize-east'
  | 'resize-south'
  | 'resize-west'
  | 'resize-north-east'
  | 'resize-north-west'
  | 'resize-south-east'
  | 'resize-south-west'

export interface FloatingWindowDragSnapshot {
  readonly mode: FloatingWindowDragMode
  readonly origin: FloatingWindowBounds
  readonly dx: number
  readonly dy: number
}

const finiteOr = (value: number, fallback: number): number =>
  Number.isFinite(value) ? value : fallback

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value))

export const normalizeFloatingWindowBounds = (
  bounds: FloatingWindowBounds,
  viewport: FloatingWindowViewport,
  constraints: FloatingWindowConstraints,
): FloatingWindowBounds => {
  const viewportWidth = Math.max(1, finiteOr(viewport.width, 1))
  const viewportHeight = Math.max(1, finiteOr(viewport.height, 1))
  const margin = Math.max(0, finiteOr(constraints.margin, 0))
  const availableWidth = Math.max(1, viewportWidth - margin * 2)
  const availableHeight = Math.max(1, viewportHeight - margin * 2)
  const minWidth = Math.max(1, Math.min(availableWidth, finiteOr(constraints.minWidth, 1)))
  const minHeight = Math.max(1, Math.min(availableHeight, finiteOr(constraints.minHeight, 1)))
  const width = clamp(finiteOr(bounds.width, minWidth), minWidth, availableWidth)
  const height = clamp(finiteOr(bounds.height, minHeight), minHeight, availableHeight)
  return {
    x: clamp(finiteOr(bounds.x, margin), margin, Math.max(margin, viewportWidth - width - margin)),
    y: clamp(finiteOr(bounds.y, margin), margin, Math.max(margin, viewportHeight - height - margin)),
    width,
    height,
  }
}

export const floatingWindowBoundsForDrag = (
  drag: FloatingWindowDragSnapshot,
  viewport: FloatingWindowViewport,
  constraints: FloatingWindowConstraints,
): FloatingWindowBounds => {
  const { origin, dx, dy } = drag
  if (drag.mode === 'move') {
    return normalizeFloatingWindowBounds({
      ...origin,
      x: origin.x + dx,
      y: origin.y + dy,
    }, viewport, constraints)
  }

  const east = origin.x + origin.width
  const south = origin.y + origin.height
  let next = { ...origin }

  if (drag.mode.includes('east')) {
    next = { ...next, width: origin.width + dx }
  }
  if (drag.mode.includes('south')) {
    next = { ...next, height: origin.height + dy }
  }
  if (drag.mode.includes('west')) {
    const rawWidth = origin.width - dx
    const width = Math.max(constraints.minWidth, rawWidth)
    next = {
      ...next,
      x: east - width,
      width,
    }
  }
  if (drag.mode.includes('north')) {
    const rawHeight = origin.height - dy
    const height = Math.max(constraints.minHeight, rawHeight)
    next = {
      ...next,
      y: south - height,
      height,
    }
  }

  return normalizeFloatingWindowBounds(next, viewport, constraints)
}
