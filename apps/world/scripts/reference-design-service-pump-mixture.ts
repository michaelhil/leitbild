/** Bounded effective-mixture compression decision; no live plant or general flash framework. */
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {resolve} from 'node:path'
import {readServicePump} from './reference-design-service-pump-continuation'

export const mixtureWorkAdmitted=(endpoint:number,integral:number)=>Number.isFinite(endpoint)&&Number.isFinite(integral)&&integral>0&&Math.abs(endpoint-integral)<=.001*integral
export const gasConstants={air:{R:287,cv:718},nitrogen:{R:296.8,cv:742}} as const
const calculation=String.raw`
import json,sys,math
import CoolProp,scipy
from CoolProp.CoolProp import PropsSI as P
from scipy.optimize import brentq
from scipy.integrate import quad
inputs=json.load(sys.stdin);bases=inputs['bases']; T0=313.15; p0=101325.; tref=298.15
checks=[]
def check(name,ok):
 if not ok: raise ValueError(name)
 checks.append(name)
species={n:(v['R'],v['cv']) for n,v in inputs['species'].items()}
def prepared(alpha,air):
 pv=P('P','T',T0,'Q',1,'Water'); rl=P('D','P',p0,'T',T0,'Water');rv=P('D','T',T0,'Q',1,'Water')
 # air is fraction of noncondensable partial pressure, not mass fraction.
 mw=(1-alpha)*rl+alpha*rv
 masses={name:alpha*(p0-pv)*fraction/(species[name][0]*T0)/mw for name,fraction in [('air',air),('nitrogen',1-air)]}
 return masses
def state(p,T,masses):
 if sum(masses.values())==0:
  h=P('H','P',p,'T',T,'Water');s=P('S','P',p,'T',T,'Water');rho=P('D','P',p,'T',T,'Water')
  return dict(T=T,h=h,s=s,v=1/rho,mv=0.,ml=1.,partial={},liquidH=h,gasH=0.,ncH={},scale=0.)
 pv=P('P','T',T,'Q',1,'Water'); pn=p-pv
 if pn<=0: raise ValueError('Liquid-bearing face requires positive NC pressure')
 vg=sum(m*species[n][0] for n,m in masses.items())*T/pn
 mv=vg*P('D','T',T,'Q',1,'Water');ml=1-mv;mass=1+sum(masses.values())
 if ml<=0: raise ValueError('Diagnostic left liquid-bearing branch')
 hl=P('H','P',p,'T',T,'Water');sl=P('S','P',p,'T',T,'Water');rho=P('D','P',p,'T',T,'Water')
 hv=P('H','T',T,'Q',1,'Water');sv=P('S','T',T,'Q',1,'Water')
 gasH=mv*hv; entropy=ml*sl+mv*sv;partial={};ncH={}
 for n,m in masses.items():
  if m==0: continue
  R,cv=species[n];pj=m*R*T/vg;partial[n]=pj
  ncH[n]=m*(cv*(T-tref)+R*T);gasH+=ncH[n]
  entropy+=m*((cv+R)*math.log(T/tref)-R*math.log(pj/101325))
 return dict(T=T,h=(ml*hl+gasH)/mass,s=entropy/mass,v=(ml/rho+vg)/mass,mv=mv,ml=ml,partial=partial,liquidH=ml*hl/mass,gasH=gasH/mass,ncH=ncH,scale=(p-pv)/(rho*461.52*T))
rows=[]
cases=[(.01,1.,101325.,313.15),(.05,1.,101325.,313.15),(.10,1.,101325.,313.15),(.01,0.,101325.,313.15),(.01,.5,101325.,313.15),(.01,1.,1e6,423.15),(.01,1.,5e6,493.15)]
for alpha,air,p0,T0 in cases:
 masses=prepared(alpha,air);a=state(p0,T0,masses)
 targets=[('FW',bases[0]['outletPressure_MPa']*1e6,bases[0]['hydraulicEfficiency']),('CHARGE',bases[1]['outletPressure_MPa']*1e6,bases[1]['hydraulicEfficiency']),('CHARGE-shutoff',p0+1.25*(bases[1]['outletPressure_MPa']*1e6-p0),bases[1]['hydraulicEfficiency'])] if p0==101325 else [('warm-reference',1.5e6 if p0==1e6 else 15.8e6,.75)]
 for identifier,po,eta in targets:
  def at(p):return state(p,brentq(lambda T:state(p,T,masses)['s']-a['s'],T0-1,T0+10,xtol=2e-11),masses)
  b=at(po);dh=b['h']-a['h'];work,error=quad(lambda p:at(p)['v'],p0,po,epsabs=1e-5,epsrel=1e-10,limit=80)
  target=a['h']+dh/eta
  out=state(po,brentq(lambda T:state(po,T,masses)['h']-target,T0,T0+20,xtol=2e-11),masses)
  pure=P('H','P',po,'S',P('S','P',p0,'T',T0,'Water'),'Water')-P('H','P',p0,'T',T0,'Water')
  factor=1 if alpha<=.02 else max(0,(.15-alpha)/.13)
  base=bases[0] if identifier=='FW' else bases[1]
  rhoRef=P('D','P',p0,'T',T0,'Water');upper=p0+1.25*factor/(a['v']*rhoRef)*(base['outletPressure_MPa']*1e6-p0)
  check(identifier+' work proxy budget',abs(dh-work)<=.001*work and error<.01)
  check(identifier+' exact face energy incidence',abs(out['liquidH']+out['gasH']-target)<1e-5)
  check(identifier+' actual phase and NC pressure',0<out['mv']<1 and abs(sum(out['partial'].values())+P('P','T',out['T'],'Q',1,'Water')-po)<1e-5)
  check(identifier+' receiver entropy not reduced',out['s']>=a['s'])
  # Frozen native phase-energy receipt only: different retained energies are not reflashed.
  dm=.01;mass=1+sum(masses.values());before={'liquidMass':10.,'vaporMass':.1,'airMass':.001,'nitrogenMass':.002,'liquidEnergy':2e6,'gasEnergy':3e5}
  after=dict(before);after['liquidMass']+=dm*out['ml']/mass;after['vaporMass']+=dm*out['mv']/mass
  after['liquidEnergy']+=dm*out['liquidH'];after['gasEnergy']+=dm*out['gasH']
  for name,m in masses.items():after[name+'Mass']+=dm*m/mass
  energyGain=after['liquidEnergy']-before['liquidEnergy']+after['gasEnergy']-before['gasEnergy']
  check(identifier+' frozen receiver species conserved',abs(sum(after[k]-before[k] for k in ['liquidMass','vaporMass','airMass','nitrogenMass'])-dm)<1e-12)
  check(identifier+' frozen receiver single shaft incidence',abs(energyGain-dm*a['h']-dm*dh/eta)<1e-8)
  rows.append(dict(id=identifier,inletPressure=p0,outletPressure=po,alpha=alpha,airPartialFraction=air,NCmassPerWater=masses,inlet=a,isentropic=b,outlet=out,receipt=dict(before=before,after=after,parcelMass=dm,energyGain=energyGain),work=dh,integratedWork=work,quadratureError=error,workDefect=dh-work,relativeDefect=(dh-work)/work,incrementAbovePureWater=dh-pure,defectToGasIncrement=(dh-work)/(dh-pure) if abs(dh-pure)>1e-6 else None,gasFactor=factor,upperHeadPressure=upper if p0==101325 else None,headReachable=po<upper if p0==101325 else None,meaning='Frozen endpoint, no pressure-loss allowance; warm/unreachable endpoints are external-compression stresses, not pump duty',enthalpyUnits='h,liquidH,gasH per kg mixture; ncH per kg original water'))
p0=101325.;T0=313.15
po=p0+1.25*(bases[1]['outletPressure_MPa']*1e6-p0);s=P('S','P',p0,'T',T0,'Water');h=P('H','P',p0,'T',T0,'Water')
dh=P('H','P',po,'S',s,'Water')-h;integral=quad(lambda p:1/P('D','P',p,'S',s,'Water'),p0,po,epsabs=1e-6,epsrel=1e-10)[0]
check('Pure-water charging shutoff native identity',abs(dh-integral)<1e-5)
pureWater=dict(pressure=po,T=P('T','P',po,'S',s,'Water'),work=dh,integratedWork=integral)
zeroNC=state(p0,T0,{'air':0.,'nitrogen':0.})
check('Zero all NC dispatches native water branch',zeroNC['h']==h and zeroNC['s']==s and zeroNC['gasH']==0)
pureGas=[]
for name,(R,cv) in species.items():
 cp=R+cv;Tout=T0*(po/p0)**(R/cp);work=cp*(Tout-T0)
 integral=quad(lambda p:R*T0*(p/p0)**(R/cp)/p,p0,po,epsabs=1e-5)[0]
 check(name+' pure gas analytic work',abs(work-integral)<1e-5)
 pureGas.append(dict(species=name,T=Tout,work=work,integratedWork=integral,gasFactor=0,meaning='Mathematical caloric limit only: no positive pump head, not selected HP gas duty or high-temperature accuracy'))
print(json.dumps(dict(libraries={'CoolProp':CoolProp.__version__,'SciPy':scipy.__version__},criterion='0.1% effective work proxy; not calibrated accuracy',rows=rows,pureGas=pureGas,pureWaterShutoff=pureWater,checks=checks)))
`
if(import.meta.main){
 const [python,feed,charge,mixture,receipt,...extra]=process.argv.slice(2)
 if(!python||!feed||!charge||!mixture||extra.length)throw new Error('Usage: <python> <feed-owner> <charge-owner> <mixture-owner> [receipt.json]')
 const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex')
 const sources=[feed,charge,mixture,import.meta.path,resolve(import.meta.dir,'reference-design-service-pump-continuation.ts')].map(path=>({path,sha256:hash(path)}))
 const bases=[readServicePump(feed),readServicePump(charge)]
 if(bases.map(b=>b.id).join(',')!=='FW,CHARGE'||bases.some(b=>b.inletPressure_MPa!==.101325||b.inletTemperature_C!==40))throw new Error('Comparison requires named atmospheric 40 C calibration')
 const result=spawnSync(python,['-c',calculation],{input:JSON.stringify({bases,species:gasConstants}),encoding:'utf8'})
 if(result.status!==0)throw new Error(result.stderr||'Mixture comparison failed')
 if(sources.some(s=>hash(s.path)!==s.sha256))throw new Error('Source changed during comparison')
 const calculationResult=JSON.parse(result.stdout)
 if(!calculationResult.rows.every((r:{work:number;integratedWork:number})=>mixtureWorkAdmitted(r.work,r.integratedWork)))throw new Error('Mixture work budget failed')
 const output={sources,...calculationResult}
 if(receipt)await Bun.write(receipt,JSON.stringify(output,null,2)+'\n')
 console.log(JSON.stringify(output,null,2))
}
