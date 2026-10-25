/** Sparse explicit inspection targets stay at their physical anchors; Components retains every subject. */
export const sparseLayoutBadges = <T extends { readonly point: { readonly x: number; readonly y: number }; readonly rank: number; readonly width?: number; readonly height?: number }>(
  candidates: ReadonlyArray<T>, viewport: { readonly width: number; readonly height: number }, covers: ReadonlyArray<{ readonly x: number; readonly y: number; readonly width: number; readonly height: number }> = [],
): ReadonlyArray<T> => {
  const kept: T[] = []
  for (const candidate of [...candidates].sort((left, right) => right.rank - left.rank)) {
    const { x, y } = candidate.point
    const width = Math.max(44, candidate.width ?? 44), height = Math.max(44, candidate.height ?? 44)
    if (x < width / 2 || x > viewport.width - width / 2 || y < height / 2 || y > viewport.height - height / 2) continue
    if (covers.some(cover => x + width / 2 > cover.x && x - width / 2 < cover.x + cover.width && y + height / 2 > cover.y && y - height / 2 < cover.y + cover.height)) continue
    if (kept.some(other => Math.abs(other.point.x - x) < (width + Math.max(44, other.width ?? 44)) / 2 && Math.abs(other.point.y - y) < (height + Math.max(44, other.height ?? 44)) / 2)) continue
    kept.push(candidate)
  }
  return kept
}
