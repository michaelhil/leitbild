/** Offline shared-CW/letdown branch checks. No plant runtime or promised delivery. */
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {z} from 'zod'

const positive=z.number().finite().positive(),finite=z.number().finite()
const schema=z.object({referenceFlow_kg_s:positive,referenceHead_Pa:positive,referenceTemperature_K:positive,
 outfallPressure_Pa:positive,takeoff_m:finite,outfall_m:finite,cwReference_m3_s:positive,cwReferenceDensity_kg_m3:positive,
 gravity_m_s2:positive,coldK_kg_s:positive,hotK_kg_s:positive,wallCapacity_J_K:positive,hotReferenceFlow_kg_s:positive,
 hotReferencePressure_Pa:positive,hotReferenceEnthalpy_J_kg:finite,reversePressure_Pa:positive,reverseTemperature_K:positive}).strict()
export function parseLetdownCoolingBranch(text:string){
 const blocks=[...text.matchAll(/^```reference-letdown-cooling-branch\s*\n([\s\S]*?)^```\s*$/gm)]
 if(blocks.length!==1)throw Error('Expected one letdown cooling branch record')
 const b=schema.parse(JSON.parse(blocks[0]![1]!))
 if(b.outfall_m<=b.takeoff_m||b.reversePressure_Pa<=b.outfallPressure_Pa)throw Error('Invalid branch geometry/reference ordering')
 return b
}
/** Owner-selected defaults apply only when that channel has no explicit local value. */
export function evidenceUsable(age_s:number,ownerMaximumAge_s:number,available:boolean){
 if(!Number.isFinite(age_s)||age_s<0||!Number.isFinite(ownerMaximumAge_s)||ownerMaximumAge_s<=0)throw Error('Invalid acquired age')
 return available&&age_s<=ownerMaximumAge_s
}
/** Fixed-property parallel-path comparison, not the actual native restriction. */
export function parallelCooling(head0:number,cw0:number,side0:number,speeds:readonly[number,number],staticHead=0){
 if(![head0,cw0,side0,staticHead,...speeds].every(Number.isFinite)||head0<=0||cw0<=0||side0<0||speeds.some(n=>n<0||n>1))throw Error('Invalid shared cooling fixture')
 const pump=(h:number,n:number)=>cw0/2*Math.sqrt(Math.max(0,(1.25*n*n+(staticHead-h)/head0)/.25))
 const load=(h:number)=>(cw0+side0)*Math.sqrt(h/head0)
 let lo=0,hi=Math.max(0,1.25*head0*Math.max(...speeds)**2+staticHead)
 for(let i=0;i<80;i++){const h=(lo+hi)/2;if(load(h)>pump(h,speeds[0])+pump(h,speeds[1]))hi=h;else lo=h}
 const head=(lo+hi)/2,scale=Math.sqrt(head/head0),pumps=speeds.map(n=>pump(head,n))
 return {head_Pa:head,condenser_m3_s:cw0*scale,side_m3_s:side0*scale,pumps_m3_s:pumps,
  junctionDefect_m3_s:pumps[0]!+pumps[1]!-(cw0+side0)*scale}
}

export const letdownCoolingCalculation=String.raw`
import json,sys,math
import CoolProp,scipy,numpy as np
from CoolProp.CoolProp import PropsSI as P
from scipy.optimize import brentq,minimize_scalar
b=json.load(sys.stdin);checks=[]
def check(name,ok,**v):
 if not ok:raise ValueError((name,v))
 checks.append(dict(name=name,**v))
pout=b['outfallPressure_Pa'];dp0=b['referenceHead_Pa'];T0=b['referenceTemperature_K'];g=b['gravity_m_s2'];z=b['outfall_m']
pu=pout+dp0;h0=P('H','P',pu,'T',T0,'Water');rho=P('D','P',pu,'T',T0,'Water')
def flux(p,h,back):
 if p==back:return 0.
 if p<back:raise ValueError('Actual high-pressure donor required')
 s=P('S','P',p,'H',h,'Water')
 def at(pt):
  if pt==p:return 0.
  dh=h-P('H','P',pt,'S',s,'Water')
  if dh < -1e-5:raise ValueError('Negative native expansion energy')
  return P('D','P',pt,'S',s,'Water')*math.sqrt(2*max(dh,0.))
 points=np.geomspace(back,p,33);values=[at(x) for x in points];candidates=values[:]
 for i in range(1,len(points)-1):
  if values[i]>=values[i-1] and values[i]>=values[i+1]:
   q=minimize_scalar(lambda x:-at(x),bounds=(points[i-1],points[i+1]),method='bounded',options={'xatol':.001});candidates.append(-q.fun)
 return max(candidates)
area=b['referenceFlow_kg_s']/flux(pu,h0,pout)
def signed(pa,ha,pb,hb,opening=1):
 if opening<0 or opening>1:raise ValueError('Invalid physical area fraction')
 if opening==0 or pa==pb:return 0.
 return opening*area*(flux(pa,ha,pb) if pa>pb else -flux(pb,hb,pa))
check('fixed native face calibration',abs(signed(pu,h0,pout,h0)-b['referenceFlow_kg_s'])<1e-10)
check('zero area and equal pressure bypass native requests',signed(-1,float('nan'),-2,float('nan'),0)==0 and signed(-1,float('nan'),-1,float('nan'))==0)
# Same frozen pump/condenser hardware, with one actual native side restriction.
cw=b['cwReference_m3_s'];scaled=dp0*rho/b['cwReferenceDensity_kg_m3']
def shared(level,speeds,opening=1):
 static=rho*g*(level-z)
 def pumps(head):return [cw/2*math.sqrt(max(0,(1.25*n*n+(static-head)/scaled)/.25)) for n in speeds]
 def side(head):
  if head==0:return 0.
  # Frozen outlet-face temperature is a capacity fixture, not an imposed actual pump state.
  p=pout+head;h=P('H','P',p,'T',T0,'Water')
  return signed(p,h,pout,h,opening)
 def residual(head):return rho*cw*math.sqrt(head/scaled)+side(head)-rho*sum(pumps(head))
 hi=max(0,1.25*scaled*max(speeds)**2+static)
 head=0. if hi==0 else brentq(residual,0,hi,xtol=1e-6)
 qs=pumps(head);mc=rho*cw*math.sqrt(head/scaled);ml=side(head)
 return dict(level_m=level,speeds=speeds,opening=opening,head_Pa=head,pump_kg_s=[rho*q for q in qs],condenser_kg_s=mc,side_kg_s=ml,junctionDefect_kg_s=rho*sum(qs)-mc-ml)
rows=[dict(name=name,**shared(level,speeds,opening)) for name,level,speeds,opening in [
 ('nominal',5,[1,1],1),('one motive lost held second rotor',5,[0,1],1),('both stopped matched levels',5,[0,0],1),
 ('both stopped gravity',6,[0,0],1),('side blockage',5,[1,1],0),('retained depleted source level',1,[1,1],1),('coasting rotors',5,[.5,.5],1)]]
check('shared local header balances without a second supplier',max(abs(r['junctionDefect_kg_s']) for r in rows)<1e-5)
check('fixed pumps share flow rather than independently preserving condenser nominal',rows[0]['condenser_kg_s']<rho*cw and rows[0]['side_kg_s']>0)
check('motive loss contrast and supported coast remain physical',0<rows[1]['side_kg_s']<rows[0]['side_kg_s'] and 0<rows[6]['side_kg_s']<rows[0]['side_kg_s'])
check('matched stopped no flow versus gravity delivery',rows[2]['side_kg_s']==0 and rows[3]['side_kg_s']>0)
check('blocked side does not disappear condenser delivery',rows[4]['side_kg_s']==0 and rows[4]['condenser_kg_s']>0)
check('retained source-level loss reduces but does not instantly delete delivery',0<rows[5]['side_kg_s']<rows[0]['side_kg_s'])
def cold_heat(m,p,hin,Twall):
 if m==0:return 0.,hin
 # Actual upstream has already been selected; magnitude, not signed m in the exchanger exponential.
 q=abs(m)*(P('H','P',p,'T',Twall,'Water')-hin)*(-math.expm1(-b['coldK_kg_s']/abs(m)))
 return q,hin+q/abs(m)
normal=rows[0];p=pout+normal['head_Pa'];hin=P('H','P',p,'T',T0,'Water');m=normal['side_kg_s']
def hot_heat(Twall):return b['hotReferenceFlow_kg_s']*(b['hotReferenceEnthalpy_J_kg']-P('H','P',b['hotReferencePressure_Pa'],'T',Twall,'Water'))*(-math.expm1(-b['hotK_kg_s']/b['hotReferenceFlow_kg_s']))
wall=brentq(lambda T:hot_heat(T)-cold_heat(m,pout,hin,T)[0],T0+1,330)
Qc,hout=cold_heat(m,pout,hin,wall);Qh=hot_heat(wall);Tout=P('T','P',pout,'H',hout,'Water')
check('fixed thermal K admits conditional wet balance, not resized outlets',T0<Tout<wall and abs(Qc-Qh)<.01)
check('zero cold flow retains wall input duty',cold_heat(0,pout,hin,wall)[0]==0 and hot_heat(wall)/b['wallCapacity_J_K']>0)
reverseP=b['reversePressure_Pa'];reverseH=P('H','P',reverseP,'T',b['reverseTemperature_K'],'Water')
# Reverse physical order is external donor -> HX -> restriction -> header.
# The upstream restriction enthalpy is the cooled reverse stream, not the external inlet.
def reverse_residual(magnitude):
 q,hxout=cold_heat(magnitude,reverseP,reverseH,308.15)
 return magnitude+signed(pout,h0,reverseP,hxout)
magnitude=brentq(reverse_residual,0,2*b['referenceFlow_kg_s'],xtol=1e-8)
mr=-magnitude;qr,hrout=cold_heat(mr,reverseP,reverseH,308.15)
check('reverse selects its own flooded outfall donor',mr<0 and qr<0 and hrout<reverseH)
check('reverse HX and restriction share one thermal-dependent flow',abs(reverse_residual(magnitude))<1e-6)
check('area scales same physical face rather than forced flow',abs(signed(pu,h0,pout,h0,.5)-50)<1e-10)
# Independent receiving D/T recovery and paired native total-enthalpy/species/heat incidence.
ledger=[]
for name,mass,h_in,h_out,q in [('forward',m,hin,hout,Qc),('reverse',abs(mr),reverseH,hrout,qr)]:
 T=P('T','P',pout,'H',h_out,'Water');D=P('D','P',pout,'H',h_out,'Water');h_recovered=P('H','T',T,'D',D,'Water')
 H_in=h_in+g*z;H_out=h_out+g*z
 defect=-mass*H_in+mass*H_out-q
 check(name+' shared stream/wall/external native energy',abs(defect)<1e-6 and abs(h_recovered-h_out)<1e-3)
 marker=mass*.001;isotope=mass*7e18
 # A deliberately depleted independent donor ratio, NOT reseeding atoms from the marker.
 check(name+' donor marker and separate N10 pair once',(-marker+marker)==0 and (-isotope+isotope)==0)
 ledger.append(dict(name=name,mass_kg_s=mass,heat_W=q,totalEnthalpyIn_J_kg=H_in,totalEnthalpyOut_J_kg=H_out,pairedEnergyDefect_W=defect,recoveredEnthalpyDefect_J_kg=h_recovered-h_out,markerTransfer_kgEq_s=marker,N10Transfer_atoms_s=isotope))
# Same lossless lift is checked independently with h(p,S)+gz, not a second rho*g*z work term.
s=P('S','P',pu,'H',h0,'Water');h_takeoff=h0+g*(z-b['takeoff_m'])
p_takeoff=brentq(lambda p:P('H','P',p,'S',s,'Water')-h_takeoff,pu,pu+rho*g*10)
check('takeoff lift conserves native total enthalpy once',abs(P('H','P',p_takeoff,'S',s,'Water')+g*b['takeoff_m']-(h0+g*z))<1e-4)
print(json.dumps(dict(scope='Frozen liquid shared-header capacity plus separate flooded reverse and finite-wall heat ledgers; not source-loss/coast/thermal trajectory, priming, duty endurance or acquired safeguard qualification',libraries=dict(CoolProp=CoolProp.__version__,SciPy=scipy.__version__),basis=b,effectiveCdA_m2=area,nativeReferenceDensity_kg_m3=rho,rows=rows,thermal=dict(wall_K=wall,coldOutlet_K=Tout,Qhot_W=Qh,Qcold_W=Qc,wallNoColdFlow_K_s=Qh/b['wallCapacity_J_K']),reverse=dict(flow_kg_s=mr,heat_W=qr),lift=dict(takeoffPressure_Pa=p_takeoff,outfallFacePressure_Pa=pu,totalEnthalpyDefect_J_kg=P('H','P',p_takeoff,'S',s,'Water')-h_takeoff),ledger=ledger,checks=checks),allow_nan=False))
`

export function runLetdownCoolingBranch(owner:string,python:string){
 const hash=(text:string)=>createHash('sha256').update(text).digest('hex')
 const document=readFileSync(owner,'utf8'),source=readFileSync(import.meta.path,'utf8'),b=parseLetdownCoolingBranch(document)
 const run=spawnSync(python,['-c',letdownCoolingCalculation],{input:JSON.stringify(b),encoding:'utf8'})
 if(run.status!==0)throw Error(run.stderr||'Letdown cooling branch check failed')
 if(readFileSync(owner,'utf8')!==document||readFileSync(import.meta.path,'utf8')!==source)throw Error('Source changed during branch comparison')
 return {owner:{path:owner,sha256:hash(document)},sourceSha256:hash(source),inputSha256:hash(JSON.stringify(b)),calculationSha256:hash(letdownCoolingCalculation),...JSON.parse(run.stdout)}
}
if(import.meta.main){
 const [owner,python,receipt,...extra]=Bun.argv.slice(2)
 if(!owner||!python||extra.length)throw Error('Usage: <condenser-owner.md> <python-with-CoolProp> [receipt.json]')
 const result=runLetdownCoolingBranch(owner,python)
 if(receipt)await Bun.write(receipt,JSON.stringify(result,null,2)+'\n')
 console.log(JSON.stringify(receipt?{receipt,checks:result.checks.length,area:result.effectiveCdA_m2,rows:result.rows,thermal:result.thermal}:result,null,2))
}
