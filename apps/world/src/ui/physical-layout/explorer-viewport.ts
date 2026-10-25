export interface ExplorerViewportRect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface ExplorerViewportPadding { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number }

/**
 * Find a clear rectangle for the common camera's fit operation. Both viewport
 * ports fit their 3D bounding sphere using the shorter available dimension, so
 * maximize that dimension first, then area. Actual full-width controls naturally
 * produce top/bottom strips; floating corner controls do not reserve whole rows.
 */
export const physicalExplorerFitRect = (
  size: { readonly width: number; readonly height: number },
  padding: ExplorerViewportPadding,
  covers: ReadonlyArray<ExplorerViewportRect>,
  clearance = 12,
): ExplorerViewportRect | null => {
  const x0 = padding.left + clearance, x1 = size.width - padding.right - clearance
  const y0 = padding.top + clearance, y1 = size.height - padding.bottom - clearance
  if (!(x1 > x0) || !(y1 > y0)) return null
  const blocked = covers.map(cover => ({ left: Math.max(x0, cover.x - clearance), right: Math.min(x1, cover.x + cover.width + clearance), top: Math.max(y0, cover.y - clearance), bottom: Math.min(y1, cover.y + cover.height + clearance) }))
    .filter(cover => cover.right > cover.left && cover.bottom > cover.top)
  const xs = [...new Set([x0, x1, ...blocked.flatMap(cover => [cover.left, cover.right])])].sort((a, b) => a - b)
  let best: ExplorerViewportRect | null = null
  const consider = (left: number, right: number, top: number, bottom: number): void => {
    if (!(right > left) || !(bottom > top)) return
    const candidate = { x: left, y: top, width: right - left, height: bottom - top }
    const minimum = Math.min(candidate.width, candidate.height), previous = best === null ? -Infinity : Math.min(best.width, best.height)
    const area = candidate.width * candidate.height, previousArea = best === null ? -Infinity : best.width * best.height
    const distance = Math.hypot(candidate.x + candidate.width / 2 - size.width / 2, candidate.y + candidate.height / 2 - size.height / 2)
    const previousDistance = best === null ? Infinity : Math.hypot(best.x + best.width / 2 - size.width / 2, best.y + best.height / 2 - size.height / 2)
    if (minimum > previous || minimum === previous && (area > previousArea || area === previousArea && distance < previousDistance)) best = candidate
  }
  for (let start = 0; start < xs.length - 1; start++) for (let end = start + 1; end < xs.length; end++) {
    const left = xs[start]!, right = xs[end]!
    const intervals = blocked.filter(cover => cover.left < right && cover.right > left).map(cover => [cover.top, cover.bottom] as const).sort((a, b) => a[0] - b[0])
    let top = y0
    for (const [from, to] of intervals) { consider(left, right, top, from); top = Math.max(top, to) }
    consider(left, right, top, y1)
  }
  return best
}

export const physicalExplorerFitPadding = (size: { readonly width: number; readonly height: number }, padding: ExplorerViewportPadding, covers: ReadonlyArray<ExplorerViewportRect>): ExplorerViewportPadding => {
  const clear = physicalExplorerFitRect(size, padding, covers)
  if (clear === null) throw new Error('Close an expanded layout panel before fitting this viewport: no uncovered drawing area remains')
  return { top: clear.y, right: size.width - clear.x - clear.width, bottom: size.height - clear.y - clear.height, left: clear.x }
}
