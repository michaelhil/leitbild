/** Offline held-liquid hydraulics and finite material transactions, not a PZR trajectory. */
import { createHash } from 'node:crypto'
import { logDarcyFactor } from './reference-design-surge-route'

export const controlledSprayBasis = {
  length_m: 25, diameter_m: 0.1, wall_m: 0.01, roughness_m: 0.0000015,
  sourceElevation_m: 3, nozzleElevation_m: 18.5, ringRadius_m: 0.6,
  route: 'straight equivalent z(s)=3+15.5*s/25; no extra bend/header/tip storage',
  valveCdA_m2: 0.0011584536025922127, tips: 16, tipDiameter_m: 0.012,
  tipWaterFlow_m3_s: 0.00125, tipReferenceDrop_Pa: 200000, halfCone_rad: Math.PI / 12,
} as const

export function heldSprayFlow(input: { density: number; viscosity: number; sourcePressure: number; receiverPressure: number; opening: number; activeTips: number }) {
  const b = controlledSprayBasis
  for (const value of [input.density, input.viscosity, input.sourcePressure, input.receiverPressure]) if (!Number.isFinite(value) || value <= 0) throw Error('Invalid held liquid state')
  if (!Number.isFinite(input.opening) || input.opening < 0 || input.opening > 1 || !Number.isInteger(input.activeTips) || input.activeTips < 0 || input.activeTips > b.tips) throw Error('Invalid hardware setting')
  const area = Math.PI * b.diameter_m ** 2 / 4
  const nozzleCdA = input.activeTips * b.tipWaterFlow_m3_s * Math.sqrt(1000 / (2 * b.tipReferenceDrop_Pa))
  const head = input.sourcePressure - input.receiverPressure - input.density * 9.80665 * (b.nozzleElevation_m - b.sourceElevation_m)
  if (!input.opening || !input.activeTips || head <= 0) return { flow_kg_s: 0, availableAfterElevation_Pa: head, valveDrop_Pa: 0, lineDrop_Pa: 0, nozzleDrop_Pa: 0, residual_Pa: 0, exitVelocity_m_s: 0 }
  function losses(q: number) {
    if (!q) return { valve: 0, line: 0, nozzle: 0 }
    const velocity = q / (input.density * area)
    const re = input.density * velocity * b.diameter_m / input.viscosity
    return {
      valve: q ** 2 / (2 * input.density * (input.opening * b.valveCdA_m2) ** 2),
      line: Math.exp(logDarcyFactor(re, b.roughness_m / b.diameter_m)) * b.length_m / b.diameter_m * input.density * velocity ** 2 / 2,
      nozzle: q ** 2 / (2 * input.density * nozzleCdA ** 2),
    }
  }
  // Upper bound removes line and nozzle losses, not a prescribed operating flow.
  let low = 0, high = input.opening * b.valveCdA_m2 * Math.sqrt(2 * input.density * head)
  for (let i = 0; i < 70; i++) {
    const mid = (low + high) / 2, l = losses(mid)
    if (l.valve + l.line + l.nozzle > head) high = mid
    else low = mid
  }
  const q = (low + high) / 2, l = losses(q)
  return { flow_kg_s: q, availableAfterElevation_Pa: head, valveDrop_Pa: l.valve, lineDrop_Pa: l.line, nozzleDrop_Pa: l.nozzle, residual_Pa: l.valve + l.line + l.nozzle - head, exitVelocity_m_s: q / (input.density * input.activeTips * Math.PI * b.tipDiameter_m ** 2 / 4) }
}

const calculation = String.raw`
import json,sys,math,CoolProp,scipy
from CoolProp.CoolProp import PropsSI as P
from scipy.optimize import minimize_scalar,brentq
d=json.loads(sys.argv[1]);b=d['basis'];src=d['source'];pR=d['receiverPressure'];g=9.80665
checks=[]
def check(name,value,tol):
    if not math.isfinite(value) or abs(value)>tol:raise ValueError((name,value,tol))
    checks.append(dict(name=name,residual=value,tolerance=tol))
def store(p,h,V,z,c=0.):
    rho=P('D','P',p,'H',h,'Water');u=P('U','P',p,'H',h,'Water');M=rho*V
    return dict(M=M,E=M*(u+g*z),Pr=0.,Pz=0.,V=V,z=z,B=M*c)
def recover(s):
    if s['M']<=0:raise ValueError('Empty donor in finite transaction')
    u=(s['E']-(s['Pr']**2+s['Pz']**2)/(2*s['M']))/s['M']-g*s['z']
    rho=s['M']/s['V'];p=P('P','D',rho,'U',u,'Water');T=P('T','D',rho,'U',u,'Water')
    return dict(**s,p=p,T=T,u=u,quality=P('Q','D',rho,'U',u,'Water'))
def transfer(name,donor,receiver,amount,Ht,vz,payloadPerCarrier=0.,vr=0.):
    beforeM=donor['M']+receiver['M'];beforeE=donor['E']+receiver['E']
    # Stationary boundary supports supply the momentum reaction; no shaft work.
    a=dict(donor);c=dict(receiver);a['M']-=amount;a['E']-=amount*Ht;a['B']-=amount*payloadPerCarrier
    c['M']+=amount;c['E']+=amount*Ht;c['Pz']+=amount*vz;c['Pr']+=amount*vr;c['B']+=amount*payloadPerCarrier
    check(name+' M',a['M']+c['M']-beforeM,1e-9)
    check(name+' total E',a['E']+c['E']-beforeE,1e-5)
    check(name+' passive tracer payload',a['B']+c['B']-donor['B']-receiver['B'],1e-12)
    return dict(name=name,amount_kg=amount,carriedTotalH_J_kg=Ht,receiverMomentum_kg_m_s=dict(radial=amount*vr,axial=amount*vz),
        stationaryReactionImpulse_kg_m_s=dict(radial=-amount*vr,axial=-amount*vz),sourceAfter=recover(a),receiverAfter=recover(c))
Vline=math.pi*b['diameter_m']**2/4*b['length_m'];zline=(b['sourceElevation_m']+b['nozzleElevation_m'])/2
source=store(src['p'],src['h'],4.,b['sourceElevation_m'],.001)
line=store((src['p']+pR)/2,src['h'],Vline,zline,.001)
receiver=store(pR,P('H','P',pR,'Q',1,'Water'),4.5,b['nozzleElevation_m'])
sourceIntoLine=transfer('source to finite line',source,line,.1,src['h']+g*b['sourceElevation_m'],0.,.001)
q=d['hydraulics'][0]['flow_kg_s'];Ht=src['h']+g*zline
Aexit=b['tips']*math.pi*b['tipDiameter_m']**2/4;staticH=Ht-g*b['nozzleElevation_m']
def receiving(h):
    v=q/(P('D','P',pR,'H',h,'Water')*Aexit)
    return h+.5*v*v-staticH
hexit=brentq(receiving,staticH-1000,staticH,xtol=1e-8)
exitT=P('T','P',pR,'H',hexit,'Water');exitRho=P('D','P',pR,'H',hexit,'Water')
v=q/(exitRho*Aexit)
# Authored outward meridional projection, not an exact azimuthal cone average.
# No azimuthal component is assigned in this coarse pattern; both components retained.
vz=-v*math.cos(b['halfCone_rad']);vr=v*math.sin(b['halfCone_rad'])
# One microjoule/kg face evaluation screen is <20 microwatt at the reference flow.
check('full nozzle Ht with retained radial and axial motion',hexit+.5*(vz*vz+vr*vr)+g*b['nozzleElevation_m']-Ht,1e-6)
lineIntoReceiver=transfer('retained line to finite upper receiver',line,receiver,.1,Ht,vz,.001,vr)
# A separate actual reverse donor: open tips admit upper steam into retained liquid line.
pv=15e6;hv=P('H','P',pv,'Q',1,'Water');sv=P('S','P',pv,'Q',1,'Water');back=14.9e6
def flux(p):
    if p==pv:return 0.
    dh=hv-P('H','P',p,'S',sv,'Water')
    if dh < -1e-5:raise ValueError('Negative native nozzle work')
    return P('D','P',p,'S',sv,'Water')*math.sqrt(2*max(0.,dh))
opt=minimize_scalar(lambda p:-flux(p),bounds=(back,pv),method='bounded')
if not opt.success:raise ValueError('Reverse nozzle capacity solve failed')
G,pc=max([(flux(back),back),(flux(opt.x),opt.x)])
reverseFlow=b['tips']*b['tipWaterFlow_m3_s']*math.sqrt(1000/(2*b['tipReferenceDrop_Pa']))*G
reverseLine=store(back,src['h'],Vline,zline,.001)
reverse=transfer('actual steam reverse nozzle into retained line',store(pv,hv,4.5,b['nozzleElevation_m']),reverseLine,.01,hv+g*b['nozzleElevation_m'],0.)
check('reverse retains original line mass plus actual arrival',reverse['receiverAfter']['M']-reverseLine['M']-.01,1e-10)
print(json.dumps(dict(scope='Held purewater liquid sizing and three independent finite frozen-property packets, not one serial trajectory. Native equilibrium recovery is a ledger fixture, not selected two-temperature carrier or pressure-coupled trajectory. The endpoint-mean line centroid follows the selected straight equivalent route for this uniform coupon, not a surveyed as-built pipe. The healthy upstream inlet check is a prescribed closed boundary during the reverse packet, not a tested check-valve law.',
 dependencies=dict(CoolProp=CoolProp.__version__,scipy=scipy.__version__),lineVolume_m3=Vline,lineInitial= recover(line),
 sourceIntoLine=sourceIntoLine,lineIntoReceiver=lineIntoReceiver,reverse=reverse,
 exit=dict(T_K=exitT,rho_kg_m3=exitRho,velocity_m_s=v,axial_m_s=vz,radial_m_s=vr,projectionInternalIncrement_J_kg=0.,directionScope='Authored outward meridional projection at 0.6m ring into coarse outer lane; not exact whole-cone momentum; azimuthal component omitted by effective pattern'),
 reverseNozzle=dict(flow_kg_s=reverseFlow,criticalPressure_Pa=pc,donor='actual upper steam',upstreamHealthyCheckFlow_kg_s=0.),checks=checks),allow_nan=False))
`

if (import.meta.main) {
  const [parentPath, python, output, ...extra] = process.argv.slice(2)
  if (!parentPath || !python || !output || extra.length) throw Error('Usage: controlled-spray-delivery <frozen-normal-receipt> <python> <output>')
  const paths = [import.meta.path, new URL('./reference-design-surge-route.ts', import.meta.url).pathname, parentPath]
  const before = await Promise.all(paths.map(path => Bun.file(path).text()))
  const parent = JSON.parse(before[2]!), source = parent.sourceCold, receiverPressure = parent.cases[0].physicalPressureTap_Pa
  const base = { density: source.rho, viscosity: source.mu, sourcePressure: source.p, receiverPressure, opening: 1, activeTips: controlledSprayBasis.tips }
  const hydraulics = [base, { ...base, opening: 0.25 }, { ...base, activeTips: 8 }, { ...base, sourcePressure: source.p - 300000 }, { ...base, opening: 0 }].map(heldSprayFlow)
  const input = { basis: controlledSprayBasis, source, receiverPressure, hydraulics }
  const child = Bun.spawn([python, '-c', calculation, JSON.stringify(input)], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw Error(err)
  for (let i = 0; i < paths.length; i++) if (before[i] !== await Bun.file(paths[i]!).text()) throw Error('Source changed during calculation')
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const result = { input, ...JSON.parse(out) }
  const receipt = { sources: paths.map((path, i) => ({ path, sha256: hash(before[i]!) })), calculationSha256: hash(calculation), resultSha256: hash(JSON.stringify(result)), result }
  await Bun.write(output, JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ output, sourceSha256: receipt.sources[0]!.sha256, resultSha256: receipt.resultSha256, hydraulics }))
}
