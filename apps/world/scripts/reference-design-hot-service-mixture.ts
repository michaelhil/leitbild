/** Bounded hot charging material path; no installed transient or general mixture package. */
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
import {readServicePump} from './reference-design-service-pump-continuation'
import {parseSelection,pressureExchange,streamLoss,backflowBrake} from './reference-design-service-pump-signed'
import {gasConstants} from './reference-design-service-pump-mixture'

export function hotWorkComparison(endpoint:number,integral:number){
 if(![endpoint,integral].every(Number.isFinite))throw new Error('Nonfinite work comparison')
 return {defect:endpoint-integral,relative:integral===0?null:Math.abs((endpoint-integral)/integral),admitted:integral===0?endpoint===0:Math.abs(endpoint-integral)<=.001*Math.abs(integral)}
}
const calculation=String.raw`
import json,sys,math
import CoolProp,scipy
from CoolProp.CoolProp import PropsSI as P
from scipy.optimize import brentq,minimize_scalar,least_squares
from scipy.integrate import quad
from functools import lru_cache
i=json.load(sys.stdin);b=i['basis'];sel=i['selection'];species=i['species'];checks=[]
def check(n,ok):
 if not ok:raise ValueError(n)
 checks.append(n)
def water(p,T=None,h=None,s=None):
 key='T' if T is not None else ('H' if h is not None else 'S');x=T if T is not None else (h if h is not None else s)
 return dict(p=p,T=P('T','P',p,key,x,'Water'),h=P('H','P',p,key,x,'Water'),s=P('S','P',p,key,x,'Water'),rho=P('D','P',p,key,x,'Water'))
p0=b['inletPressure_MPa']*1e6;a=water(p0,T=b['inletTemperature_C']+273.15);out=b['outletPressure_MPa']*1e6;dp0=out-p0;m0=b['flow_kg_s'];r0=a['rho'];Q0=m0/r0;k=sel['crossCoefficient'];w0=sel['rpm']*math.pi/30
def nozzle(d,pr,at,points=33):
 def flux(p):
  if p==d['p']:return 0.
  q=at(p);dh=d['h']-q['h']
  if dh < -1e-4:raise ValueError('Negative kinetic energy beyond native increment resolution')
  return q['rho']*math.sqrt(2*max(0,dh))
 grid=[math.exp(math.log(pr)+(math.log(d['p'])-math.log(pr))*j/(points-1)) for j in range(points)];grid[0]=pr;grid[-1]=d['p'];values=[flux(p) for p in grid];candidates=grid[:]
 for j in range(points-1):
  if j==0 or j==points-2 or (j>0 and values[j]>=values[j-1] and values[j]>=values[j+1]):
   lo=grid[max(0,j-1)];hi=grid[min(points-1,j+1)];candidates.append(minimize_scalar(lambda p:-flux(p),bounds=(lo,hi),method='bounded',options={'xatol':.01}).x)
 pt=max(candidates,key=flux)
 return dict(G=flux(pt),throat=pt,state=at(pt),choked=bool(pt>pr+1))
stage0=water(p0+(1.25-k)*dp0,s=a['s']);noz0=nozzle(stage0,out,lambda p:water(p,s=stage0['s']));CdA=m0/noz0['G'];old=(water(out,s=a['s'])['h']-a['h'])/b['hydraulicEfficiency'];H0=m0*(old-stage0['h']+a['h'])
# One fixed-composition evaluator implementing the already selected wet/dry branches.
# Ratios are kg of each NC per kg water; no additional retained state is invented.
def material(p,T,masses):
 if not (1e5<=p<=20e6 and 273.16<=T<=623.15):raise ValueError('Named hot comparison domain exceeded')
 mt=1+sum(masses.values());Ar=sum(masses[n]*species[n]['R'] for n in masses)
 if Ar==0:
  q=water(p,T=T);q.update(v=1/q['rho'],u=q['h']-p/q['rho'],ml=1.,mv=0.,partial={},liquidH=q['h'],gasH=0.,branch='native-water');return q
 pv=P('P','T',T,'Q',1,'Water');rv=P('D','T',T,'Q',1,'Water');vg=Ar*T/(p-pv) if p>pv else math.inf;mv=vg*rv
 if mv<=1:
  ml=1-mv;rhoL=P('D','P',p,'T',T,'Water');hl=P('H','P',p,'T',T,'Water');sl=P('S','P',p,'T',T,'Water');hv=P('H','T',T,'Q',1,'Water');sv=P('S','T',T,'Q',1,'Water');v=ml/rhoL+vg;branch='wet'
 else:
  # Only stable undersaturated native vapor is evaluated, never forced metastability.
  rhoV=brentq(lambda rho:P('P','D',rho,'T',T,'Water')+Ar*T*rho-p,1e-10,rv,xtol=1e-12)
  vg=1/rhoV;pv=P('P','D',rhoV,'T',T,'Water');mv=1.;ml=0.;hl=sl=0.;hv=P('H','D',rhoV,'T',T,'Water');sv=P('S','D',rhoV,'T',T,'Water');v=vg;branch='dry'
 liquidH=ml*hl;gasH=mv*hv;entropy=ml*sl+mv*sv;partial={}
 for n,m in masses.items():
  if m==0:continue
  R=species[n]['R'];cv=species[n]['cv'];pj=m*R*T/vg;partial[n]=pj;gasH+=m*(cv*(T-298.15)+R*T);entropy+=m*((cv+R)*math.log(T/298.15)-R*math.log(pj/101325))
 h=(liquidH+gasH)/mt;v/=mt
 return dict(p=p,T=T,h=h,s=entropy/mt,rho=1/v,v=v,u=h-p*v,ml=ml/mt,mv=mv/mt,partial=partial,liquidH=liquidH/mt,gasH=gasH/mt,branch=branch,pv=pv,waterFraction=1/mt)
def match(p,key,target,masses):
 if sum(masses.values())==0:return water(p,**{key:target})
 return material(p,brentq(lambda T:material(p,T,masses)[key]-target,273.16,623.15,xtol=2e-10),masses)
def prepared(p,T,alpha):
 pv=P('P','T',T,'Q',1,'Water');mw=(1-alpha)*P('D','P',p,'T',T,'Water')+alpha*P('D','T',T,'Q',1,'Water')
 return {n:alpha*.5*(p-pv)/(species[n]['R']*T)/mw for n in species}
ordinary=prepared(15.2e6,563.15,.01)
# Dry contrary: prescribed total partial-pressure split 50% steam,25% air,25% N2.
Tdry=623.15;pd=15.2e6;rw=P('D','P',pd*.5,'T',Tdry,'Water');dryMass={n:pd*.25/(species[n]['R']*Tdry)/rw for n in species}
rows=[]
for label,T,masses,caseAlpha in [('hot-wet',563.15,ordinary,0.),('dry-gas-bound',Tdry,dryMass,1.),('zero-NC',563.15,{'air':0.,'nitrogen':0.},0.)]:
 n=.2;d=material(pd,T,masses);caseRho=r0 if caseAlpha==0 else .5*p0*(1/287+1/296.8)/313.15
 available=(p0-P('P','T',313.15,'Q',1,'Water'))/(caseRho*9.80665) if caseAlpha==0 else None
 def evaluate(mag):
  q=mag/(caseRho*Q0);need=b['npshSpeed_m']*n*n+b['npshFlow_m']*q*q if caseAlpha==0 else None;F=min(1,available/need)**2 if caseAlpha==0 else 0
  de=dp0*caseRho/r0*F*n*(1.25*n-k*q);ps=pd-de;z=match(ps,'s',d['s'],masses)
  at=lru_cache(maxsize=None)(lambda p:match(p,'s',z['s'],masses));noz=nozzle(z,p0,at,17)
  return F,q,de,z,noz,at,need
 mag=brentq(lambda m:m-CdA*evaluate(m)[4]['G'],.001,30,xtol=1e-9);F,q,de,z,noz,at,need=evaluate(mag);dh=z['h']-d['h'];mixHeat=H0*caseRho/r0*F*n*n*q;brakeHeat=2*max(0,-mag*dh);heat=mixHeat+brakeHeat;r=match(p0,'h',z['h']+heat/mag,masses)
 integral=(-de)*quad(lambda x:1/match(pd-x*de,'s',d['s'],masses)['rho'],0,1,epsabs=1e-6,epsrel=1e-8)[0] if de else 0.
 check(label+' exact incoming-work-receiving ledger',abs(mag*(r['h']-d['h'])-(mag*dh+heat))<1e-5)
 check(label+' receiver entropy does not decrease',r['s']>=d['s']-1e-6)
 check(label+' finite actual case factor',0<=F<=1 and (caseAlpha==0 or F==0))
 fine=nozzle(z,p0,at,129);check(label+' independent throat search',abs(fine['G']/noz['G']-1)<1e-6)
 if masses['air']+masses['nitrogen']:
  check(label+' receiving species and phase enthalpy',abs(r['liquidH']+r['gasH']-r['h'])<1e-7 and abs(r['ml']+r['mv']+sum(masses.values())/(1+sum(masses.values()))-1)<1e-12)
 # Compare NC caloric change and density at actual partial pressures, not arbitrary energy zeros.
 sensitivity=[]
 for name,m in masses.items():
  if m==0:continue
  nativeName='Air' if name=='air' else 'Nitrogen';R=species[name]['R'];cv=species[name]['cv'];pp=d['partial'][name]
  nativeDh=P('H','T',d['T'],'P',pp,nativeName)-P('H','T',298.15,'P',pp,nativeName);idealDh=(cv+R)*(d['T']-298.15)
  nativeRho=P('D','T',d['T'],'P',pp,nativeName);idealRho=pp/(R*d['T'])
  sensitivity.append(dict(species=name,partialPressure=pp,idealCp=cv+R,nativeCp=P('C','T',d['T'],'P',pp,nativeName),idealHeatIncrement=idealDh,nativeHeatIncrement=nativeDh,mixtureHeatIncrementDifference=m/(1+sum(masses.values()))*(nativeDh-idealDh),idealDensity=idealRho,nativeDensity=nativeRho))
 rows.append(dict(label=label,m=-mag,n=n,caseDensity=caseRho,caseGasFraction=caseAlpha,F=F,availableNPSH=available,requiredNPSH=need,q=q,donor=d,stage=z,throat=noz,receivingFace=r,pressureExchange=de,work=dh,integratedWork=integral,workRelativeDefect=None if integral==0 else abs((dh-integral)/integral),mixHeat=mixHeat,brakeHeat=brakeHeat,shaftPower=mag*dh+heat,massesPerWater=masses,sensitivity=sensitivity))
 print(json.dumps(dict(completed=label,m=-mag,F=F,work=dh,integratedWork=integral,donorTemperature=T,stageTemperature=z['T'],throatTemperature=noz['state']['T'],receivingTemperature=r['T'],receivingBranch=r.get('branch','native-water'))),file=sys.stderr,flush=True)
# One finite cold case receives a genuinely small hot parcel; no simultaneous outlet imposed.
hot=rows[0];dm=1e-5;Vcase=.05*Q0;M0=Vcase*r0;U0=M0*(a['h']-p0/r0);ratios=ordinary;mt=1+sum(ratios.values());Mw=M0+dm/mt;nc={n:dm*ratios[n]/mt for n in ratios};targetU=U0+dm*hot['receivingFace']['h'];afterRatio={n:nc[n]/Mw for n in nc};Mtotal=Mw+sum(nc.values())
def residual(x):
 s=material(math.exp(x[0]),x[1],afterRatio)
 return [(Mtotal/s['rho']-Vcase)/Vcase,(Mtotal*s['u']-targetU)/max(abs(targetU),1)]
fit=least_squares(residual,[math.log(2e5),313.2],bounds=([math.log(1e5),273.16],[math.log(20e6),623.15]),xtol=1e-12,ftol=1e-12,gtol=1e-12)
after=material(math.exp(fit.x[0]),fit.x[1],afterRatio);dv=Mtotal/after['rho']-Vcase;du=Mtotal*after['u']-targetU
check('Finite casing recovery retains hot input and NC',fit.success and abs(dv)<1e-12 and abs(du)<.001 and all(v>0 for v in nc.values()))
# Actual homogeneous withdrawal from the new case, not immediate transit of incoming hot parcel.
outgoing=match(p0,'h',after['h'],afterRatio);amount=1e-6
outResidual=float(outgoing['liquidH']+outgoing['gasH']-after['h'])
check('Actual case-to-BLEND finite transfer energy',abs(amount*outResidual)<1e-8)
receipt=dict(volume=Vcase,initialWater=M0,initialEnergy=U0,incomingMass=dm,incomingEnergy=dm*hot['receivingFace']['h'],water=Mw,NC=nc,totalEnergy=targetU,after=after,volumeResidual=dv,energyResidual=du,BLEND=dict(parcelMass=amount,liquid=amount*outgoing['ml'],steam=amount*outgoing['mv'],NC={n:amount*afterRatio[n]/(1+sum(afterRatio.values())) for n in nc},liquidEnergy=amount*outgoing['liquidH'],gasEnergy=amount*outgoing['gasH'],totalEnergy=amount*after['h'],enthalpyRecoveryResidual_J_kg=outResidual,originalAbsoluteEnthalpyScreenPassed=abs(outResidual)<1e-7,transferEnergyResidual_J=amount*outResidual,transferEnergyAllowance_J=1e-8),meaning='Two frozen finite receipt/withdrawal coupons; no actual interval, displacement history or steady cold casing claim')
print(json.dumps(dict(libraries=dict(CoolProp=CoolProp.__version__,SciPy=scipy.__version__),calibration=dict(rho=r0,Q0=Q0,dp0=dp0,CdA=CdA,H0=H0,omega0=w0),rows=rows,receipt=receipt,checks=checks)))
`
if(import.meta.main){
 const [feed,charge,python,receipt,...extra]=process.argv.slice(2)
 if(!feed||!charge||!python||extra.length)throw new Error('Usage: <feed-equipment> <inventory-owner> <python> [receipt]')
 const files=[feed,charge,resolve(charge,'../two-phase-and-breaks.md'),import.meta.path,...['reference-design-service-pump-signed.ts','reference-design-service-pump-continuation.ts','reference-design-service-pump-mixture.ts'].map(p=>resolve(import.meta.dir,p))]
 const hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');const sources=files.map(path=>({path,sha256:hash(path)}))
 const basis=readServicePump(charge),selection=parseSelection(readFileSync(feed,'utf8'))
 if(basis.id!=='CHARGE')throw new Error('Requires actual CHARGE basis')
 const run=spawnSync(python,['-c',calculation],{input:JSON.stringify({basis,selection,species:gasConstants}),encoding:'utf8'})
 if(run.status!==0)throw new Error(run.stderr||'Hot material comparison failed')
 const result=JSON.parse(run.stdout);const c=result.calibration
 for(const row of result.rows){
  const dp=pressureExchange(c.dp0,row.caseDensity/c.rho,selection.crossCoefficient,row.n,-row.q,row.F)
  const loss=streamLoss(c.H0,row.caseDensity/c.rho,row.F,row.n*c.omega0,c.omega0,-row.q)
  const exchange=row.m===0?0:Math.abs(row.m)*row.work/(row.n*c.omega0);const brake=backflowBrake(row.m,row.n*c.omega0,exchange)
  if(Math.abs(dp-row.pressureExchange)>1e-6||Math.abs(loss.power-row.mixHeat)>1e-6||Math.abs(brake.power-row.brakeHeat)>1e-6)throw new Error('Independent machine incidence mismatch')
  row.workComparison=hotWorkComparison(row.work,row.integratedWork)
  if(!row.workComparison.admitted)throw new Error(row.label+' exceeds existing effective work budget: '+JSON.stringify(row.workComparison))
  result.checks.push(row.label+' effective work proxy admitted',row.label+' independent selected machine incidence')
 }
 if(sources.some(s=>hash(s.path)!==s.sha256))throw new Error('Source changed during comparison')
 const output={scope:'Named hot CHARGE fixed-state work/phase/receiving decision; no rectangular accuracy claim or installed transient',sources,...result}
 if(receipt)await Bun.write(receipt,JSON.stringify(output,null,2)+'\n')
 console.log(JSON.stringify(receipt?{receipt,checks:result.checks.length,rows:result.rows.map((r:{label:string;m:number;F:number;workComparison:unknown;donor:{T:number};stage:{T:number};throat:{state:{T:number}};receivingFace:{T:number;branch?:string}})=>({label:r.label,m:r.m,F:r.F,work:r.workComparison,donor:r.donor.T,stage:r.stage.T,throat:r.throat.state.T,receiver:r.receivingFace.T,phase:r.receivingFace.branch})),finite:result.receipt}:output,null,2))
}
