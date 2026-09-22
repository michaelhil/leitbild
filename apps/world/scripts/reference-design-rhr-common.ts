/** Offline RHR serial-interface and retained-volume checks, not a plant solver. */
import { createHash } from 'node:crypto'

export function readCommonRecord(text: string): Record<string, number> {
  const matches = [...text.matchAll(/```reference-rhr-common\s*([\s\S]*?)```/g)]
  if (matches.length !== 1) throw new Error('Expected one RHR COMMON record')
  const record = JSON.parse(matches[0]![1]!) as Record<string, number>
  const keys = ['boreArea_m2', 'cavityVolume_m3', 'headerVolume_m3', 'movingLineVolume_m3', 'verticalDrop_m', 'sourceElevation_m', 'headerElevation_m', 'referenceFlow_kg_s', 'referencePressure_MPa', 'referenceTemperature_C', 'fixedLoss_Pa', 'eachValveLoss_Pa', 'equalizeCdA_m2', 'fillCdA_m2', 'reliefOpening_MPa', 'reliefReseat_MPa', 'reliefCdA_m2', 'reliefStroke_s']
  if (Object.keys(record).sort().join() !== keys.sort().join()) throw new Error('Unexpected COMMON record fields')
  if (Object.values(record).some(value => !Number.isFinite(value))) throw new Error('Nonfinite COMMON value')
  if (keys.some(key => key !== 'headerElevation_m' && record[key]! <= 0)) throw new Error('Nonpositive physical input')
  if (record.movingLineVolume_m3! >= record.headerVolume_m3! || record.verticalDrop_m! * record.boreArea_m2! > record.movingLineVolume_m3!) throw new Error('Incompatible retained geometry')
  if (record.sourceElevation_m! - record.headerElevation_m! !== record.verticalDrop_m!) throw new Error('Incompatible elevations')
  if (record.reliefOpening_MPa! <= record.reliefReseat_MPa!) throw new Error('Invalid relief thresholds')
  return record
}

export function reliefStep(state: { opening: boolean; lift: number }, pressureMPa: number, dt: number, record: Record<string, number>) {
  if (![state.lift, pressureMPa, dt].every(Number.isFinite) || state.lift < 0 || state.lift > 1 || dt < 0) throw new Error('Invalid relief state')
  const opening = pressureMPa >= record.reliefOpening_MPa! ? true : pressureMPa <= record.reliefReseat_MPa! ? false : state.opening
  const distance = dt / record.reliefStroke_s!
  return { opening, lift: opening ? Math.min(1, state.lift + distance) : Math.max(0, state.lift - distance) }
}

const calculation = String.raw`
import json,sys,math,scipy,CoolProp
import CoolProp.CoolProp as C
from scipy.optimize import brentq,minimize_scalar
r=json.loads(sys.argv[1]); checks=[];g=9.80665
def check(name,error,bound):
    if not math.isfinite(error) or abs(error)>bound: raise ValueError((name,error,bound))
    checks.append(dict(name=name,error=error,bound=bound))
def state(p,h):
    return dict(p=p,h=h,rho=C.PropsSI('D','P',p,'H',h,'Water'),s=C.PropsSI('S','P',p,'H',h,'Water'))
def stagnant(p,H): return state(p,H)
def bore(p0,H,m,A):
    s=C.PropsSI('S','P',p0,'H',H,'Water')
    def residual(p):
        h=C.PropsSI('H','P',p,'S',s,'Water');rho=C.PropsSI('D','P',p,'S',s,'Water')
        return h+.5*(m/(rho*A))**2-H
    p=brentq(residual,p0*.9,p0,xtol=1e-5);h=C.PropsSI('H','P',p,'S',s,'Water');out=state(p,h)
    out['velocity']=m/(out['rho']*A)
    check('bore total enthalpy',h+out['velocity']**2/2-H,1e-4)
    return out
def nozzle(H,s,p0,pback):
    if pback>=p0: return dict(flux=0,throat=p0)
    def flux(p):
        if p==p0: return 0.
        h=C.PropsSI('H','P',p,'S',s,'Water');rho=C.PropsSI('D','P',p,'S',s,'Water')
        available=H-h
        if available < -1e-5: raise ValueError(('Negative native nozzle work outside inversion allowance',available))
        return rho*math.sqrt(2*max(0,available))
    opt=minimize_scalar(lambda p:-flux(p),bounds=(pback,p0),method='bounded',options={'xatol':1e-5})
    if not opt.success: raise ValueError('Throat maximization failed')
    candidates=[(pback,flux(pback)),(opt.x,flux(opt.x)),(p0,0)]
    p,G=max(candidates,key=lambda pair:pair[1]);return dict(flux=G,throat=p)
A=r['boreArea_m2'];m=r['referenceFlow_kg_s'];p0=r['referencePressure_MPa']*1e6;T=r['referenceTemperature_C']+273.15
H=C.PropsSI('H','P',p0,'T',T,'Water');rho=C.PropsSI('D','P',p0,'T',T,'Water')
v=m/(rho*A);mix=.5*rho*v*v;remaining=r['fixedLoss_Pa']-mix
if remaining<=0: raise ValueError('Mixing consumes fixed head budget')
length=r['movingLineVolume_m3']/A;verticalV=A*r['verticalDrop_m'];horizontalV=r['movingLineVolume_m3']-verticalV
zmean=(verticalV*(r['sourceElevation_m']+r['headerElevation_m'])/2+horizontalV*r['headerElevation_m'])/r['movingLineVolume_m3']
check('cavity and header volume',r['cavityVolume_m3']+A*length+r['headerVolume_m3']-r['movingLineVolume_m3']-2.05,1e-12)
diameter=math.sqrt(4*A/math.pi)
sound=C.PropsSI('A','P',p0,'T',T,'Water')
geometry=dict(cavityLength=r['cavityVolume_m3']/A,lineLength=length,diameter=diameter,mixedVolume=r['headerVolume_m3']-r['movingLineVolume_m3'],lineCentroid=zmean,referenceVelocity=v,terminalMixing_Pa=mix,remainingLineLoss_Pa=remaining,effectiveDarcy=remaining/(.5*rho*v*v)*diameter/length,referenceSoundSpeed=sound,referenceCavityLineAcoustic_s=(length+r['cavityVolume_m3']/A)/sound)
calibration=[]
for i in range(2):
    pu=p0-i*r['eachValveLoss_Pa'];pd=pu-r['eachValveLoss_Pa'];up=bore(pu,H,m,A);down=bore(pd,H,m,A)
    flux=nozzle(H,up['s'],pu,down['p']);CdA=m/flux['flux']
    if not 0<CdA<A or down['s']<up['s']: raise ValueError('Invalid valve recovery/calibration')
    check('individual reference flow',CdA*flux['flux']-m,1e-10)
    calibration.append(dict(upstream=up,downstream=down,stagnationUp=pu,stagnationDown=pd,CdA=CdA,throat=flux['throat'],entropyRise=down['s']-up['s']))
# Held finite-owner states: actual cavity changes each individual rate; no series
# aggregate is applied in parallel. These are rates, not a startup history.
held=[]
def resting_transfer(left,right,a,CdA):
    if left==right or a==0: return 0.
    pd=max(left,right);pr=min(left,right)
    return math.copysign(a*CdA*nozzle(H,stagnant(pd,H)['s'],pd,pr)['flux'],left-right)
for pc in [1.01e6,.99e6,.98e6,.97e6,.95e6]:
    for a1,a2 in [(1,1),(1,0),(0,1),(1e-6,1)]:
        f1=resting_transfer(p0,pc,a1,calibration[0]['CdA']);f2=resting_transfer(pc,.96e6,a2,calibration[1]['CdA'])
        held.append(dict(cavityPressure=pc,a1=a1,a2=a2,inlet=f1,outlet=f2,cavityMassRate=f1-f2,cavityEnergyRate=(f1-f2)*H))
        check('local mass incidence',-f1+(f1-f2)+f2,1e-12)
        check('local energy incidence',-f1*H+(f1-f2)*H+f2*H,1e-6)
        if a2==0 and f2!=0: raise ValueError('Closed second valve leaked')
        if a1>0 and pc>p0 and f1>=0: raise ValueError('Wrong first-valve reversal')
        if a2>0 and pc<.96e6 and f2>=0: raise ValueError('Wrong second-valve reversal')
hotP=15.2e6;hotT=563.15;hotH=C.PropsSI('H','P',hotP,'T',hotT,'Water');hotS=C.PropsSI('S','P',hotP,'T',hotT,'Water')
choked=[nozzle(hotH,hotS,hotP,pb) for pb in [1e6,2e6]]
check('native hot throat downstream independence',choked[0]['flux']-choked[1]['flux'],.01)
if any(row['throat']<=2e6 for row in choked): raise ValueError('Hot comparison was not choked')
# Existence of an admitted hot full-bore trace, not its installed pressure.
# At critical pressure the bore has more area than the effective throat, so
# its isentropic endpoint leaves energy for irreversible velocity recovery.
pTrace=choked[0]['throat'];mTrace=calibration[0]['CdA']*choked[0]['flux']
hIs=C.PropsSI('H','P',pTrace,'S',hotS,'Water')
def traceResidual(h):
    rhoTrace=C.PropsSI('D','P',pTrace,'H',h,'Water')
    return h+.5*(mTrace/(rhoTrace*A))**2-hotH
if not traceResidual(hIs)<0<traceResidual(hotH): raise ValueError('Hot receiving trace not bracketed')
hTrace=brentq(traceResidual,hIs,hotH,xtol=1e-7);trace=state(pTrace,hTrace)
trace['velocity']=mTrace/(trace['rho']*A)
check('hot receiving trace total enthalpy',traceResidual(hTrace),1e-4)
if trace['s']<=hotS: raise ValueError('Hot receiving trace decreases entropy')
hotTrace=dict(scope='Constitutive existence at critical pressure only; not a solved boundary or reset cold receiver',massFlow=mTrace,donorEntropy=hotS,receiving=trace,entropyRise=trace['s']-hotS,coldCellPressure=0.3e6,coldCellTemperature=313.15)
# Tiny prescribed parcel from a finite source to the finite isolated cavity.
# Actual native pressure responds. No valve travel or achieved delivery claimed.
Vc=r['cavityVolume_m3'];pc=.3e6;Tc=313.15;Mc=C.PropsSI('D','P',pc,'T',Tc,'Water')*Vc;Uc=Mc*C.PropsSI('U','P',pc,'T',Tc,'Water')
Ms=100.;Vs=Ms/rho;Us=Ms*C.PropsSI('U','P',p0,'T',T,'Water');dm=.001
pC=C.PropsSI('P','D',(Mc+dm)/Vc,'U',(Uc+dm*H)/(Mc+dm),'Water')
pS=C.PropsSI('P','D',(Ms-dm)/Vs,'U',(Us-dm*H)/(Ms-dm),'Water')
check('finite parcel water',Mc+dm+Ms-dm-Mc-Ms,1e-12)
check('finite parcel native energy',Uc+dm*H+Us-dm*H-Uc-Us,1e-6)
if not pc<pC<p0 or not pS<p0: raise ValueError('Finite source/receiver response wrong')
print(json.dumps(dict(inputs=r,dependencies=dict(CoolProp=CoolProp.__version__,scipy=scipy.__version__),scope='Geometry, fixed native valve calibration and finite parcel incidence; not a coupled RHR transient or mixed-gas qualification',geometry=geometry,calibration=calibration,heldSerialStates=held,hotChokedComparison=dict(donorPressure=hotP,donorTemperature=hotT,receiverPressures=[1e6,2e6],results=choked),hotAdmittedTrace=hotTrace,parcel=dict(mass=dm,cavityPressureBefore=pc,cavityPressureAfter=pC,sourcePressureBefore=p0,sourcePressureAfter=pS),checks=checks),sort_keys=True,allow_nan=False))
`

if (import.meta.main) {
  const [ownerPath, python] = process.argv.slice(2)
  if (!ownerPath || !python) throw new Error('Usage: <shutdown-cooling.md> <research-python>')
  const [owner, source] = await Promise.all([Bun.file(ownerPath).text(), Bun.file(import.meta.path).text()])
  const record = readCommonRecord(owner)
  const child = Bun.spawn([python, '-c', calculation, JSON.stringify(record)], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (status !== 0) throw new Error(err)
  if (await Bun.file(ownerPath).text() !== owner || await Bun.file(import.meta.path).text() !== source) throw new Error('Consumed source changed')
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  console.log(JSON.stringify({ ownerSha256: hash(owner), sourceSha256: hash(source), calculationSha256: hash(calculation), ...JSON.parse(out) }, null, 2))
}
