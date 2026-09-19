/** Bounded signed RHR machine selection, not a running plant or a transient solver. */
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {resolve} from 'node:path'
import {readServicePump} from './reference-design-service-pump-continuation'

export type Machine={a:number;b:number;resistance:number}
export function signedMachine(k:Machine,rho:number,m:number,omega:number,factor:number,workSlope:number){
  if(![...Object.values(k),rho,m,omega,factor,workSlope].every(Number.isFinite)||k.a<=0||k.b<0||k.resistance<0||rho<=0||factor<0||factor>1||workSlope<=0)throw new Error('Invalid signed machine state')
  const q=m/rho,euler=factor*rho*omega*(k.a*omega-k.b*q),loss=k.resistance*rho*q*Math.abs(q)
  const torque=factor*rho*m*(k.a*omega-k.b*q)*workSlope
  return {q,euler,loss,rise:euler-loss,torque,shaftPower:omega*torque,dissipationProxy:Math.abs(q*loss)}
}
export function motorBudget(torque:number,omega:number,efficiency:number){
  if(![torque,omega,efficiency].every(Number.isFinite)||torque<0||efficiency<=0||efficiency>1)throw new Error('Invalid non-regenerative motor state')
  const shaft=torque*omega,electric=Math.max(shaft,0)/efficiency
  return {shaft,electric,heat:electric-shaft}
}
export function lossBudget(omega:number,omega0:number,referencePower:number,densityRatio:number,dissipationProxy:number,liquidFraction:number){
  if(![omega,omega0,referencePower,densityRatio,dissipationProxy,liquidFraction].every(Number.isFinite)||omega0<=0||referencePower<=0||densityRatio<=0||dissipationProxy<0||liquidFraction<0||liquidFraction>1)throw new Error('Invalid loss state')
  const dragTorque=.01*referencePower*omega/omega0**2,churn=.01*referencePower*Math.abs(omega/omega0)**3*densityRatio
  const extra=Math.max(churn-dissipationProxy,0),extraTorque=omega===0?0:extra/omega
  return {dragTorque,dragPower:dragTorque*omega,churn,extra,extraTorque,caseHeat:liquidFraction*extra,metalHeat:(1-liquidFraction)*extra}
}
export type SignedSelection={sigma:number;sigmaSensitivity:number[];rpm:number;motorEfficiency:number;coastdown_s:number;tracking_s:number;maximumTorqueFactor:number;entry_MPa:number;headerTrip_MPa:number;headerRelief_MPa:number;headerReseat_MPa:number}
export function readSignedSelection(text:string):SignedSelection{
  const records=[...text.matchAll(/```reference-rhr-signed-machine\s*\n([\s\S]*?)\n```/g)]
  if(records.length!==1)throw new Error('Expected one signed RHR selection')
  const b=JSON.parse(records[0]![1]!) as SignedSelection
  if(![b.sigma,b.rpm,b.motorEfficiency,b.coastdown_s,b.tracking_s,b.maximumTorqueFactor,b.entry_MPa,b.headerTrip_MPa,b.headerRelief_MPa,b.headerReseat_MPa].every(Number.isFinite)||b.sigma<=0||b.sigma>=1||!Array.isArray(b.sigmaSensitivity)||b.sigmaSensitivity.some(s=>!Number.isFinite(s)||s<=0||s>=1)||b.rpm<=0||b.motorEfficiency<=0||b.motorEfficiency>1||b.coastdown_s<=0||b.tracking_s<=0||b.maximumTorqueFactor<=0||b.entry_MPa<=0||b.headerTrip_MPa<=b.entry_MPa||b.headerRelief_MPa<=b.headerTrip_MPa||b.headerReseat_MPa<=0||b.headerReseat_MPa>=b.headerRelief_MPa)throw new Error('Invalid signed RHR selection')
  return b
}

const calculation=String.raw`
import json,sys,math
import CoolProp,scipy
from CoolProp.CoolProp import PropsSI as P
from scipy.optimize import brentq
from scipy.integrate import quad
inputs=json.load(sys.stdin);b=inputs['basis'];selected=inputs['selection'];p0=b['inletPressure_MPa']*1e6;t0=b['inletTemperature_C']+273.15;m0=b['flow_kg_s'];dp0=(b['outletPressure_MPa']-b['inletPressure_MPa'])*1e6
rho=P('D','P',p0,'T',t0,'Water');h0=P('H','P',p0,'T',t0,'Water');s0=P('S','P',p0,'T',t0,'Water');q0=m0/rho;w0=selected['rpm']*math.pi/30
e0=(P('H','P',p0+dp0,'S',s0,'Water')-h0)/b['hydraulicEfficiency'];de0=brentq(lambda d:P('H','P',p0+d,'S',s0,'Water')-h0-e0,dp0,2*dp0)
sigma=selected['sigma'];a=de0/(rho*(1-sigma)*w0*w0);bb=sigma*a*w0/q0;R=(de0-dp0)/(rho*q0*q0)
checks=[]
def check(name,ok):
 if not ok:raise ValueError(name)
 checks.append(name)
def hydraulic(m,w,rc=rho,F=1):
 q=m/rc;de=F*rc*w*(a*w-bb*q);loss=R*rc*q*abs(q)
 return de,loss
rows=[]
for name,m,w,pd,td,rc,F in [('nominal',m0,w0,p0,t0,rho,1),('cold-reverse',-1.,w0,1.8e6,313.15,rho,1),('hot-reverse',-80.,w0,1.8e6,423.15,rho,1),('negative-speed-forward',80.,-w0,1e6,313.15,rho,1),('negative-both',-80.,-w0,1.8e6,313.15,rho,1),('stopped-forward',80.,0.,1e6,313.15,rho,1),('stopped-reverse',-80.,0.,1e6,313.15,rho,1)]:
 de,loss=hydraulic(m,w,rc,F);direction=math.copysign(1,m);ps=pd+direction*de;pr=ps-abs(loss)
 check(name+' positive stage and receiver pressure',ps>0 and pr>0)
 hd=P('H','P',pd,'T',td,'Water');sd=P('S','P',pd,'T',td,'Water');hs=P('H','P',ps,'S',sd,'Water') if ps!=pd else hd;sr=P('S','P',pr,'H',hs,'Water')
 integral=(ps-pd)*quad(lambda x:1/P('D','P',pd+x*(ps-pd),'S',sd,'Water'),0,1,epsabs=1e-13,epsrel=1e-10)[0]
 dh=hs-hd if ps!=pd else 0.;C=dh/(ps-pd) if ps!=pd else 1/P('D','P',pd,'T',td,'Water');power=abs(m)*dh;torque=F*rc*m*(a*w-bb*m/rc)*C
 check(name+' native work versus integral',abs(dh-integral)<1e-4)
 check(name+' exact torque work incidence',abs(w*torque-power)<1e-7)
 check(name+' actual receiver entropy',sr>=sd-1e-7)
 check(name+' single receiver energy',abs(abs(m)*hs-abs(m)*hd-power)<1e-5)
 naive=hd+direction*de/rc
 naiveEntropy=P('S','P',pr,'H',naive,'Water')-sd
 rows.append(dict(name=name,m=m,omega=w,donorPressure=pd,donorTemperature=td,caseDensity=rc,euler=de,loss=loss,stagePressure=ps,receiverPressure=pr,workSlope=C,work=dh,integratedWork=integral,torque=torque,power=power,entropyRise=sr-sd,naiveEntropyRise=naiveEntropy,receiverTemperature=P('T','P',pr,'H',hs,'Water'),receiverQuality=P('Q','P',pr,'H',hs,'Water')))
check('Naive casing-volume reverse work rejected',next(r for r in rows if r['name']=='cold-reverse')['naiveEntropyRise']<-.01)
check('A2 exact unchanged nominal fluid duty',abs(rows[0]['power']-m0*e0)<1e-6)
# Independent explicit evaluation of the selected common-T liquid-bearing mixture.
# Mass basis: one kg water, with air and nitrogen retained separately.
Rgas={'air':287.,'nitrogen':296.8};cv={'air':718.,'nitrogen':742.};tref=298.15
pv=P('P','T',t0,'Q',1,'Water');rv=P('D','T',t0,'Q',1,'Water');mw=.99*rho+.01*rv
masses={n:.005*(p0-pv)/(r*t0)/mw for n,r in Rgas.items()}
def mix(p,T):
 pv=P('P','T',T,'Q',1,'Water');vg=sum(masses[n]*Rgas[n] for n in masses)*T/(p-pv);mv=vg*P('D','T',T,'Q',1,'Water');ml=1-mv
 if p<=pv or not 0<mv<1:raise ValueError('Outside liquid-bearing comparison')
 h=ml*P('H','P',p,'T',T,'Water')+mv*P('H','T',T,'Q',1,'Water');s=ml*P('S','P',p,'T',T,'Water')+mv*P('S','T',T,'Q',1,'Water')
 for n,m in masses.items():
  r=Rgas[n];c=cv[n];pj=m*r*T/vg;h+=m*(c*(T-tref)+r*T);s+=m*((c+r)*math.log(T/tref)-r*math.log(pj/101325))
 total=1+sum(masses.values())
 volume=ml/P('D','P',p,'T',T,'Water')+vg
 return dict(h=h/total,s=s/total,v=volume/total,gasFraction=vg/volume,mv=mv,ml=ml,T=T)
def sameS(p,donor):return mix(p,brentq(lambda T:mix(p,T)['s']-donor['s'],donor['T']-3,donor['T']+3,xtol=2e-11))
mixed=[]
for name,m,w,pd in [('mixed-forward',40.,.5*w0,1e6),('mixed-reverse',-40.,.5*w0,1.3e6)]:
 donor=mix(pd,t0);caseRho=1/donor['v'] if m>0 else rho;caseAlpha=donor['gasFraction'] if m>0 else 0.;gasFactor=1 if caseAlpha<=.02 else max(0,(.15-caseAlpha)/.13)
 required=b['npshSpeed_m']*(w/w0)**2+b['npshFlow_m']*(m/caseRho/q0)**2;available=(p0-P('P','T',t0,'Q',1,'Water'))/(caseRho*9.80665);factor=min(gasFactor,min(1,max(0,available/required))**2)
 de,loss=hydraulic(m,w,caseRho,factor);ps=pd+math.copysign(1,m)*de;pr=ps-abs(loss);stage=sameS(ps,donor);dh=stage['h']-donor['h']
 received=mix(pr,brentq(lambda T:mix(pr,T)['h']-stage['h'],t0-3,t0+3,xtol=2e-11));C=dh/(ps-pd)
 hp=(mix(pd+20,t0)['h']-mix(pd-20,t0)['h'])/40;sp=(mix(pd+20,t0)['s']-mix(pd-20,t0)['s'])/40
 ht=(mix(pd,t0+.0001)['h']-mix(pd,t0-.0001)['h'])/.0002;st=(mix(pd,t0+.0001)['s']-mix(pd,t0-.0001)['s'])/.0002
 zeroC=hp-ht*sp/st;fdC=(sameS(pd+100,donor)['h']-sameS(pd-100,donor)['h'])/200
 check(name+' effective zero-step derivative',zeroC>0 and abs(zeroC/fdC-1)<1e-5)
 check(name+' actual receiver entropy',received['s']>=donor['s']-1e-7)
 check(name+' exact face energy',abs(received['h']-stage['h'])<1e-5)
 check(name+' material ratios preserved',abs(received['ml']+received['mv']-1)<1e-12 and all(x>0 for x in masses.values()))
 mixed.append(dict(name=name,m=m,omega=w,caseDensity=caseRho,caseGasFraction=caseAlpha,factor=factor,availableNPSH=available,requiredNPSH=required,donorPressure=pd,stagePressure=ps,receiverPressure=pr,donor=donor,stage=stage,received=received,work=dh,workSlope=C,zeroStepWorkSlope=zeroC,finiteDifferenceSlope=fdC,zeroStepSpecificVolume=donor['v'],NCmassPerWater=masses))
# F=0 passive gas: no rotor exchange, isenthalpic ideal gas loss, both identities retained.
gas=[]
for name in Rgas:
 pd=2e5;T=313.15;rc=pd/(Rgas[name]*T);de,loss=hydraulic(.1,w0,rc,0);pr=pd-loss
 check(name+' gas-disabled stage is passive',de==0 and 1e5<=pr<pd)
 gas.append(dict(species=name,caseDensity=rc,loss=loss,entropyRise=Rgas[name]*math.log(pd/pr),shaftPower=0,receiverTemperature=T))
# Instantaneous forced-throughflow coupon: fixed cold donor and case state, no motor.
J=1.01*m0*e0*selected['coastdown_s']/w0**2;pd=1.8e6;td=313.15;hd=P('H','P',pd,'T',td,'Water');sd=P('S','P',pd,'T',td,'Water');mc=-20.
def rates(t,y):
 w=y[0];de,loss=hydraulic(mc,w);ps=pd-de;pr=ps-abs(loss)
 if min(ps,pr)<=0:raise ValueError('Coupon pressure path inadmissible')
 dh=P('H','P',ps,'S',sd,'Water')-hd;C=dh/(-de) if de!=0 else 1/P('D','P',pd,'T',td,'Water')
 torque=rho*mc*(a*w-bb*mc/rho)*C;power=abs(mc)*dh
 drag=.01*m0*e0*w/w0**2;extra=max(.01*m0*e0*abs(w/w0)**3-abs(mc/rho*loss),0);tex=extra/w if w!=0 else 0
 return [(-torque-drag-tex)/J,power,drag*w,extra]
acceleration,fluid,drag,extra=rates(0,[w0]);rotor=J*w0*acceleration;defect=rotor+fluid+drag+extra
check('Unpowered reverse instantaneous shaft ledger',abs(defect)<1e-7 and acceleration>0 and fluid<0 and drag>0 and extra>0)
coupon=dict(forcedMassFlow=mc,omega=w0,acceleration=acceleration,rotorPower=rotor,fluidPower=fluid,dragPower=drag,extraCasePower=extra,powerDefect=defect)
mf=brentq(lambda m:sum([hydraulic(m,w0)[0],-hydraulic(m,w0)[1]])-.5e6*(m/15)**2,0,m0)
dem,lm=hydraulic(mf,w0);hm=P('H','P',p0+dem,'S',s0,'Water');pm=mf*(hm-h0)
rc=P('D','P',2e6,'T',313.15,'Water');head=rc*a*w0*w0
def hydrostatic(p,T,dz):
 return brentq(lambda po:quad(lambda pp:1/P('D','P',pp,'T',T,'Water'),p,po,epsabs=1e-7)[0]-9.80665*dz,p,p+1e5)
header=hydrostatic(selected['entry_MPa']*1e6,313.15,4.5);trip=selected['headerTrip_MPa']*1e6;relief=selected['headerRelief_MPa']*1e6
sensitivity=[dict(sigma=s,coldShutoff=rc/rho*de0/(1-s),reliefPlusHead=relief+rc/rho*de0/(1-s)) for s in selected['sigmaSensitivity']]
check('Selected static trip and relief opening below equipment envelope',trip+head<2e6 and relief+head<2e6)
check('Cold admission hydrostatic below header trip',header<trip)
print(json.dumps(dict(libraries=dict(CoolProp=CoolProp.__version__,SciPy=scipy.__version__),calibration=dict(rho=rho,m0=m0,q0=q0,omega0=w0,e0=e0,eulerRise=de0,a=a,b=bb,resistance=R,sigma=sigma,fluidPower=m0*e0,inertia=J),rows=rows,mixed=mixed,gas=gas,coupon=coupon,minimumFlow=dict(m=mf,rise=dem-lm,fluidPower=pm),pressure=dict(coldDensity=rc,coldShutoff=head,coldEntryHeader=header,entryDischargeUpper=header+head,headerTripPlusHead=trip+head,headerReliefPlusHead=relief+head,hotNominalNoFriction=p0-rho*9.80665*4.5,hotNominalWithCommonLoss=p0-rho*9.80665*4.5+5e4,sensitivity=sensitivity),checks=checks)))
`

if(import.meta.main){
  const [owner,python,receipt,...extra]=process.argv.slice(2)
  if(!owner||!python||extra.length)throw new Error('Usage: <rhr-owner.md> <python-with-CoolProp-and-SciPy> [receipt.json]')
  const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex')
  const sources=[owner,resolve(owner,'../two-phase-and-breaks.md'),import.meta.path,resolve(import.meta.dir,'reference-design-service-pump-continuation.ts')].map(path=>({path,sha256:hash(path)}))
  const basis=readServicePump(owner)
  const selection=readSignedSelection(readFileSync(owner,'utf8'))
  if(basis.id!=='RHR')throw new Error('Requires RHR reference')
  const run=spawnSync(python,['-c',calculation],{input:JSON.stringify({basis,selection}),encoding:'utf8'})
  if(run.status!==0)throw new Error(run.stderr||'Native RHR comparison failed')
  const result=JSON.parse(run.stdout)
  for(const row of result.rows){
    const machine=signedMachine(result.calibration,row.caseDensity,row.m,row.omega,1,row.workSlope)
    if(Math.abs(machine.shaftPower-row.power)>1e-6||Math.abs(machine.rise-(row.euler-row.loss))>1e-6)throw new Error('Independent TS characteristic disagreement')
  }
  const motor=[-result.calibration.omega0,0,result.calibration.omega0].map(omega=>({omega,...motorBudget(100,omega,selection.motorEfficiency)}))
  const axes=[-100,0,100].map(m=>({m,...signedMachine(result.calibration,result.calibration.rho,m,0,1,1/result.calibration.rho)}))
  if(motor.some(b=>b.electric<0||b.heat<0||Math.abs(b.electric-b.shaft-b.heat)>1e-8)||axes.some(a=>!Number.isFinite(a.torque)||a.shaftPower!==0))throw new Error('Axis or motor energy budget failed')
  result.checks.push('Signed zero-speed torque and zero power','Non-regenerative motor positive zero negative speed')
  if(sources.some(s=>hash(s.path)!==s.sha256))throw new Error('Source changed during comparison')
  const output={scope:'Fixed native water/effective mixed faces, axes and instantaneous reverse shaft coupon, nominal recalibration and static pressure screens; no installed transient or pressure-protection qualification',sources,selection,motor,axes,...result}
  if(receipt)await Bun.write(receipt,JSON.stringify(output,null,2)+'\n')
  console.log(JSON.stringify(receipt?{receipt,checks:result.checks.length,calibration:result.calibration,minimumFlow:result.minimumFlow,pressure:result.pressure}:output,null,2))
}
