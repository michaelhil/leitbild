type Position = readonly [number, number, number]
type Region = { readonly min: Position; readonly max: Position }
export interface PlanContinuation { readonly point: readonly [number, number]; readonly outward: readonly [number, number] }
/** Crossings of the UNION of selected display envelopes. Internal member
 * boundaries are not continuations. This is presentation cropping, not a civil
 * penetration or a change to the connection's complete physical path. */
export const physicalPlanContinuations = (points: ReadonlyArray<Position>, regions: ReadonlyArray<Region>, floor?: { readonly low: number; readonly high: number }): ReadonlyArray<PlanContinuation> => {
  if (!regions.length) return []
  const inside = (x: number, y: number) => regions.some(region => x >= region.min[0] && x <= region.max[0] && y >= region.min[1] && y <= region.max[1])
  const output: PlanContinuation[] = []
  let previous: boolean | undefined
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!, dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy)
    const events = [0, 1]
    for (const region of regions) for (const axis of [0, 1] as const) {
      const delta = b[axis] - a[axis]; if (!delta) continue
      for (const edge of [region.min[axis], region.max[axis]]) { const t = (edge - a[axis]) / delta; if (t > 0 && t < 1) events.push(t) }
    }
    const ordered = [...new Set(events)].sort((a, b) => a - b)
    for (let part = 1; part < ordered.length; part++) {
      const t = ordered[part - 1]!, middle = (t + ordered[part]!) / 2, current = inside(a[0] + dx * middle, a[1] + dy * middle)
      if (previous !== undefined && previous !== current && length > 0) {
        const z = a[2] + (b[2] - a[2]) * t
        if (!floor || z >= floor.low && z < floor.high) {
          const sign = current ? -1 : 1
          output.push({ point: [a[0] + dx * t, a[1] + dy * t], outward: [sign * dx / length, sign * dy / length] })
        }
      }
      previous = current
    }
  }
  return output
}
