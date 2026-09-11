/** Selected fictional route geometry and loss screening; not structural piping qualification. */
import { createHash } from 'node:crypto'
import { z } from 'zod'

const positive = z.number().finite().positive()
const schema = z.object({
  source: z.literal('LD01.HOT.A'), receiver: z.literal('LD01.PZR'),
  sourceElevation_m: z.number().finite(), receiverElevation_m: z.number().finite(),
  developedLength_m: positive, firstStraight_m: positive, bendRadius_m: positive,
  internalDiameter_m: positive, wallThickness_m: positive, steelDensity_kg_m3: positive,
  roughness_m: z.number().finite().nonnegative(),
  entryLoss: z.number().finite().nonnegative(), elbowLoss: z.number().finite().nonnegative(), exitLoss: z.number().finite().nonnegative(),
}).strict().superRefine((r, c) => {
  const rise = r.receiverElevation_m - r.sourceElevation_m
  const middle = r.developedLength_m - r.firstStraight_m - Math.PI * r.bendRadius_m - (rise - r.bendRadius_m)
  if (rise <= r.bendRadius_m || middle <= 0 || r.bendRadius_m <= (r.internalDiameter_m / 2 + r.wallThickness_m))
    c.addIssue({ code: 'custom', message: 'Route needs a positive vertical leg, middle leg and physically distinct bend bore' })
})
export type SurgeRoute = z.infer<typeof schema>
export function parseSurgeRoute(document: string): SurgeRoute {
  const blocks = [...document.matchAll(/^```reference-surge-route\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw Error('Expected one reference-surge-route block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}

/** Exact route: east straight, plan quarter bend, north straight, rising quarter bend, vertical. */
export function resolveSurgeRoute(r: SurgeRoute) {
  const arc = Math.PI * r.bendRadius_m / 2
  const rise = r.receiverElevation_m - r.sourceElevation_m
  const vertical = rise - r.bendRadius_m
  const middle = r.developedLength_m - r.firstStraight_m - 2 * arc - vertical
  const lengths = [r.firstStraight_m, arc, middle, arc, vertical]
  const risingStart = r.firstStraight_m + arc + middle
  const verticalStart = risingStart + arc
  const area = Math.PI * r.internalDiameter_m ** 2 / 4
  const steelArea = Math.PI * ((r.internalDiameter_m + 2 * r.wallThickness_m) ** 2 - r.internalDiameter_m ** 2) / 4
  const elevationMoment = r.sourceElevation_m * risingStart
    + arc * (r.sourceElevation_m + r.bendRadius_m * (1 - 2 / Math.PI))
    + vertical * (r.sourceElevation_m + r.bendRadius_m + vertical / 2)
  return {
    ...r, lengths_m: lengths, risingStart_m: risingStart, verticalStart_m: verticalStart,
    endpoint_m: [r.firstStraight_m + r.bendRadius_m, middle + 2 * r.bendRadius_m, r.receiverElevation_m],
    area_m2: area, liquidVolume_m3: area * r.developedLength_m,
    steelVolume_m3: steelArea * r.developedLength_m, steelMass_kg: steelArea * r.developedLength_m * r.steelDensity_kg_m3,
    volumeMeanElevation_m: elevationMoment / r.developedLength_m,
    innerContactArea_m2: Math.PI * r.internalDiameter_m * r.developedLength_m,
    inertancePerMassFlow_per_m: r.developedLength_m / area,
    totalMinorLoss: r.entryLoss + 2 * r.elbowLoss + r.exitLoss,
  }
}
export function routeElevation(r: ReturnType<typeof resolveSurgeRoute>, distance: number): number {
  if (!Number.isFinite(distance) || distance < 0 || distance > r.developedLength_m) throw Error('Outside physical route')
  if (distance <= r.risingStart_m) return r.sourceElevation_m
  if (distance <= r.verticalStart_m) return r.sourceElevation_m + r.bendRadius_m * (1 - Math.cos((distance - r.risingStart_m) / r.bendRadius_m))
  return r.sourceElevation_m + r.bendRadius_m + distance - r.verticalStart_m
}

const logAdd = (a: number, b: number) => Math.max(a, b) + Math.log1p(Math.exp(-Math.abs(a - b)))
/** Churchill Eq18 times eight: the original paper's f is one eighth of Darcy f. */
export function logDarcyFactor(reynolds: number, relativeRoughness: number): number {
  if (!(Number.isFinite(reynolds) && reynolds > 0 && Number.isFinite(relativeRoughness) && relativeRoughness >= 0)) throw Error('Invalid friction state')
  const logRe = Math.log(reynolds)
  const logTerm = logAdd(.9 * (Math.log(7) - logRe), relativeRoughness ? Math.log(.27 * relativeRoughness) : -Infinity)
  const logA = 16 * Math.log(Math.abs(-2.457 * logTerm))
  const logB = 16 * (Math.log(37530) - logRe)
  return Math.log(8) + logAdd(12 * (Math.log(8) - logRe), -1.5 * logAdd(logA, logB)) / 12
}
export function routeLoss(r: ReturnType<typeof resolveSurgeRoute>, massFlow: number, density: number, viscosity: number) {
  if (![massFlow, density, viscosity].every(Number.isFinite) || density <= 0 || viscosity <= 0) throw Error('Invalid liquid flow state')
  if (massFlow === 0) return { reynolds: 0, friction_Pa: 0, minor_Pa: 0, total_Pa: 0 }
  const re = Math.abs(massFlow) * r.internalDiameter_m / (r.area_m2 * viscosity)
  const logDynamic = 2 * Math.log(Math.abs(massFlow)) - Math.log(2 * density * r.area_m2 ** 2)
  const friction = Math.sign(massFlow) * Math.exp(logDarcyFactor(re, r.roughness_m / r.internalDiameter_m) + logDynamic) * r.developedLength_m / r.internalDiameter_m
  const minor = Math.sign(massFlow) * Math.exp(logDynamic) * r.totalMinorLoss
  return { reynolds: re, friction_Pa: friction, minor_Pa: minor, total_Pa: friction + minor }
}

/** Same two scalar laws for the offline HEOS reference; parity-tested against this module. */
export const surgeRoutePython = String.raw`
def route_elevation(r, distance):
    if not math.isfinite(distance) or not 0 <= distance <= r['developedLength_m']:
        raise ValueError('Outside physical route')
    if distance <= r['risingStart_m']:
        return r['sourceElevation_m']
    if distance <= r['verticalStart_m']:
        return r['sourceElevation_m'] + r['bendRadius_m'] * (1 - math.cos((distance - r['risingStart_m']) / r['bendRadius_m']))
    return r['sourceElevation_m'] + r['bendRadius_m'] + distance - r['verticalStart_m']

def log_darcy_factor(reynolds, relative_roughness):
    if not (math.isfinite(reynolds) and reynolds > 0 and math.isfinite(relative_roughness) and relative_roughness >= 0):
        raise ValueError('Invalid friction state')
    def log_add(a, b):
        return max(a, b) + math.log1p(math.exp(-abs(a-b)))
    log_re = math.log(reynolds)
    log_term = log_add(.9 * (math.log(7) - log_re), math.log(.27 * relative_roughness) if relative_roughness else -math.inf)
    log_a = 16 * math.log(abs(-2.457 * log_term)) if log_term else -math.inf
    log_b = 16 * (math.log(37530) - log_re)
    return math.log(8) + log_add(12 * (math.log(8) - log_re), -1.5 * log_add(log_a, log_b)) / 12
`

if (import.meta.main) {
  const path = Bun.argv[2]
  if (!path || Bun.argv.length !== 3) throw Error('Usage: reference-design-surge-route.ts <surge-route.md>')
  const document = await Bun.file(path).text(), input = parseSurgeRoute(document)
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  console.log(JSON.stringify({ scope: 'Fictional route geometry only; no fluid trajectory or structural qualification',
    sourceSha256: hash(await Bun.file(import.meta.path).text()), inputSha256: hash(JSON.stringify(input)), route: resolveSurgeRoute(input) }, null, 2))
}
