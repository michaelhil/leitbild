/** Fixed-state serial HEM letdown restriction selection, not a hydraulic transient or valve damage model. */
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {z} from 'zod'

const positive=z.number().finite().positive()
const schema=z.object({stages:z.literal(4),inletPressure_MPa:positive,outletPressure_MPa:positive,
 nominalTemperature_C:positive,nominalFlow_kg_s:positive,nominalOpening:positive.max(1),
 hotTemperatures_C:z.array(positive).min(1),raisedBackpressure_MPa:positive,
 reverseDonorPressure_MPa:positive,reverseReceiverPressure_MPa:positive,reverseTemperature_C:positive,
 regulatingSpeed_s:positive,isolationStroke_s:positive,upstreamPressure_MPa:positive,upstreamTemperature_C:positive}).strict()
 .refine(b=>b.inletPressure_MPa>b.raisedBackpressure_MPa&&b.raisedBackpressure_MPa>b.outletPressure_MPa&&
  b.reverseDonorPressure_MPa>b.reverseReceiverPressure_MPa&&b.upstreamPressure_MPa>b.inletPressure_MPa,'Invalid pressure ordering')
function recordText(document:string){
 const blocks=[...document.matchAll(/^```reference-letdown-trim\s*\n([\s\S]*?)^```\s*$/gm)]
 if(blocks.length!==1)throw new Error('Expected one letdown trim record')
 return blocks[0]![1]!
}
export function parseLetdownTrim(document:string){return schema.parse(JSON.parse(recordText(document)))}
export function closingOpening(initial:number,speed:number,seconds:number){
 if(![initial,speed,seconds].every(Number.isFinite)||initial<0||initial>1||speed<=0||seconds<0)throw new Error('Invalid valve travel')
 return seconds>=initial/speed?0:initial-speed*seconds
}
export const trimCalculation=String.raw`
import json,sys,math
import numpy as np
import CoolProp,scipy
from CoolProp.CoolProp import PropsSI as P
from scipy.optimize import minimize_scalar,least_squares
b=json.load(sys.stdin);checks=[]
def check(name,ok):
 checks.append(dict(name=name,passed=bool(ok)))
def state(p,h):
 return dict(p=p,h=h,s=P('S','P',p,'H',h,'Water'),rho=P('D','P',p,'H',h,'Water'),T=P('T','P',p,'H',h,'Water'),quality=P('Q','P',p,'H',h,'Water'))
def nozzle(pu,h,pd,samples=17):
 if pu==pd:return dict(G=0.,throatPressure=pu,choked=False)
 if pu<pd:raise ValueError('Nozzle requires actual high-pressure donor')
 su=P('S','P',pu,'H',h,'Water')
 def flux(p):
  if p==pu:return 0.
  ht=P('H','P',p,'S',su,'Water');dh=h-ht
  if dh < -1e-5:raise ValueError('Negative expansion energy')
  return P('D','P',p,'S',su,'Water')*math.sqrt(2*max(dh,0.))
 # Bracket any local maximum on a logarithmic pressure scan, retaining both endpoints.
 grid=np.geomspace(pd,pu,samples);values=[flux(x) for x in grid];candidates=[(values[0],pd),(values[-1],pu)]
 brackets=[(grid[0],grid[1]),(grid[-2],grid[-1])]
 brackets.extend((grid[i-1],grid[i+1]) for i in range(1,len(grid)-1) if values[i]>=values[i-1] and values[i]>=values[i+1])
 for lo,hi in brackets:
  opt=minimize_scalar(lambda p:-flux(p),bounds=(lo,hi),method='bounded',options={'xatol':.001})
  candidates.append((-opt.fun,float(opt.x)))
 G,pt=max(candidates)
 return dict(G=G,throatPressure=pt,choked=bool(pt>pd+1.))
pi=b['inletPressure_MPa']*1e6;po=b['outletPressure_MPa']*1e6;a0=b['nominalOpening'];m0=b['nominalFlow_kg_s']
h0=P('H','P',pi,'T',b['nominalTemperature_C']+273.15,'Water');nominalP=np.geomspace(pi,po,5)
areas=np.array([m0/(a0*nozzle(nominalP[i],h0,nominalP[i+1])['G']) for i in range(4)])
def solve(pu,h,pd,opening,reverse=False,seed='geometric',gas=False):
 if opening==0 or pu==pd:return dict(flow=0.,pressures=None,stages=[],meaning='Closed or equal pressure: no invented interior storage state')
 if not pu>pd or not 0<opening<=1:raise ValueError('Invalid supported trim state')
 area=areas[::-1] if reverse else areas
 def gasflux(pup,pdown):
  R=296.8;cv=742.;cp=R+cv;gamma=cp/cv;T=(h+cv*298.15)/cp;critical=(2/(gamma+1))**(gamma/(gamma-1));ratio=max(pdown/pup,critical)
  G=pup*math.sqrt(2*gamma/(R*T*(gamma-1))*(ratio**(2/gamma)-ratio**((gamma+1)/gamma)))
  return dict(G=G,throatPressure=pup*ratio,choked=bool(pdown/pup<critical))
 def geometry(x):
  weights=np.exp(np.r_[x,0]-max(0,max(x)));weights/=sum(weights)
  return np.r_[pu,pu-(pu-pd)*np.cumsum(weights)[:-1],pd]
 def stages(x):
  ps=geometry(x);ns=[gasflux(ps[i],ps[i+1]) if gas else nozzle(ps[i],h,ps[i+1]) for i in range(4)]
  return ps,ns,np.array([opening*area[i]*ns[i]['G'] for i in range(4)])
 def residual(x):
  flows=stages(x)[2]
  if min(flows)<=0:raise ValueError('Degenerate pressure partition')
  return np.log(flows[:3]/flows[3])
 guess=np.geomspace(pu,pd,5) if seed=='geometric' else np.linspace(pu,pd,5)
 drops=-np.diff(guess);x0=np.log(drops[:3]/drops[3])
 # Absolute probes also work at the equal-drop seed x=0; scipy's relative
 # diff_step cannot enlarge a zero coordinate. Acceptance residual is unchanged.
 def jacobian(x):
  step=1e-4;columns=[]
  for i in range(3):
   delta=np.zeros(3);delta[i]=step
   columns.append((residual(x+delta)-residual(x-delta))/(2*step))
  return np.array(columns).T
 fit=least_squares(residual,x0,jac=jacobian,xtol=1e-10,ftol=1e-10,gtol=1e-10,max_nfev=80)
 ps,ns,flows=stages(fit.x);singular=np.linalg.svd(fit.jac,compute_uv=False)
 maximumResidual=float(max(abs(residual(fit.x))))
 admitted=bool(fit.success and maximumResidual<=1e-7 and min(singular)>=1e-6)
 rows=[]
 for i,n in enumerate(ns):
  entropy=(296.8*math.log(ps[i]/ps[i+1])) if gas else P('S','P',ps[i+1],'H',h,'Water')-P('S','P',ps[i],'H',h,'Water')
  if entropy < -1e-6:raise ValueError('Negative stage entropy')
  rows.append(dict(upstream_Pa=float(ps[i]),downstream_Pa=float(ps[i+1]),flow_kg_s=float(flows[i]),entropyRise=entropy,**n))
 return dict(flow=float(np.mean(flows))*(-1 if reverse else 1),pressures=ps.tolist(),stages=rows,minJacobianSingular=float(min(singular)),
  iterations=fit.nfev,seed=seed,admitted=admitted,solverSuccess=bool(fit.success),maximumLogFlowResidual=maximumResidual,
  maximumStageSpread_kg_s=float(max(flows)-min(flows)),termination=fit.message)
rows=[]
for name,T,pdown in [('nominal',b['nominalTemperature_C'],po)]+[('hot-'+str(T),T,po) for T in b['hotTemperatures_C']]+[('raised-backpressure',b['hotTemperatures_C'][-1],b['raisedBackpressure_MPa']*1e6)]:
 h=P('H','P',pi,'T',T+273.15,'Water');a=solve(pi,h,pdown,a0);other=solve(pi,h,pdown,a0,seed='linear')
 check(name+' geometric seed numerical admission',a['admitted'])
 check(name+' linear seed numerical admission',other['admitted'])
 check(name+' two initial pressure partitions agree',abs(a['flow']-other['flow'])<1e-6 and max(abs(np.array(a['pressures'])-other['pressures']))<1.)
 check(name+' native pressure range retained',all(pdown<=p<=pi for p in a['pressures']))
 check(name+' common finite flow',a['flow']>0 and max(r['flow_kg_s'] for r in a['stages'])-min(r['flow_kg_s'] for r in a['stages'])<1e-6)
 received=state(pdown,h);recoveredH=P('H','T',received['T'],'D',received['rho'],'Water')
 energyDefect=a['flow']*(recoveredH-h)
 check(name+' independently recovered receiver enthalpy',abs(recoveredH-h)<1e-3)
 rows.append(dict(name=name,sourceTemperature_C=T,enthalpy_J_kg=h,final=received,
  recoveredEnthalpy_J_kg=recoveredH,sourceReceiverEnergyDefect_W=energyDefect,alternateSeed=other,**a))
check('nominal retained duty',abs(rows[0]['flow']-m0)<1e-7 and max(abs(np.array(rows[0]['pressures'])-nominalP))<.1)
check('hot state includes actual flashing/choking',any(r['final']['quality']>0 for r in rows[1:]) and any(s['choked'] for r in rows[1:] for s in r['stages']))
pr=b['reverseDonorPressure_MPa']*1e6;pl=b['reverseReceiverPressure_MPa']*1e6;hr=P('H','P',pr,'T',b['reverseTemperature_C']+273.15,'Water')
reverse=solve(pr,hr,pl,a0,reverse=True)
check('reverse geometric seed numerical admission',reverse['admitted'])
check('reverse uses reversed physical stage order',reverse['flow']<0)
closed=solve(pi,h0,po,0);equal=solve(pi,h0,pi,a0)
check('closed and equal pressure avoid fictitious stage state',closed['flow']==equal['flow']==0 and closed['pressures'] is None and equal['pressures'] is None)
half=solve(pi,rows[-2]['enthalpy_J_kg'],po,a0/2)
check('shared trim stroke scales flow not pressure distribution at fixed boundaries',abs(half['flow']-rows[-2]['flow']/2)<1e-6)
# Pure nitrogen mathematical branch check, not a calibrated NC-mixture flow claim.
gasH=(742+296.8)*313.15-742*298.15;gas=solve(.3e6,gasH,po,a0,gas=True)
criticalRatio=(2/2.4)**(1.4/.4)
check('pure nitrogen finite flow with actual stage choking classification',gas['flow']>0 and all(s['choked']==(s['downstream_Pa']/s['upstream_Pa']<criticalRatio) for s in gas['stages']))
check('pure nitrogen numerical admission',gas['admitted'])
# Separate final-state constitutive challenge; do not change the serial pressure solution.
throat=[]
for row in rows+[dict(name='reverse',enthalpy_J_kg=hr,**reverse)]:
 for i,stage in enumerate(row['stages']):
  fine=nozzle(stage['upstream_Pa'],row['enthalpy_J_kg'],stage['downstream_Pa'],129)
  relative=abs(fine['G']/stage['G']-1)
  throat.append(dict(case=row['name'],stage=i+1,relativeFluxDifference=relative,throatPressureDifference_Pa=abs(fine['throatPressure']-stage['throatPressure'])))
check('129-point final-state throat challenge below 1e-6 relative flux',max(r['relativeFluxDifference'] for r in throat)<=1e-6)
hp=P('H','P',b['upstreamPressure_MPa']*1e6,'T',b['upstreamTemperature_C']+273.15,'Water')
upstreamArea=m0/nozzle(b['upstreamPressure_MPa']*1e6,hp,pi)['G']
print(json.dumps(dict(scope='Fixed native water serial HEM states and analytic pure-N2 limit; no transient, NC-mixture accuracy, erosion or completed isolation qualification',
 libraries={'CoolProp':CoolProp.__version__,'SciPy':scipy.__version__},basis=b,maximumEffectiveAreas_m2=areas.tolist(),upstreamAggregateArea_m2=upstreamArea,
 rows=rows,reverse=reverse,closed=closed,equal=equal,pureNitrogen=gas,throatChallenge=throat,
 comparisonPassed=all(c['passed'] for c in checks),checks=checks)))
`
if(import.meta.main){
 const [owner,python,receipt,...extra]=Bun.argv.slice(2)
 if(!owner||!python||extra.length)throw new Error('Usage: <inventory-owner.md> <python-with-CoolProp> [receipt.json]')
 const hashText=(text:string)=>createHash('sha256').update(text).digest('hex')
 const hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex')
 const document=readFileSync(owner,'utf8'),recordSha256=hashText(recordText(document)),basis=parseLetdownTrim(document)
 const sources=[import.meta.path].map(path=>({path,sha256:hash(path)}))
 const run=spawnSync(python,['-c',trimCalculation],{input:JSON.stringify(basis),encoding:'utf8'})
 if(run.status!==0)throw new Error(run.stderr||'Serial trim selection failed')
 if(sources.some(s=>hash(s.path)!==s.sha256))throw new Error('Source changed during trim comparison')
 if(hashText(recordText(readFileSync(owner,'utf8')))!==recordSha256)throw new Error('Consumed trim record changed during comparison')
 const result=JSON.parse(run.stdout)
 const travel=[0,.5,1,2,7].map(seconds=>({seconds,regulating:closingOpening(basis.nominalOpening,basis.regulatingSpeed_s,seconds),isolation:closingOpening(1,1/basis.isolationStroke_s,seconds)}))
 result.checks.push({name:'Actual finite regulating and isolation stroke endpoints',passed:travel[3].isolation===0&&travel[3].regulating>0&&travel[4].regulating===0})
 const output={owner:{path:owner,recordSha256,meaning:'Exact consumed trim record, not verification of arbitrary owner prose'},sources,
  calculationSha256:hashText(trimCalculation),...result,travel,comparisonPassed:result.checks.every((c:{passed:boolean})=>c.passed)}
 if(receipt)await Bun.write(receipt,JSON.stringify(output,null,2)+'\n')
 console.log(JSON.stringify(receipt?{receipt,checks:output.checks.length,failedChecks:output.checks.filter((c:{passed:boolean})=>!c.passed),areas:output.maximumEffectiveAreas_m2,rows:output.rows.map((r:{name:string,flow:number,admitted:boolean,maximumLogFlowResidual:number,alternateSeed:unknown,final:unknown})=>({name:r.name,flow:r.flow,admitted:r.admitted,residual:r.maximumLogFlowResidual,final:r.final})),reverse:output.reverse.flow}:output,null,2))
}
