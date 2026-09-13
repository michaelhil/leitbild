/** Offline coherent-cap geometry and same-physical-mouth flux tests. Not a tank trajectory. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parseGeometryBasis, tankGeometry } from './reference-design-cmt-geometry.ts'
import { phaseSeriesParent } from './reference-design-cmt-phase-series.ts'
import { phasePathSetup } from './reference-design-cmt-phase-path.ts'

export function mouthIntersection(radius: number, centerHeight: number, curvature: number) {
  if (![radius, centerHeight, curvature].every(Number.isFinite) || radius <= 0 || curvature <= 0)
    throw new Error('Invalid manufactured mouth graph')
  // Manufactured graph z-z_m = a+b*r² on its ACTIVE physical part only.
  const gasRadiusSquared = Math.max(0, Math.min(radius * radius, -centerHeight / curvature))
  const gasArea = Math.PI * gasRadiusSquared, area = Math.PI * radius * radius
  return { gasArea_m2: gasArea, liquidArea_m2: area - gasArea, gasFraction: gasArea / area,
    activeInnerRadius_m: Math.sqrt(gasRadiusSquared) }
}
export function surfaceRate(slope: number, radialVelocity: number, verticalVelocity: number, phaseMassFlux: number, density: number) {
  if (![slope, radialVelocity, verticalVelocity, phaseMassFlux, density].every(Number.isFinite) || density <= 0)
    throw new Error('Invalid moving interface state')
  return verticalVelocity - radialVelocity * slope - phaseMassFlux * Math.hypot(1, slope) / density
}
export function partitionAperture(physicalArea: number, effectiveArea: number, fraction: number, opening: number) {
  if (![physicalArea, effectiveArea, fraction, opening].every(Number.isFinite) || physicalArea <= 0 ||
      effectiveArea <= 0 || effectiveArea >= physicalArea || fraction < 0 || fraction > 1 || opening < 0 || opening > 1)
    throw new Error('Invalid shared physical aperture')
  return { physicalArea_m2: physicalArea * fraction, effectiveArea_m2: effectiveArea * fraction * opening }
}
const capCase = z.object({ pv_Pa: z.number(), pl_Pa: z.number(), j_kg_m2s: z.number(),
  liquid: z.object({ rho: z.number(), h: z.number() }), vapor: z.object({ rho: z.number(), h: z.number() }),
  heatLiquid_W_m2: z.number(), heatVapor_W_m2: z.number() })

export const mouthCalculation = phasePathSetup + String.raw`
fullA=A;ae=d['mouth']['effectiveArea_m2'];zm=d['mouth']['elevation_m'];g=9.80665
liquid=pt(5e6,313.15);steam=pt(5e6,pq(5e6,1)['T']+20);receiver=pt(4.95e6,333.15)
def patch(up,down,f,opening=1.,extra=0.,boron=.002):
    global A
    if f==0:return dict(m=0.,E=0.,B=0.,Pin=0.,Pout=0.,reaction=0.,S=0.)
    if opening==0:return dict(m=0.,E=0.,B=0.,Pin=f*fullA*up['p'],Pout=f*fullA*down['p'],
        reaction=f*fullA*(down['p']-up['p']),S=0.)
    A=f*fullA
    try:
        rr=capacity(up,down['p'],f*ae*opening,pressureIntegral=True)
        q,err=downstream(down['p'],rr['H']+extra,rr['m'])
        vu=rr['m']/(up['rho']*A);vd=rr['m']/(q['rho']*A)
        guard(vd<sound(q) and q['s']>=up['s']-1e-8,'Actual patch recovery/entropy')
        pin=A*up['p']+rr['m']*vu;pout=A*down['p']+rr['m']*vd
        return dict(m=rr['m'],E=rr['m']*(rr['H']+extra+g*zm),B=rr['m']*(1-up['x'])*boron,
            Pin=pin,Pout=pout,reaction=pout-pin,S=rr['m']*(q['s']-up['s']),
            upstream=up,downstream=q,Ht_J_kg=rr['H']+extra+g*zm,
            energyResidual_J_kg=err,outletMach=vd/sound(q))
    finally:A=fullA
cases=[]
for f in d['mouth']['fractions']:
    l=patch(liquid,receiver,1-f);v=patch(steam,receiver,f)
    totals={key:l[key]+v[key] for key in ['m','E','B','Pin','Pout','reaction','S']}
    guard(abs(totals['Pout']-totals['Pin']-totals['reaction'])<1e-7,'Shared mouth reaction')
    cases.append(dict(gasAreaFraction=f,liquid=l,vapor=v,total=totals))
identical=[];whole=patch(liquid,receiver,1.)
for f in [.000001,.25,.75]:
    a=patch(liquid,receiver,f);c=patch(liquid,receiver,1-f)
    defects={key:a[key]+c[key]-whole[key] for key in ['m','E','B','Pin','Pout','reaction','S']}
    guard(all(abs(v)<1e-6 for v in defects.values()),'Identical donor geometric partition invariance')
    identical.append(dict(fraction=f,defects=defects))
reverseDonor=pt(5.05e6,333.15)
reverse=patch(reverseDonor,liquid,.25,boron=.0005)
guard(abs(reverse['B']-reverse['m']*.0005)<1e-14,'Reverse actual donor boron')
reverseFlux=dict(massToTank_kg_s=reverse['m'],energyToTank_W=reverse['E'],boronToTank_kg_s=reverse['B'],
    donor=reverseDonor,donorLiquidBoronFraction=.0005,receiverEquilibriumPhase=reverse['downstream']['x'])
extra=patch(liquid,receiver,.75,extra=2.+.5*3.**2)
base=patch(liquid,receiver,.75)
carriedDefect=extra['E']-base['E']-extra['m']*(2.+.5*3.**2)
guard(abs(carriedDefect)<1e-6,'Carried Q/tangential energy exactly once')
tangentIn=extra['m']*3.;tangentReaction=-tangentIn
guard(tangentIn+tangentReaction==0.,'Stationary turning reaction')
closed=patch(liquid,receiver,.75,opening=0.)
json.dump(dict(cases=cases,identicalPartitions=identical,reverse=reverseFlux,closed=closed,
    carriedEnergy=dict(tangentialVelocity_m_s=3.,liquidK_J_kg=2.,result=extra,
        energyDifferenceResidual_W=carriedDefect,inletTangentialMomentum_N=tangentIn,
        wallTangentialReaction_N=tangentReaction,externalMechanicalWork_W=0.),
    localMouthHandoffAdmitted=True,connectedTankTrajectoryQualified=False,
    versions=dict(Python=platform.python_version(),CoolProp=CoolProp.__version__)),sys.stdout,indent=2,allow_nan=False)
`

if (import.meta.main) {
  const [geometryPath, phaseParentPath, capParentPath, python, output] = process.argv.slice(2)
  if (!geometryPath || !phaseParentPath || !capParentPath || !python || !output)
    throw new Error('Usage: mouth-surface.ts geometry.md phase-path.json cap-interface.json python receipt.json')
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const sourceText = await Bun.file(import.meta.path).text()
  const dependencyNames = ['reference-design-cmt-geometry.ts', 'reference-design-cmt-phase-path.ts', 'reference-design-cmt-phase-series.ts']
  const dependencySources = await Promise.all(dependencyNames.map(async name =>
    [name, hash(await Bun.file(new URL(name, import.meta.url)).text())] as const))
  const geometry = parseGeometryBasis(await Bun.file(geometryPath).text()), g = tankGeometry(geometry)
  const phaseText = await Bun.file(phaseParentPath).text(), phase = phaseSeriesParent(JSON.parse(phaseText))
  if (JSON.stringify(phase.input.geometry) !== JSON.stringify(geometry)) throw new Error('Phase parent geometry differs')
  const capText = await Bun.file(capParentPath).text(), cap = JSON.parse(capText)
  if (JSON.stringify(cap.geometry) !== JSON.stringify(geometry) || cap.localInterfaceChecksPassed !== true)
    throw new Error('Cap parent geometry or local admission differs')
  const donorK = z.number().finite().nonnegative().parse(cap.basis.liquidDonorK_J_kg)
  const capCases = z.array(capCase).parse(cap.cases)
  const fractions = [0, 1e-8, 1e-4, .25, .75, 1]
  const radius = geometry.mouthDiameter_m / 2, curvature = 2
  const shapes = fractions.map(f => {
    const center = -f * radius * radius * curvature
    return { centerHeight_m: center, curvature_per_m: curvature,
      ...mouthIntersection(radius, center, curvature) }
  })
  const rotated = capCases.flatMap(c => [0, .5, 2].flatMap(slope => [0, .2].map(verticalSpeed => {
    const scale = Math.hypot(1, slope), n = [-slope / scale, 1 / scale], t = [1 / scale, slope / scale]
    const j = c.j_kg_m2s, wn = verticalSpeed / scale, tangent = 3
    const velocity = (rho: number) => [j / rho * n[0]! + tangent * t[0]!,
      verticalSpeed + j / rho * n[1]! + tangent * t[1]!]
    const ul = velocity(c.liquid.rho), uv = velocity(c.vapor.rho)
    const k = j > 0 ? donorK : 0
    const energy = (h: number, u: number[], p: number, retainedK: number, q: number) =>
      j * (h + (u[0]! ** 2 + u[1]! ** 2) / 2 + retainedK + 9.80665 * g.mouth) + p * wn + q
    const E = energy(c.liquid.h, ul, c.pl_Pa, k, c.heatLiquid_W_m2) - energy(c.vapor.h, uv, c.pv_Pa, 0, -c.heatVapor_W_m2)
    const momentum = n.map((normal, i) => j * (ul[i]! - uv[i]!) + (c.pl_Pa - c.pv_Pa) * normal)
    const lrate = surfaceRate(slope, ul[0]!, ul[1]!, j, c.liquid.rho)
    const vrate = surfaceRate(slope, uv[0]!, uv[1]!, j, c.vapor.rho)
    if (Math.abs(E) > 1e-5 || Math.max(...momentum.map(Math.abs)) > 1e-7 || Math.abs(lrate - vrate) > 1e-12)
      throw new Error('Rotated native surface flux/kinematics failed')
    return { pressure_Pa: c.pv_Pa, slope, verticalSpeed_m_s: verticalSpeed,
      liquidSurfaceRate_m_s: lrate, vaporSurfaceRate_m_s: vrate,
      energyResidual_W_m2: E, momentumResidual_Pa: momentum }
  })))
  const input = { ...phase.input, mouth: { elevation_m: g.mouth, fractions,
    effectiveArea_m2: phase.calibrations.find(c => c.name === 'isolation')!.effectiveArea_m2 } }
  const child = Bun.spawn([python, '-c', mouthCalculation], { stdin: new Response(JSON.stringify(input)), stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(stderr)
  if (sourceText !== await Bun.file(import.meta.path).text() || (await Promise.all(dependencyNames.map(async (name, i) =>
    hash(await Bun.file(new URL(name, import.meta.url)).text()) !== dependencySources[i]![1]))).some(Boolean))
    throw new Error('Source changed during the bounded mouth comparison')
  await Bun.write(output, JSON.stringify({ sourceHash: hash(sourceText), dependencySourceHashes: Object.fromEntries(dependencySources),
    calculationHash: hash(mouthCalculation), inputHash: hash(JSON.stringify(input)), phaseParentHash: hash(phaseText),
    capParentHash: hash(capText), input, shapes, rotated, ...JSON.parse(stdout) }, null, 2) + '\n')
}
