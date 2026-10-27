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
/** True circular fillets with the requested minimum radius. Insufficient
 * straight length and immediate reversals are explicit errors. Chord tolerance
 * controls the sagitta; it never relaxes the authored bend radius. */
export const roundedPhysicalRoute = (input: ReadonlyArray<RoutePoint>, radius: number, chordTolerance: number): ReadonlyArray<RoutePoint> => {
  if (!Number.isFinite(chordTolerance) || !(chordTolerance > 0)) throw Error('Rounded routes require positive finite geometric tolerance')
  const { points, trims } = physicalFilletTrims(input, radius)
  const result: RoutePoint[] = [points[0]!]
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1]!, b = points[i]!, c = points[i + 1]!, trim = trims[i]!
    if (!trim) { result.push(b); continue }
    const u = unit(subtract(b, a)), v = unit(subtract(c, b)), normal = unit(cross(u, v)), angle = Math.atan2(magnitude(cross(u, v)), dot(u, v))
    const p = b.map((value, axis) => value - u[axis]! * trim) as unknown as RoutePoint, q = b.map((value, axis) => value + v[axis]! * trim) as unknown as RoutePoint
    const inward = cross(normal, u), center = p.map((value, axis) => value + inward[axis]! * radius) as unknown as RoutePoint, radial = subtract(p, center), tangent = cross(normal, radial)
    const stepAngle = chordTolerance >= radius ? Math.PI : 2 * Math.acos(1 - chordTolerance / radius) || Math.sqrt(8 * chordTolerance / radius)
    const steps = Math.ceil(angle / stepAngle)
    if (!Number.isSafeInteger(steps) || steps < 1) throw Error('Requested circular-arc tolerance is not representable')
    result.push(p)
    for (let step = 1; step < steps; step++) { const theta = angle * step / steps; result.push(center.map((value, axis) => value + radial[axis]! * Math.cos(theta) + tangent[axis]! * Math.sin(theta)) as unknown as RoutePoint) }
    result.push(q)
  }
  if (points.length > 1) result.push(points.at(-1)!)
  return result.filter((point, index) => !index || !same(point, result[index - 1]!))
}
