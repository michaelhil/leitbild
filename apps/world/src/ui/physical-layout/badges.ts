const MAX_VISIBLE_LAYOUT_TARGETS = 8
const TARGET_WIDTH = 104
const TARGET_HEIGHT = 44
/** Sparse explicit inspection targets stay at their physical anchors; Components retains every subject. */
export const sparseLayoutBadges = <T extends { readonly point: { readonly x: number; readonly y: number }; readonly rank: number }>(
  candidates: ReadonlyArray<T>, viewport: { readonly width: number; readonly height: number }, covers: ReadonlyArray<{ readonly x: number; readonly y: number; readonly width: number; readonly height: number }> = [],
): ReadonlyArray<T> => {
  const kept: T[] = []
  for (const candidate of [...candidates].sort((left, right) => right.rank - left.rank)) {
    const { x, y } = candidate.point
    if (x < TARGET_WIDTH / 2 || x > viewport.width - TARGET_WIDTH / 2 || y < TARGET_HEIGHT / 2 || y > viewport.height - TARGET_HEIGHT / 2) continue
    if (covers.some(cover => x + TARGET_WIDTH / 2 > cover.x && x - TARGET_WIDTH / 2 < cover.x + cover.width && y + TARGET_HEIGHT / 2 > cover.y && y - TARGET_HEIGHT / 2 < cover.y + cover.height)) continue
    if (kept.some(other => Math.abs(other.point.x - x) < TARGET_WIDTH && Math.abs(other.point.y - y) < TARGET_HEIGHT)) continue
    kept.push(candidate)
    if (kept.length === MAX_VISIBLE_LAYOUT_TARGETS) break
  }
  return kept
}
