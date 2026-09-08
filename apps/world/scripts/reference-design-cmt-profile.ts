/** Offline source-profile discrimination and exact restricted transport; no coupled CMT model. */
import { createHash } from 'node:crypto'
import { z } from 'zod'

const finite=z.number().finite()
const schema=z.object({height_m:finite.positive(),cold_C:finite,hot_C:finite,
  pressures_MPa:z.array(finite.min(2).max(4.3)).min(3),
  readingTemperature_K:finite.positive(),readingHeight_m:finite.positive(),
  points:z.array(z.tuple([finite,finite])).min(3)}).strict().superRefine((b,ctx)=>{
    if(b.hot_C<=b.cold_C||b.points.some(([T,h])=>T<b.cold_C||T>b.hot_C||h<0||h>b.height_m))
      ctx.addIssue({code:'custom',message:'Invalid profile geometry or temperature ordering'})
  })
export function parseProfileBasis(document:string) {
  const blocks=[...document.matchAll(/^```reference-cmt-profile\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw new Error('Expected one reference-cmt-profile numeric block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}

export const profileCalculation=String.raw`
import json,sys,math
import numpy as np
from scipy.integrate import quad
from scipy.optimize import linprog,brentq
from iapws.iapws97 import _Region1,_TSat_P
b=json.load(sys.stdin)

def fit_rectangles(points,F,cold,hot,dT,dz,height):
    # z(T)=a+w*F(T), a=transition bottom, w=transition height.
    # At a plateau the inverse is an interval, not a single height.
    rows=[];rhs=[]
    for T,z in points:
        if T-dT>cold:rows.append([1.,F(T-dT),-1.]);rhs.append(z+dz)
        if T+dT<hot:rows.append([-1.,-F(T+dT),-1.]);rhs.append(-z+dz)
    rows.append([1.,1.,0.]);rhs.append(height)
    A=np.array(rows);r=np.array(rhs)
    sol=linprog([0,0,1],A_ub=A,b_ub=r,bounds=[(0,height),(0,height),(0,None)],method='highs')
    if not sol.success or not np.all(np.isfinite(sol.x)):raise ValueError('Profile LP failed')
    primal=float(max(0.,np.max(A@sol.x-r)))
    # HiGHS dual provides an independent certificate of the minimum added slack.
    dual=float(r@sol.ineqlin.marginals + np.array([0,0,0])@sol.lower.marginals)
    # Upper bounds a,w<=height have zero marginal here, but include them explicitly.
    dual+=float(height*(sol.upper.marginals[0]+sol.upper.marginals[1]))
    gap=abs(float(sol.fun)-dual)
    if primal>1e-8 or gap>1e-8:raise ValueError('LP feasibility/duality check failed')
    return dict(bottom_m=float(sol.x[0]),width_m=float(sol.x[1]),
        additionalHeightAllowance_m=float(sol.x[2]),withinDeclaredReadingRectangles=bool(sol.x[2]<=1e-8),
        primalResidual_m=primal,dualityGap_m=gap)

# Independent exact affine-profile feasibility and deliberately inconsistent rectangles.
F=lambda T:T/100.
identity=fit_rectangles([[20,.6],[50,.9],[80,1.2]],F,0,100,0,0,2)
rejected=fit_rectangles([[20,.6],[50,.61],[80,1.2]],F,0,100,0,0,2)
if abs(identity['bottom_m']-.4)>1e-8 or abs(identity['width_m']-1)>1e-8 or identity['additionalHeightAllowance_m']>1e-8:
    raise ValueError('Analytical affine identity failed')
if abs(rejected['additionalHeightAllowance_m']-.145)>1e-8:raise ValueError('Analytical minimax rejection failed')

cases=[]
for p in b['pressures_MPa']:
    if b['hot_C']+273.15>=_TSat_P(p):raise ValueError('Source profile outside admitted liquid domain')
    def compute(eps):
        def integrand(T):
            q=_Region1(T+273.15,p)
            return q['v']*q['cp'] # common kJ/J factor cancels in the normalized integral
        full=quad(integrand,b['cold_C'],b['hot_C'],epsabs=eps,epsrel=eps)[0]
        def fraction(T):
            return quad(integrand,b['cold_C'],T,epsabs=eps,epsrel=eps)[0]/full
        result=fit_rectangles(b['points'],fraction,b['cold_C'],b['hot_C'],
            b['readingTemperature_K'],b['readingHeight_m'],b['height_m'])
        result['heightFractionsForLinearMassEnthalpy']=[dict(temperature_C=T,fraction=fraction(T)) for T,z in b['points']]
        return result
    coarse=compute(1e-8);fine=compute(1e-11)
    difference=max(abs(fine[k]-coarse[k]) for k in ['bottom_m','width_m','additionalHeightAllowance_m'])
    if difference>1e-7:raise ValueError('Independent quadrature comparison failed')
    cases.append(dict(pressure_MPa=p,**fine,quadratureDifference_m=difference))

# Two plateaus alone require every non-plateau rectangle to meet the same interface.
interior=[z for T,z in b['points'] if T-b['readingTemperature_K']>b['cold_C'] and T+b['readingTemperature_K']<b['hot_C']]
step_gap=max(interior)-min(interior)-2*b['readingHeight_m'] if interior else 0.

# One independent transport verification: fixed pressure, zero gravity, variable volumes.
# H=U+pV; the explicitly supported pressure boundary supplies -p*dV work.
# These 60 kg are not a 60 m3 tank or a replay of the measured GDE-43 transient.
p=3.15
def props(T):return _Region1(T+273.15,p)
hc=props(20)['h']*1000;hh=props(200)['h']*1000
def v_h(h):
    T=brentq(lambda T:props(T)['h']*1000-h,0,210,xtol=1e-10)
    return props(T)['v']
vtrans=quad(v_h,hc,hh,epsabs=1e-10)[0]/(hh-hc)
initial=dict(coldMass=20.,transitionMass=10.,hotMass=30.,hotH=30*hh,
    sourceMass=10.,sourceH=10*hh,receiverMass=5.,receiverH=5*hc)
area=.01
aperture=(4.,4.1) # m above this separate pressure-supported transport vessel's bottom
def hot_extent(x):
    lower=(x['coldMass']*v_h(hc)+x['transitionMass']*vtrans)/area
    return lower,lower+x['hotMass']*v_h(x['hotH']/x['hotMass'])/area
def update(old,q,donor_h,opening=aperture):
    if not math.isfinite(q) or q<=0:raise ValueError('Only positive net displacement admitted')
    lo,hi=hot_extent(old)
    if not lo<=opening[0]<opening[1]<=hi:raise ValueError('Aperture outside hot region: redistribution unsupported')
    if donor_h < old['hotH']/old['hotMass']-1e-8:raise ValueError('Cooler inlet requires redistribution')
    if abs(donor_h-old['hotH']/old['hotMass'])>1e-8:raise ValueError('Changing hot endpoint outside matched-inlet reference')
    if abs(donor_h-old['sourceH']/old['sourceMass'])>1e-8:raise ValueError('Donor does not match finite source')
    if q>=old['coldMass'] or q>=old['sourceMass']:raise ValueError('Region/source exhaustion outside this update')
    x=old.copy();x['coldMass']-=q;x['hotMass']+=q;x['hotH']+=q*donor_h
    x['sourceMass']-=q;x['sourceH']-=q*donor_h;x['receiverMass']+=q;x['receiverH']+=q*hc
    lo,hi=hot_extent(x)
    if not lo<=opening[0]<opening[1]<=hi:raise ValueError('Transfer crosses aperture envelope')
    return x
def inventory(x):
    H=(x['coldMass']*hc+x['transitionMass']*(hc+hh)/2+x['hotH']+x['sourceH']+x['receiverH'])
    V=((x['coldMass']+x['receiverMass'])*v_h(hc)+x['transitionMass']*vtrans+
       x['hotMass']*v_h(x['hotH']/x['hotMass'])+x['sourceMass']*v_h(x['sourceH']/x['sourceMass']))
    return sum(x[k] for k in ['coldMass','transitionMass','hotMass','sourceMass','receiverMass']),H,V,H-p*1e6*V
def point(x,m):
    if not 0<=m<=x['coldMass']+x['transitionMass']+x['hotMass']:raise ValueError('Point outside tank material')
    if m<=x['coldMass']:return hc
    if m>=x['coldMass']+x['transitionMass']:return x['hotH']/x['hotMass']
    return hc+(hh-hc)*(m-x['coldMass'])/x['transitionMass']
oldInv=inventory(initial);transport=[]
for count in [1,8]:
    x=initial.copy()
    for _ in range(count):x=update(x,2.5/count,hh)
    inv=inventory(x)
    analytical=initial.copy();analytical.update(coldMass=17.5,hotMass=32.5,hotH=32.5*hh,
        sourceMass=7.5,sourceH=7.5*hh,receiverMass=7.5,receiverH=7.5*hc)
    massError=max(abs(x[k]-analytical[k]) for k in x if k.endswith('Mass'))
    energyError=max(abs(x[k]-analytical[k]) for k in x if k.endswith('H'))
    points=[10.,18.,22.,27.,35.]
    pointError=max(abs(point(x,m)-point(initial,m+2.5)) for m in points)
    tankV0=20*v_h(hc)+10*vtrans+30*v_h(hh)
    tankV1=x['coldMass']*v_h(hc)+10*vtrans+x['hotMass']*v_h(x['hotH']/x['hotMass'])
    dV=tankV1-tankV0;dH=2.5*(hh-hc);dU=dH-p*1e6*dV
    if massError>1e-10 or energyError>1e-6 or pointError>1e-7 or abs(inv[0]-oldInv[0])>1e-10 or abs(inv[1]-oldInv[1])>1e-6:
        raise ValueError('Exact restricted transport check failed')
    transport.append(dict(steps=count,transferredMass_kg=2.5,stateMassError_kg=massError,stateEnthalpyError_J=energyError,
        pointEnthalpyError_J_kg=pointError,totalMassError_kg=inv[0]-oldInv[0],totalEnthalpyError_J=inv[1]-oldInv[1],
        tankVolumeChange_m3=dV,tankEnthalpyChange_J=dH,tankInternalEnergyChange_J=dU,
        externalPressureWorkOnTank_J=-p*1e6*dV,final=x))
guards=0
lo,hi=hot_extent(initial)
for q,h,opening in [(10,hh,aperture),(2.5,hc,aperture),(2.5,hh+1000,aperture),(2.5,hh,(lo-.05,lo+.05))]:
    try:update(initial,q,h,opening)
    except ValueError:guards+=1
    else:raise ValueError('Unsupported transfer was silently accepted')
print(json.dumps(dict(scope='Isobaric measured-profile representability and exact restricted enthalpy transport',
    analyticalChecks=dict(identity=identity,rejection=rejected),cases=cases,
    twoPlateauInterfaceGap_m=step_gap,twoPlateauProfileAccepted=bool(step_gap<=0),
    restrictedTransport=transport,transportArea_m2=area,transportAperture_m=aperture,rejectedUnsupportedCases=guards,
    measuredProfileAcceptedAtAllTestedPressures=all(c['withinDeclaredReadingRectangles'] for c in cases),
    coupledPressureQualified=False,physicalRedistributionQualified=False,withheldProfileAvailable=False)))
`

if(import.meta.main) {
  const [page,python]=process.argv.slice(2)
  if(!page||!python)throw new Error('Usage: reference-design-cmt-profile.ts <wiki-page> <python>')
  const input=parseProfileBasis(await Bun.file(page).text())
  const child=Bun.spawn([python,'-c',profileCalculation],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'})
  const [out,err,status]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  if(status!==0)throw new Error(err)
  console.log(JSON.stringify({input,inputHash:createHash('sha256').update(JSON.stringify(input)).digest('hex'),
    calculationHash:createHash('sha256').update(profileCalculation).digest('hex'),...JSON.parse(out)},null,2))
}
