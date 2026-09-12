/** Bounded pure-water HEM constriction selection; no connected time integration. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parseGeometryBasis } from './reference-design-cmt-geometry.ts'
import { parseBalancePathBasis, checkBalancePath, checkConnectedMeters } from './reference-design-cmt-balance-path.ts'
import { deliveryBasis } from './reference-design-cmt-delivery.ts'
import { parseObservationFixtureBasis } from './reference-design-observations.ts'

const schema = z.object({ openCheckLoss_Pa: z.literal(250), pressure_Pa: z.literal(5e6),
  steamSuperheat_K: z.literal(20), mixedQuality: z.literal(.2), boronLiquidFraction: z.literal(.002), cmtRawDPSpan_Pa: z.literal(8000) }).strict()
export function parsePhasePathBasis(document: string) {
  const blocks = [...document.matchAll(/^```reference-cmt-phase-path\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw new Error('Expected one reference-cmt-phase-path block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}
export function allocateOpenCheck(remainder_Pa: number, check_Pa: number) {
  if (![remainder_Pa, check_Pa].every(Number.isFinite) || check_Pa <= 0 || remainder_Pa <= check_Pa)
    throw new Error('Physical open-check loss exhausts isolation allocation')
  return { openCheck_Pa: check_Pa, isolation_Pa: remainder_Pa - check_Pa, combined_Pa: remainder_Pa }
}

export const phasePathCalculation = String.raw`
import json,sys,math,platform
import CoolProp,CoolProp.CoolProp as C
import numpy as np
from scipy.optimize import brentq,minimize_scalar
d=json.load(sys.stdin);b=d['basis'];A=math.pi*d['bore_m']**2/4
w=C.AbstractState('HEOS','Water')
def guard(ok,name):
    if not ok:raise ValueError(name)
def snapshot():
    phase=w.phase();quality=w.Q()
    x=quality if phase==C.iphase_twophase else 0. if phase==C.iphase_liquid else 1. if phase in [C.iphase_gas,C.iphase_supercritical_gas] else None
    guard(x is not None and 0<=x<=1,'Unsupported water branch')
    return dict(p=w.p(),rho=w.rhomass(),h=w.hmass(),s=w.smass(),T=w.T(),x=x)
def ps(p,s):
    w.update(C.PSmass_INPUTS,p,s);return snapshot()
def pt(p,T,phase=None):
    # The downstream branch is already selected relative to its saturation endpoints.
    # Specify that stable branch rather than asking PT to classify a near-saturation bracket.
    if phase is not None:w.specify_phase(phase)
    try:
        w.update(C.PT_INPUTS,p,T);return snapshot()
    finally:w.unspecify_phase()
def pq(p,x):
    w.update(C.PQ_INPUTS,p,x);return snapshot()
def sound(q):
    # Only an admission diagnostic, not a derivative in the flow law.
    dp=5.;derivative=(ps(q['p']+dp,q['s'])['rho']-ps(q['p']-dp,q['s'])['rho'])/(2*dp)
    guard(derivative>0,'Nonpositive equilibrium compressibility')
    return 1/math.sqrt(derivative)
nodes,weights=np.polynomial.legendre.leggauss(16)
def throat(up,H,bp,pressureIntegral=False):
    # Subsonic inlet: a<A makes the inlet endpoint insufficient at a positive root.
    # Locate every sampled interior maximum, then refine it; endpoints are retained.
    lo=math.log(bp);hi=math.log(up['p'])
    def evaluate(y):
        p=up['p'] if y==hi else math.exp(y);q=up if y==hi else ps(p,up['s'])
        if pressureIntegral:
            half=(up['p']-p)/2;mid=(up['p']+p)/2
            dh=H-up['h']+half*sum(float(weight)/ps(mid+half*float(node),up['s'])['rho'] for node,weight in zip(nodes,weights))
        else:dh=H-q['h']
        guard(dh>=-1e-6,'Isentropic expansion has negative available energy')
        return q['rho']*math.sqrt(max(0.,2*dh)),q
    grid=[lo+(hi-lo)*i/24 for i in range(25)];values=[evaluate(y)[0] for y in grid]
    candidates=[(values[0],lo),(values[-1],hi)]
    peaks=0
    for i in range(1,24):
        if values[i]>=values[i-1] and values[i]>=values[i+1]:
            peaks+=1;r=minimize_scalar(lambda y:-evaluate(y)[0],bounds=(grid[i-1],grid[i+1]),method='bounded',options=dict(xatol=1e-12))
            guard(r.success,'Throat maximization status');candidates.append((-r.fun,r.x))
    guard(peaks<=1,'Multiple throat extrema outside selected simple branch')
    G,y=max(candidates);q=evaluate(y)[1]
    return G,q,bool(abs(y-lo)>1e-7)
def downstream(p,H,m):
    # Forward T/quality coordinates avoid treating a property sentinel as mixture.
    f=pq(p,0);g=pq(p,1)
    def residual(q):return q['h']+.5*(m/(A*q['rho']))**2-H
    if residual(f)<=0<=residual(g):
        x=brentq(lambda x:residual(pq(p,x)),0,1,xtol=1e-14);q=pq(p,x)
    elif residual(f)>0:
        T=brentq(lambda T:residual(pt(p,T,C.iphase_liquid)),273.17,f['T']-1e-7,xtol=1e-10);q=pt(p,T,C.iphase_liquid)
    else:
        T=brentq(lambda T:residual(pt(p,T,C.iphase_gas)),g['T']+1e-7,1073.15,xtol=1e-10);q=pt(p,T,C.iphase_gas)
    guard(abs(residual(q))<1e-5,'Downstream total-enthalpy closure')
    return q,residual(q)
def capacity(up,pd,a,crack=0.,pressureIntegral=False):
    guard(0<a<A and 0<pd and pd+crack<up['p'],'No open constriction domain')
    def residual(m):
        H=up['h']+.5*(m/(A*up['rho']))**2
        G,q,choked=throat(up,H,pd+crack,pressureIntegral)
        return m-a*G
    hi=.95*up['rho']*A*sound(up)
    guard(residual(hi)>0,'No subsonic inlet capacity root')
    m=brentq(residual,0,hi,xtol=1e-10);H=up['h']+.5*(m/(A*up['rho']))**2
    G,t,choked=throat(up,H,pd+crack,pressureIntegral);down,energyResidual=downstream(pd,H,m)
    guard(abs(m-a*G)<1e-7 and down['s']>=up['s']-1e-8,'Capacity or entropy gate')
    vu=m/(A*up['rho']);vd=m/(A*down['rho']);vj=G/t['rho']
    pin=A*up['p']+m*vu;pout=A*pd+m*vd
    # Internal contracted jet thrust is balanced by the stationary recovery body.
    jetMomentum=pd*A+m*vj+(t['p']-pd)*a
    contractionReaction=jetMomentum-pin;recoveryReaction=pout-jetMomentum
    guard(abs(contractionReaction+recoveryReaction-(pout-pin))<1e-7,'Two-face momentum reaction')
    downstreamMach=vd/sound(down)
    return dict(admitted=downstreamMach<1,admissionFailure=None if downstreamMach<1 else 'Downstream full-bore recovery is not subsonic',
        m=m,H=H,up=up,down=down,throat=t,choked=choked,vu=vu,vd=vd,vj=vj,
        inletMomentum_N=pin,outletMomentum_N=pout,wallReaction_N=pout-pin,
        internalJetPressureThrust_N=(t['p']-pd)*a,contractionReaction_N=contractionReaction,
        recoveryReaction_N=recoveryReaction,capacityResidual_kg_s=m-a*G,
        enthalpyResidual_J_kg=energyResidual,entropyProduction_W_K=m*(down['s']-up['s']),
        returnedThroatEnthalpyDefect_J_kg=t['h']+.5*vj*vj-H,
        inletMach=vu/sound(up),outletMach=downstreamMach)
def signed_device(left,right,a,alpha,healthy=False,pressureIntegral=False):
    guard(0<=alpha<=1 and 0<a<A,'Invalid physical device opening')
    dp=left['p']-right['p'];crack=d['checkCrack_Pa'] if healthy else 0.
    if alpha==0 or (healthy and dp<=crack) or dp==0:
        return dict(admitted=True,donor=None,massFlow_kg_s=0.,energyFlow_W=0.,boronFlow_kg_s=0.,
            leftMomentum_N=A*left['p'],rightMomentum_N=A*right['p'],result=None)
    sign=1 if dp>0 else -1;up,down=(left,right) if sign>0 else (right,left)
    r=capacity(up,down['p'],alpha*a,crack,pressureIntegral);m=sign*r['m']
    return dict(admitted=r['admitted'],donor='left' if sign>0 else 'right',massFlow_kg_s=m,
        energyFlow_W=m*r['H'],boronFlow_kg_s=m*(1-up['x'])*b['boronLiquidFraction'],
        leftMomentum_N=r['inletMomentum_N'] if sign>0 else r['outletMomentum_N'],
        rightMomentum_N=r['outletMomentum_N'] if sign>0 else r['inletMomentum_N'],result=r)
calibrations=[]
for dev in d['devices']:
    up=pt(15.2e6,dev['referenceT_K']);m=dev['referenceFlow_kg_s'];pd=up['p']-dev['loss_Pa']
    H=up['h']+.5*(m/(A*up['rho']))**2;G,t,choked=throat(up,H,pd)
    a=m/G;guard(0<a<A and not choked,'Reference effective throat is not physical/subcritical')
    r=capacity(up,pd,a);guard(r['admitted'] and abs(r['m']-m)<1e-6,'Finite-bore reference calibration')
    calibrations.append(dict(**dev,effectiveArea_m2=a,areaFraction=a/A,flowRecovered_kg_s=r['m'],result=r))
lookup={q['name']:q for q in calibrations}
Ts=pq(b['pressure_Pa'],1)['T']
states=[('liquid',pt(b['pressure_Pa'],313.15)),('steam',pt(b['pressure_Pa'],Ts+b['steamSuperheat_K'])),('mixed',pq(b['pressure_Pa'],b['mixedQuality']))]
cases=[]
for name,up in states:
    for ratio in [.99,.2]:
        for dev in ['isolation','CMT-meter']:
            a=lookup[dev]['effectiveArea_m2']
            try:r=capacity(up,ratio*up['p'],a)
            except ValueError as error:
                cases.append(dict(state=name,device=dev,receiverRatio=ratio,up=up,result=None,admitted=False,error=str(error)));continue
            # Same physical solution mirrored. Neither donor h nor B is copied from the receiver.
            cB=(1-up['x'])*b['boronLiquidFraction']
            cases.append(dict(state=name,device=dev,receiverRatio=ratio,result=r,admitted=r['admitted'],
                forward=dict(mass_kg_s=r['m'],energy_W=r['m']*r['H'],boron_kg_s=r['m']*cB),
                reverse=dict(mass_kg_s=-r['m'],energy_W=-r['m']*r['H'],boron_kg_s=-r['m']*cB),
                meter=None if dev!='CMT-meter' else dict(processDP_Pa=up['p']-ratio*up['p'],rawSpanMagnitude_Pa=b['cmtRawDPSpan_Pa'],
                    overrange=(up['p']-ratio*up['p'])>b['cmtRawDPSpan_Pa'],
                    unboundedCalibrationArithmetic_kg_s=math.sqrt((up['p']-ratio*up['p'])/lookup['CMT-meter']['loss_Pa'])*25)))
threshold=[];up=states[1][1];a=lookup['check']['effectiveArea_m2'];crack=d['checkCrack_Pa']
for excess in [-1.,0.,.001,1.]:
    pd=up['p']-crack-excess
    r=signed_device(up,pt(pd,313.15),a,1.,True)
    threshold.append(dict(excessOverCrack_Pa=excess,seated=excess<=0,**r))
openings=[];up=states[1][1]
for alpha in [0.,1e-6,.5,1.]:
    r=signed_device(up,pt(.99*up['p'],313.15),lookup['isolation']['effectiveArea_m2'],alpha)
    openings.append(dict(alpha=alpha,**r))
guard(openings[1]['massFlow_kg_s']/openings[-1]['massFlow_kg_s']<2e-6,'Vanishing achieved area')
left=pt(.99*b['pressure_Pa'],313.15);right=states[1][1]
failed=signed_device(left,right,a,1.);healthyReverse=signed_device(left,right,a,1.,True)
guard(failed['donor']=='right' and failed['massFlow_kg_s']<0 and failed['boronFlow_kg_s']==0 and healthyReverse['massFlow_kg_s']==0,'Actual signed donor and failed-open check')
stableThreshold=[]
for excess in [.001,1.]:
    r=capacity(up,up['p']-crack-excess,a,crack,True)
    incompressibleLimit=a*math.sqrt(2*up['rho']*excess/(1-(a/A)**2))
    stableThreshold.append(dict(excessOverCrack_Pa=excess,result=r,smallHeadLimit_kg_s=incompressibleLimit,
        relativeSmallHeadDifference=r['m']/incompressibleLimit-1))
json.dump(dict(calibrations=calibrations,cases=cases,threshold=threshold,openings=openings,
    stableThreshold=stableThreshold,
    failedOpenReverse=failed,healthyReverse=healthyReverse,
    stationaryPhasePathAdmitted=all(q['admitted'] for q in cases),connectedTransportQualified=False,submergedSteamAdmissionSelected=False,
    versions=dict(Python=platform.python_version(),CoolProp=CoolProp.__version__)),sys.stdout,indent=2,allow_nan=False)
`

if (import.meta.main) {
  const [geometryPath, injectionPath, observationPath, transportPath, python, output] = process.argv.slice(2)
  if (!geometryPath || !injectionPath || !observationPath || !transportPath || !python || !output)
    throw new Error('Usage: phase-path.ts geometry.md injection.md observations.md transport.md python output.json')
  const gdoc = await Bun.file(geometryPath).text()
  const geometry = parseGeometryBasis(gdoc), path = parseBalancePathBasis(gdoc)
  const delivery = deliveryBasis(await Bun.file(injectionPath).text())
  const observations = parseObservationFixtureBasis(await Bun.file(observationPath).text())
  const basis = parsePhasePathBasis(await Bun.file(transportPath).text())
  const meter = checkConnectedMeters(geometry, path, delivery, observations)
  const allocation = allocateOpenCheck(meter.allocations.CMT.remainder_Pa, basis.openCheckLoss_Pa)
  const balance = checkBalancePath(geometry, path)
  const devices = [
    { name: 'BAL-isolation', loss_Pa: balance.balanceSizing.fictionalRemainder_Pa, referenceFlow_kg_s: 25, referenceT_K: 563.15 },
    { name: 'isolation', loss_Pa: allocation.isolation_Pa, referenceFlow_kg_s: 25, referenceT_K: 313.15 },
    { name: 'check', loss_Pa: allocation.openCheck_Pa, referenceFlow_kg_s: 25, referenceT_K: 313.15 },
    { name: 'CMT-meter', loss_Pa: meter.allocations.CMT.meter_Pa, referenceFlow_kg_s: 25, referenceT_K: 313.15 },
    { name: 'DVI-meter', loss_Pa: meter.allocations.DVI.meter_Pa, referenceFlow_kg_s: 100, referenceT_K: 313.15 },
  ]
  const input = { geometry, path, delivery, observations, basis, allocation, balance, bore_m: delivery.bore_m,
    checkCrack_Pa: delivery.checkCrack_Pa, devices }
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const sourceHash = hash(await Bun.file(import.meta.path).text()), calculationHash = hash(phasePathCalculation)
  const dependencyHashes: Record<string, string> = {}
  for (const name of ['geometry', 'balance-path', 'delivery']) dependencyHashes[name] = hash(await Bun.file(new URL(`./reference-design-cmt-${name}.ts`, import.meta.url)).text())
  dependencyHashes.observations = hash(await Bun.file(new URL('./reference-design-observations.ts', import.meta.url)).text())
  const inputHash = hash(JSON.stringify(input))
  const child = Bun.spawn([python, '-c', phasePathCalculation], { stdin: new Response(JSON.stringify(input)), stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(stderr)
  await Bun.write(output, JSON.stringify({ sourceHash, calculationHash, inputHash, dependencyHashes, input, ...JSON.parse(stdout) }, null, 2) + '\n')
}
