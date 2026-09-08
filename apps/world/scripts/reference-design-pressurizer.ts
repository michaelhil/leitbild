/** Offline finite pressurizer initialization and calorimetry, not a Plant runtime. */
import { createHash } from 'node:crypto'
import { z } from 'zod'

const positive = z.number().finite().positive()
const schema = z.object({ design: z.literal('LD-01'), volume_m3: positive, liquidVolume_m3: positive,
  area_m2: positive, bottomElevation_m: z.number().finite(), hotPortPressure_MPa: positive,
  minimumPressure_MPa: positive, maximumPressure_MPa: positive, heatIncrement_J: positive,
}).strict().refine(x => x.liquidVolume_m3 < x.volume_m3 && x.minimumPressure_MPa < x.hotPortPressure_MPa &&
  x.hotPortPressure_MPa < x.maximumPressure_MPa && x.maximumPressure_MPa <= 16,
  'Expected two-phase geometry and an ordered subcritical research pressure band at or below 16 MPa')

export function parsePressurizerBasis(document: string) {
  const blocks = [...document.matchAll(/^```reference-pressurizer\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw Error('Expected exactly one reference-pressurizer block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}

export const pressurizerCalculation = String.raw`
import json,sys,platform,iapws
from iapws import IAPWS97,IAPWS95
from scipy.optimize import brentq
b=json.load(sys.stdin);g=9.80665
V=b['volume_m3'];A=b['area_m2'];z0=b['bottomElevation_m']
lo=b['minimumPressure_MPa'];hi=b['maximumPressure_MPa']

def run(W):
    def phases(p):return W(P=p,x=0),W(P=p,x=1)
    def state(p,vl,datum=z0):
        if not 0<vl<V:raise ValueError('Outside two-phase admission: no phase clipping')
        f,v=phases(p);ml=vl*f.rho;mv=(V-vl)*v.rho
        zl=datum+vl/(2*A);zv=datum+(vl+V)/(2*A)
        u=1000*(ml*f.u+mv*v.u);pe=g*(ml*zl+mv*zv)
        return dict(pressure_MPa=p,temperature_K=f.T,liquidVolume_m3=vl,height_m=vl/A,
            mass_kg=ml+mv,liquidMass_kg=ml,vaporMass_kg=mv,internalEnergy_J=u,potentialEnergy_J=pe,
            energy_J=u+pe,bottomPressure_MPa=p+f.rho*g*vl/A/1e6)
    p=brentq(lambda p:state(p,b['liquidVolume_m3'])['bottomPressure_MPa']-b['hotPortPressure_MPa'],lo,hi,xtol=1e-11)
    initial=state(p,b['liquidVolume_m3'])
    def flash(m,e,datum=z0):
        def at(p):
            f,v=phases(p);vl=(m-V*v.rho)/(f.rho-v.rho)
            return state(p,vl,datum)
        def residual(p):return at(p)['energy_J']-e
        # Bounded branch inversion only. An inadmissible endpoint rejects this
        # research case; no extrapolation, clipping or generic phase fallback.
        a,c=residual(lo),residual(hi)
        if a*c>0:raise ValueError('No admitted energy root')
        result=at(brentq(residual,lo,hi,xtol=1e-11))
        if abs(result['mass_kg']-m)>1e-7 or abs(result['energy_J']-e)>.1:raise ValueError('Conservative inversion failed')
        return result
    recovered=flash(initial['mass_kg'],initial['energy_J'])
    if abs(recovered['pressure_MPa']-p)>1e-8 or abs(recovered['liquidVolume_m3']-b['liquidVolume_m3'])>1e-7:raise ValueError('Roundtrip failed')
    cases=[]
    for sign in [-1,1]:
        q=sign*b['heatIncrement_J'];final=flash(initial['mass_kg'],initial['energy_J']+q)
        if sign*(final['pressure_MPa']-p)<=0:raise ValueError('Unexpected local equilibrium heat response')
        cases.append(dict(heatAdded_J=q,state=final,energyResidual_J=final['energy_J']-initial['energy_J']-q,
            massResidual_kg=final['mass_kg']-initial['mass_kg']))
    # Changing a common elevation origin must not change the physical flash.
    shift=100.;shifted=flash(initial['mass_kg'],initial['energy_J']+initial['mass_kg']*g*shift,z0+shift)
    if abs(shifted['pressure_MPa']-p)>1e-8 or abs(shifted['liquidVolume_m3']-b['liquidVolume_m3'])>1e-7:raise ValueError('Energy datum dependence')
    rejected=0
    for m,e in [(1.,initial['energy_J']),(1e9,initial['energy_J']),
                (initial['mass_kg'],initial['energy_J']+1e12),(initial['mass_kg'],initial['energy_J']-1e12)]:
        try:flash(m,e)
        except ValueError:rejected+=1
    if rejected!=4:raise ValueError('Invalid branch was silently admitted')
    return dict(formulation=W.__name__,initial=initial,roundTripPressureError_Pa=(recovered['pressure_MPa']-p)*1e6,
        datumShiftPressureError_Pa=(shifted['pressure_MPa']-p)*1e6,cases=cases,invalidCasesRejected=rejected)

results=[run(IAPWS97),run(IAPWS95)]
a,c=[r['initial'] for r in results]
print(json.dumps(dict(scope='Isolated two-phase lumped PZR initialization and fixed-mass calorimetry; no connected dynamics',
    python=platform.python_version(),iapws=iapws.__version__,results=results,
    formulationDifference=dict(pressure_Pa=(c['pressure_MPa']-a['pressure_MPa'])*1e6,
        mass_kg=c['mass_kg']-a['mass_kg'],energy_J=c['energy_J']-a['energy_J'])),allow_nan=False))
`

if (import.meta.main) {
  const [page, python] = process.argv.slice(2)
  if (!page || !python) throw Error('Usage: reference-design-pressurizer.ts <wiki-page> <research-python>')
  const input = parsePressurizerBasis(await Bun.file(page).text())
  const child = Bun.spawn([python, '-c', pressurizerCalculation], { stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (status !== 0) throw Error(stderr)
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  console.log(JSON.stringify({ input, inputHash: hash(JSON.stringify(input)), calculationHash: hash(pressurizerCalculation), ...JSON.parse(stdout) }, null, 2))
}
