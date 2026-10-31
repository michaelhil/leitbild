import type { RoutePoint } from './source.ts'
import { same, unit, subtract, bendTrim, enough, distance, cross, magnitude, dot } from './vector.ts'

/** Independent geometric feasibility check shared by authoring and tessellation. */
export const physicalFilletTrims = (input: ReadonlyArray<RoutePoint>, radius: number) => {
  if (!Number.isFinite(radius) || !(radius > 0) || input.some(p => p.length !== 3 || p.some(v => !Number.isFinite(v)))) throw Error('Rounded routes require finite geometry and positive radius')
  const points = input.filter((p, index) => !index || !same(p, input[index - 1]!))
  if (!points.length) throw Error('A rounded route needs a centreline point')
  const trims = points.map((b, index) => index === 0 || index === points.length - 1 ? 0 : bendTrim(unit(subtract(b, points[index - 1]!)), unit(subtract(points[index + 1]!, b)), radius))
  if (trims.some(v => !Number.isFinite(v))) throw Error('A centreline cannot make an immediate 180-degree reversal')
  for (let i = 1; i < points.length; i++) if (!enough(distance(points[i - 1]!, points[i]!), trims[i - 1]! + trims[i]!, Math.max(...points[i - 1]!.map(Math.abs), ...points[i]!.map(Math.abs)))) throw Error('Centreline straight length cannot accommodate the specified minimum bend radius')
  return { points, trims }
}
/** Adjacent fillets that consume one complete straight run share ONE analytic
 * tangent point. Independent a+uR/b-uR evaluations can differ by an ULP and
 * manufacture a reversed microsegment. Only a forward-error equality of the
 * exact trim equation admits this canonical joint; no metric weld is applied. */
export const physicalFilletJoints = (points: ReadonlyArray<RoutePoint>, trims: ReadonlyArray<number>): ReadonlyArray<RoutePoint | undefined> => points.slice(1).map((b, index) => {
  const a = points[index]!, length = distance(a, b), sum = trims[index]! + trims[index + 1]!, operationScale = Math.max(...a.map(Math.abs), ...b.map(Math.abs))
  if (!sum || !enough(length, sum, operationScale) || !enough(sum, length, operationScale)) return undefined
  if (!trims[index]) return a
  if (!trims[index + 1]) return b
  const fraction = trims[index]! / sum
  return a.map((value, axis) => value + (b[axis]! - value) * fraction) as unknown as RoutePoint
})
/** Analytic circular corner shared by meshing and self-clearance validation. */
export const physicalFilletArc = (a: RoutePoint, b: RoutePoint, c: RoutePoint, radius: number, trim: number, sharedStart?: RoutePoint, sharedEnd?: RoutePoint) => {
  const u = unit(subtract(b, a)), v = unit(subtract(c, b)), normal = unit(cross(u, v)), angle = Math.atan2(magnitude(cross(u, v)), dot(u, v))
  const p = sharedStart ?? b.map((value, axis) => value - u[axis]! * trim) as unknown as RoutePoint, q = sharedEnd ?? b.map((value, axis) => value + v[axis]! * trim) as unknown as RoutePoint
  const inward = cross(normal, u), center = p.map((value, axis) => value + inward[axis]! * radius) as unknown as RoutePoint, radial = subtract(p, center), tangent = cross(normal, radial)
  const point = (fraction: number): RoutePoint => fraction === 0 ? p : fraction === 1 ? q : center.map((value, axis) => value + radial[axis]! * Math.cos(angle * fraction) + tangent[axis]! * Math.sin(angle * fraction)) as unknown as RoutePoint
  const tangentAt = (fraction: number): RoutePoint => fraction === 0 ? u : fraction === 1 ? v : u.map((value, axis) => value * Math.cos(angle * fraction) + inward[axis]! * Math.sin(angle * fraction)) as unknown as RoutePoint
  return { p, q, angle, point, tangent: tangentAt }
}
export interface PhysicalRoundedRouteSamples { readonly points: ReadonlyArray<RoutePoint>; readonly tangents: ReadonlyArray<RoutePoint> }
/** True circular fillets and their analytic unit tangents. The sampling radius
 * may exceed the centreline radius: a swept tube uses R+r so its outer surface,
 * rather than only its centreline, obeys the chord-error budget. */
export const roundedPhysicalRouteSamples = (input: ReadonlyArray<RoutePoint>, radius: number, chordTolerance: number, samplingRadius = radius): PhysicalRoundedRouteSamples => {
  if (!Number.isFinite(chordTolerance) || !(chordTolerance > 0) || !Number.isFinite(samplingRadius) || samplingRadius < radius) throw Error('Rounded routes require finite positive tolerance and a sampling radius enclosing their centreline')
  const { points, trims } = physicalFilletTrims(input, radius)
  if (points.length < 2) throw Error('A sampled route requires at least two distinct points')
  const joints = physicalFilletJoints(points, trims), result: RoutePoint[] = [], tangents: RoutePoint[] = []
  const append = (point: RoutePoint, tangent: RoutePoint) => {
    if (result.length && same(point, result.at(-1)!)) return
    result.push(point); tangents.push(tangent)
  }
  append(points[0]!, unit(subtract(points[1]!, points[0]!)))
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1]!, b = points[i]!, c = points[i + 1]!, trim = trims[i]!
    if (!trim) { append(b, unit(subtract(c, b))); continue }
    const arc = physicalFilletArc(a, b, c, radius, trim, joints[i - 1], joints[i])
    // Stable sagitta inversion: t = 2R sin²(step/4), without acos cancellation.
    const stepAngle = chordTolerance >= samplingRadius ? Math.PI : 4 * Math.asin(Math.sqrt(chordTolerance / (2 * samplingRadius)))
    const steps = Math.ceil(arc.angle / stepAngle)
    if (!Number.isSafeInteger(steps) || steps < 1) throw Error('Requested circular-arc tolerance is not representable')
    for (let step = 0; step <= steps; step++) append(arc.point(step / steps), arc.tangent(step / steps))
  }
  append(points.at(-1)!, unit(subtract(points.at(-1)!, points.at(-2)!)))
  return { points: result, tangents }
}
/** Existing centreline-only authoring API: its chord budget applies to R. */
export const roundedPhysicalRoute = (input: ReadonlyArray<RoutePoint>, radius: number, chordTolerance: number): ReadonlyArray<RoutePoint> => {
  const { points } = physicalFilletTrims(input, radius)
  if (points.length === 1) { if (!Number.isFinite(chordTolerance) || !(chordTolerance > 0)) throw Error('Rounded routes require positive finite geometric tolerance'); return points }
  return roundedPhysicalRouteSamples(points, radius, chordTolerance).points
}
