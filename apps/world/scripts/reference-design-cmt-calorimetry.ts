/** Offline closed-tank thermodynamic redistribution; not a mixing-rate model. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { cmtStratificationDefinitions, parseStratificationBasis } from './reference-design-cmt-stratification.ts'

const numeric = z.number().finite()
const schema = z.object({ minimumPressure_MPa: numeric.min(.100001), maximumPressure_MPa: numeric.max(29.9),
  minimumTemperature_C: numeric.min(5), maximumTemperature_C: numeric.max(150) }).strict().refine(x =>
  x.maximumPressure_MPa > x.minimumPressure_MPa && x.maximumTemperature_C > x.minimumTemperature_C, 'Empty calorimetric admission band')
export function parseCalorimetryBasis(document: string) {
  const blocks = [...document.matchAll(/^```reference-cmt-calorimetry\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw new Error('Expected one reference-cmt-calorimetry numeric block')
  return { ...parseStratificationBasis(document), calorimetry: schema.parse(JSON.parse(blocks[0]![1]!)) }
}

export const calorimetryCalculation = cmtStratificationDefinitions + String.raw`
from scipy.integrate import solve_ivp
from iapws.iapws97 import _TSat_P

def thermo(p,T):
    rho,u,*_=water(p,T)
    return rho,u,_Region1(T,p/1e6)['s']*1000

def integrate_profile(pt,temperatures,heights,area=10.,ztop=12.,tolerance=1e-11,property_function=thermo):
    # Independent hydrostatic integration, not the original midpoint store.
    # y = top-to-local pressure, cumulative M, U+PE, entropy.
    if not len(temperatures) or len(temperatures)!=len(heights) or area<=0 or not all(math.isfinite(v) for v in [pt,area,ztop,*temperatures,*heights]) or any(H<=0 for H in heights):
        raise ValueError('Invalid finite hydrostatic profile geometry/state')
    y=np.array([pt,0.,0.,0.]);depth=0.
    for T,H in zip(temperatures,heights):
        def rhs(d,y):
            rho,u,s=property_function(y[0],T)
            return [g*rho,area*rho,area*rho*(u+g*(ztop-d)),area*rho*s]
        solved=solve_ivp(rhs,(depth,depth+H),y,method='DOP853',rtol=tolerance,
            atol=[1e-5,1e-9,1e-3,1e-6])
        if not solved.success or not np.all(np.isfinite(solved.y[:,-1])):raise ValueError('Independent hydrostatic integration failed')
        y=solved.y[:,-1];depth+=H
    return dict(bottomPressure_Pa=float(y[0]),mass_kg=float(y[1]),energy_J=float(y[2]),entropy_J_K=float(y[3]),volume_m3=area*depth)

def homogenize(target,area,H,ztop):
    limits=b['calorimetry'];lo=limits['minimumPressure_MPa']*1e6;hi=limits['maximumPressure_MPa']*1e6
    evaluations=0
    def at_pressure(p):
        nonlocal evaluations
        tlo=limits['minimumTemperature_C']+273.15
        thi=min(limits['maximumTemperature_C']+273.15,_TSat_P(p/1e6)-1e-5 if p<22.064e6 else 623.149,623.149)
        def at_temperature(T):
            nonlocal evaluations
            evaluations+=1
            return integrate_profile(p,[T],[H],area,ztop)
        if thi<=tlo:return None
        a=at_temperature(tlo);c=at_temperature(thi)
        if (a['mass_kg']-target['mass_kg'])*(c['mass_kg']-target['mass_kg'])>0:return None
        T=brentq(lambda T:at_temperature(T)['mass_kg']-target['mass_kg'],tlo,thi,xtol=1e-10)
        return dict(temperature_K=T,topPressure_Pa=p,**at_temperature(T))
    lower=at_pressure(lo);upper=at_pressure(hi)
    if lower is None or upper is None:
        return dict(status='NO_MASS_BRACKET_AT_ADMISSION_ENDPOINT',lower=lower,upper=upper,evaluations=evaluations)
    ea=lower['energy_J']-target['energy_J'];ec=upper['energy_J']-target['energy_J']
    if ea*ec>0:
        return dict(status='NO_ENERGY_BRACKET_IN_ADMITTED_BAND',lowerEnergyDefect_J=ea,upperEnergyDefect_J=ec,evaluations=evaluations)
    def energy_residual(p):
        state=at_pressure(p)
        if state is None:raise ValueError('Homogenization lost its interior mass bracket')
        return state['energy_J']-target['energy_J']
    p=brentq(energy_residual,lo,hi,xtol=1e-3)
    final=at_pressure(p)
    dm=final['mass_kg']-target['mass_kg'];de=final['energy_J']-target['energy_J'];ds=final['entropy_J_K']-target['entropy_J_K']
    if abs(dm)>1e-5 or abs(de)>10 or ds < -1:raise ValueError('Homogenization mass/energy/entropy gate failed')
    return dict(status='ADMITTED_ISOLATED_EQUILIBRIUM',state=final,massResidual_kg=dm,energyResidual_J=de,
        entropyChange_J_K=ds,evaluations=evaluations)

def independent_checks():
    # Analytic constant-density column tests the actual quadrature and PE datum.
    rho=997.;T=313.15;u=4180*T;s=4180*math.log(T);area=10.;H=6.;pt=12e6
    a=integrate_profile(pt,[T],[H],area,12.,property_function=lambda p,t:(rho,u,s))
    checks=[]
    for name,value,expected,limit in [('hydrostatic_pressure',a['bottomPressure_Pa'],pt+rho*g*H,1e-5),
        ('mass',a['mass_kg'],rho*area*H,1e-6),('energy_and_gravity',a['energy_J'],rho*area*H*(u+g*9),.01),
        ('entropy',a['entropy_J_K'],rho*area*H*s,1e-5)]:
        error=abs(value-expected)
        if error>limit:raise ValueError('Independent column identity failed: '+name)
        checks.append(dict(name=name,error=error,limit=limit))
    # A uniform liquid profile must return itself, not create mixing entropy.
    target=integrate_profile(12e6,[313.15],[6.]);same=homogenize(target,10.,6.,12.)
    if same['status']!='ADMITTED_ISOLATED_EQUILIBRIUM':raise ValueError('Uniform identity has no admitted solution')
    if abs(same['state']['topPressure_Pa']-12e6)>1 or abs(same['state']['temperature_K']-313.15)>1e-6 or abs(same['entropyChange_J_K'])>1:
        raise ValueError('Uniform profile changed under homogenization')
    checks.append(dict(name='uniform_profile_identity',result=same))
    # Missing +/- interface work can cancel in a total ledger; this separate
    # differential identity exposes it for a fixed-mass moving material zone.
    M=1000.;A=10.;dV=.001;pI=12e6
    for name,centroid_sign,center_pressure in [('cold',1,pI+M*g/(2*A)),('hot',-1,pI-M*g/(2*A))]:
        internal=-pI*dV-centroid_sign*M*g*dV/(2*A)
        if abs(internal+center_pressure*dV)>1e-9:raise ValueError('Interface work/centroid identity failed')
        checks.append(dict(name=name+'_interface_work_identity',internalWork_J=internal,centerPressureWork_J=-center_pressure*dV))
    return checks

checks=independent_checks()
cases=[]
for name,nt in [('limited',b['topCells']),('limited_double_top',2*b['topCells'])]:
    original=study(name,nt,b['maximumStep_s'],True)
    snap=original['finalSnapshot'];Ts=snap['temperatures_K'];Hs=snap['heights_m'];pt=snap['topPressure_Pa']
    initial=integrate_profile(pt,Ts,Hs,snap['area_m2'],snap['topElevation_m'])
    tighter=integrate_profile(pt,Ts,Hs,snap['area_m2'],snap['topElevation_m'],tolerance=2e-12)
    quadrature=dict(massDifference_kg=tighter['mass_kg']-initial['mass_kg'],energyDifference_J=tighter['energy_J']-initial['energy_J'],
        entropyDifference_J_K=tighter['entropy_J_K']-initial['entropy_J_K'])
    if abs(quadrature['massDifference_kg'])>1e-5 or abs(quadrature['energyDifference_J'])>10:raise ValueError('Independent quadrature check failed')
    mixed=homogenize(initial,snap['area_m2'],sum(Hs),snap['topElevation_m'])
    midpoint_target=dict(mass_kg=snap['midpointMass_kg'],energy_J=snap['midpointEnergy_J'],entropy_J_K=snap['midpointEntropy_J_K'])
    midpoint_mixed=homogenize(midpoint_target,snap['area_m2'],sum(Hs),snap['topElevation_m'])
    cases.append(dict(name=name,sourceRun=original,independentInitial=initial,quadratureCheck=quadrature,
        midpointRepresentationDifference=dict(mass_kg=initial['mass_kg']-snap['midpointMass_kg'],
            energy_J=initial['energy_J']-snap['midpointEnergy_J'],entropy_J_K=initial['entropy_J_K']-snap['midpointEntropy_J_K']),
        midpointConstrainedHomogeneous=midpoint_mixed,
        homogeneousPressureFromRepresentationDifference_Pa=mixed['state']['topPressure_Pa']-midpoint_mixed['state']['topPressure_Pa']
            if mixed['status']==midpoint_mixed['status']=='ADMITTED_ISOLATED_EQUILIBRIUM' else None,
        homogeneous=mixed,pressureRedistribution_Pa=mixed['state']['topPressure_Pa']-pt if mixed['status']=='ADMITTED_ISOLATED_EQUILIBRIUM' else None))
print(json.dumps(dict(scope='Closed CMT calorimetry after isolation; no mixing rate or coupled pressure trajectory',checks=checks,cases=cases,
    originalCoupledPressureFrontQualified=False,movingInterfaceDynamicsImplemented=False)))
`

if (import.meta.main) {
  const [page, python] = process.argv.slice(2)
  if (!page || !python) throw new Error('Usage: reference-design-cmt-calorimetry.ts <wiki-page> <research-python>')
  const input = parseCalorimetryBasis(await Bun.file(page).text())
  const child = Bun.spawn([python, '-c', calorimetryCalculation], { stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (status !== 0) throw new Error(stderr)
  console.log(JSON.stringify({ input, inputHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
    calculationHash: createHash('sha256').update(calorimetryCalculation).digest('hex'), ...JSON.parse(stdout) }, null, 2))
}
