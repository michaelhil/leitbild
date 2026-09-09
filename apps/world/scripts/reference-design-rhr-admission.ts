/** Finite offline RHR filling and optimistic relief-capacity apparatus. No live plant. */
import { createHash } from 'node:crypto'
import { z } from 'zod'

const positive = z.number().finite().positive()
const schema = z.object({
  primaryVolume_m3: positive, headerVolume_m3: positive, trainVolume_m3: positive,
  primaryElevation_m: z.number().finite(), receiverElevation_m: z.number().finite(), dviElevation_m: z.number().finite(),
  referencePressure_MPa: positive, referenceTemperature_C: positive,
  normalPressure_MPa: positive, normalTemperature_C: positive, faultPressure_MPa: positive, faultTemperature_C: positive,
  receiverPressure_MPa: positive, receiverTemperature_C: positive,
  commonReferenceFlow_kg_s: positive, commonLosses_Pa: z.tuple([positive, positive, positive]),
  fillCdA_m2: positive, reliefCdA_m2: positive, reliefOpen_MPa: positive, reliefReseat_MPa: positive,
  envelope_MPa: positive, containmentPressure_MPa: positive, valveStroke_s: positive, normalDuration_s: positive,
}).strict().superRefine((b, c) => {
  if (!(b.containmentPressure_MPa < b.receiverPressure_MPa && b.receiverPressure_MPa < b.reliefReseat_MPa
    && b.reliefReseat_MPa < b.reliefOpen_MPa && b.reliefOpen_MPa < b.envelope_MPa && b.envelope_MPa < b.faultPressure_MPa)
    || b.receiverElevation_m >= b.primaryElevation_m || b.dviElevation_m <= b.primaryElevation_m)
    c.addIssue({ code: 'custom', message: 'Invalid pressure or physical datum ordering' })
})

export function parseRhrAdmissionBasis(document: string) {
  const blocks = [...document.matchAll(/^```reference-rhr-admission\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw new Error('Expected one reference-rhr-admission block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}

export const rhrAdmissionCalculation = String.raw`
import json,sys,math,time,platform
import numpy as np
import scipy,iapws
from functools import lru_cache
from types import MappingProxyType
from scipy.integrate import solve_ivp
from scipy.optimize import minimize_scalar,root
from iapws.iapws97 import _Region1,_Region2,_PSat_T,_TSat_P
b=json.load(sys.stdin);g=9.80665;started=time.monotonic()
@lru_cache(maxsize=65536)
def water(p,T):
 if not (.000611657<p<100 and 273.15<T<623.15 and p>_PSat_T(T)):
  raise ValueError('Unadmitted liquid store: '+str((p,T)))
 r=_Region1(float(T),float(p));rho=1/r['v'];h=r['h']*1000
 return MappingProxyType(dict(p=p,T=T,rho=rho,h=h,u=h-p*1e6/rho,s=r['s']*1000,cp=r['cp']*1000,alpha=r['alfav'],kappa=r['kt']/1e6))
@lru_cache(maxsize=65536)
def ps(p,s,guess):
 ts=_TSat_P(float(p));l=_Region1(ts,p)
 if s>=l['s']*1000:
  v=_Region2(ts,p);x=(s/1000-l['s'])/(v['s']-l['s'])
  if not 0<=x<=1:raise ValueError('Nozzle isentrope outside liquid/wet scope')
  return MappingProxyType(dict(h=1000*(l['h']+x*(v['h']-l['h'])),rho=1/(l['v']+x*(v['v']-l['v'])),T=ts,x=x))
 T=min(guess,ts)
 for _ in range(8):
  r=_Region1(T,p);d=r['s']*1000-s
  if abs(d)<1e-9:break
  T-=d*T/(r['cp']*1000)
 r=_Region1(T,p)
 if abs(r['s']*1000-s)>1e-7:raise ValueError('Isentrope residual')
 return MappingProxyType(dict(h=r['h']*1000,rho=1/r['v'],T=T,x=0.))
xg,wg=np.polynomial.legendre.leggauss(3)
def integral_v(pa,pb,s,T):
 return (pb-pa)*1e6/2*sum(w/ps((pa+pb)/2+(pb-pa)*x/2,s,T)['rho'] for x,w in zip(xg,wg))
def face(w,dz):
 if dz==0:return w
 p=w['p']-w['rho']*g*dz/1e6
 for _ in range(4):
  v=ps(p,w['s'],w['T']);defect=integral_v(w['p'],p,w['s'],w['T'])+g*dz
  p-=defect*v['rho']/1e6
 v=ps(p,w['s'],w['T'])
 if v['x']!=0:raise ValueError('Hydrostatic port not liquid')
 return dict(p=p,T=v['T'],rho=v['rho'],h=w['h']-g*dz,s=w['s'])
def nozzle(up,pdown):
 if pdown>=up['p']:return 0.
 def flux(p):
  d=ps(float(p),up['s'],up['T'])
  dh=up['h']-d['h']
  if abs(up['p']-p)<.001:dh=-integral_v(up['p'],float(p),up['s'],up['T'])
  if dh < -1e-5:raise ValueError('Negative nozzle kinetic energy')
  return d['rho']*math.sqrt(max(0.,2*dh))
 # Split at saturation entropy: endpoint and one maximum on each phase interval.
 from scipy.optimize import brentq
 def sat_s(p):return _Region1(_TSat_P(p),p)['s']*1000-up['s']
 cuts=[pdown,up['p']]
 if sat_s(pdown)*sat_s(up['p'])<0:cuts.insert(1,brentq(sat_s,pdown,up['p'],xtol=1e-11))
 candidates=[flux(p) for p in cuts]
 for lo,hi in zip(cuts,cuts[1:]):
  if hi-lo>1e-10:
   r=minimize_scalar(lambda p:-flux(p),bounds=(lo,hi),method='bounded',options={'xatol':1e-9})
   candidates.append(flux(r.x))
 return max(candidates)
ref=water(b['referencePressure_MPa'],b['referenceTemperature_C']+273.15);r0=ref['rho']
drop=sum(b['commonLosses_Pa'])/1e6
common_area=b['commonReferenceFlow_kg_s']/nozzle(ref,ref['p']-drop)
# Zero-speed positive-flow pump and reverse MINFLOW passage are parallel.
# The actual return check is after HX/FCV, before DVI/WST return selection.
kp=.25*.5e6/165**2;km=.5e6/15**2
kparallel=1/(1/math.sqrt(kp)+1/math.sqrt(km))**2
kht=.05e6/150**2+kparallel
kreturn=(.15+.15+.10)*1e6/150**2
def orifice(pa,pb,k,check=False):
 dp=(pa['p']-pb['p'])*1e6
 if check and dp<=0:return 0.
 rho=(pa if dp>=0 else pb)['rho']
 return math.copysign(math.sqrt(abs(dp)*rho/r0/k),dp)
V=np.array([b['primaryVolume_m3'],b['headerVolume_m3'],b['trainVolume_m3']])
z=np.array([b['primaryElevation_m'],b['receiverElevation_m'],b['receiverElevation_m']])
def stored(ws):
 m=np.array([v*w['rho'] for v,w in zip(V,ws)])
 e=m*np.array([w['u']+g*zz for w,zz in zip(ws,z)])
 s=m*np.array([w['s'] for w in ws])
 return m,e,s
def storage_jac(w,i):
 m=V[i]*w['rho'];u=w['u']+g*z[i];p=w['p']*1e6
 return np.array([[m*w['kappa']*1e6,-m*w['alpha']],
  [V[i]*(w['rho']*w['kappa']*u+p*w['kappa']-w['T']*w['alpha'])*1e6,
   m*(w['cp']-p*w['alpha']/w['rho']-w['alpha']*u)]])
def rates(t,y,kind,relief):
 ws=[water(y[2*i],y[2*i+1]) for i in range(3)]
 ph=face(ws[0],z[1]-z[0]);pd=face(ws[0],b['dviElevation_m']-z[0]);td=face(ws[2],b['dviElevation_m']-z[2])
 area=b['fillCdA_m2']*(min(t/b['valveStroke_s'],1.) if kind=='normal' else 1.) if kind!='full' else common_area
 a,bb=(ph,ws[1]) if ph['p']>=ws[1]['p'] else (ws[1],ph)
 qf=area*nozzle(a,bb['p'])*(1 if ph['p']>=ws[1]['p'] else -1)
 qht=orifice(ws[1],ws[2],kht) if kind=='normal' else 0.
 qr=orifice(td,pd,kreturn,True) if kind=='normal' else 0.
 qrel=b['reliefCdA_m2']*nozzle(ws[1],b['containmentPressure_MPa']) if relief else 0.
 dm=np.zeros(3);de=np.zeros(3);flux=[]
 for i,j,q in [(0,1,qf),(1,2,qht),(2,0,qr)]:
  donor=i if q>=0 else j;H=ws[donor]['h']+g*z[donor]
  dm[i]-=q;dm[j]+=q;de[i]-=q*H;de[j]+=q*H;flux.append((q,q*H))
 Hrel=ws[1]['h']+g*z[1];dm[1]-=qrel;de[1]-=qrel*Hrel
 d=[]
 for i,w in enumerate(ws):
  # Exact IF97 thermodynamic differential of fixed-volume M and U+Mgz.
  d.extend(np.linalg.solve(storage_jac(w,i),[dm[i],de[i]]))
 # Independent face integrals retain signed FILL, header/train, DVI and relief.
 d.extend(v for pair in flux for v in pair);d.extend([qrel,qrel*Hrel,qrel*ws[1]['s']])
 return np.array(d),ws,flux,qrel
def physical_jac(t,y,kind,opened,factor=1.):
 J=np.zeros((len(y),len(y)))
 # Counters have no feedback. Disconnected train has exactly zero influence.
 for i in range(6 if kind=='normal' else 4):
  h=factor*(1e-6 if i%2==0 else 1e-4)
  a=y.copy();c=y.copy();a[i]+=h;c[i]-=h
  J[:,i]=(rates(t,a,kind,opened)[0]-rates(t,c,kind,opened)[0])/(2*h)
 return J
def normal_implicit(step,duration=None,jac_factor=1.,restart=None):
 start=time.monotonic();end=b['normalDuration_s'] if duration is None else duration
 count=round(end/step)
 if abs(count*step-end)>1e-12:raise ValueError('Nonintegral normal step count')
 w0=water(b['normalPressure_MPa'],b['normalTemperature_C']+273.15)
 ph=face(w0,z[1]-z[0])
 xx=np.array([w0['p'],w0['T'],(ph['p']-b['receiverPressure_MPa'])*1e6,
  b['receiverTemperature_C']+273.15,0.,b['receiverTemperature_C']+273.15,0.,0.,0.])
 time_origin=0.
 if restart is not None:time_origin,values=restart;xx=np.array(values,dtype=float)
 scale=np.array([.001,.1,1000.,.1,1.,.1,1.,1.,1.])
 probe=np.array([1e-6,1e-4,.001,1e-4,.001,1e-4,1e-5,1e-5,1e-5])*jac_factor
 def unpack(x):
  wp=water(x[0],x[1]);ph=face(wp,z[1]-z[0]);wh=water(ph['p']-x[2]/1e6,x[3]);wt=water(wh['p']-x[4]/1e6,x[5])
  return [wp,wh,wt],ph
 def transport(x,ws):
  dm=np.zeros(3);de=np.zeros(3);ff=[]
  for i,j,q in [(0,1,x[6]),(1,2,x[7]),(2,0,x[8])]:
   donor=i if q>=0 else j;H=ws[donor]['h']+g*z[donor]
   dm[i]-=q;dm[j]+=q;de[i]-=q*H;de[j]+=q*H;ff.extend([q,q*H])
  return dm,de,np.array(ff)
 def laws(x,ws,ph,t):
  hh=x[2];a,bb=(ph,ws[1]) if hh>=0 else (ws[1],ph);area=b['fillCdA_m2']*min(t/b['valveStroke_s'],1.)
  if abs(hh)<1000:
   # Same isentropic nozzle integral, with the explicit small head retained.
   dr=ps(a['p']-abs(hh)/1e6,a['s'],a['T'])
   vmean=.5*sum(w/ps(a['p']-abs(hh)*(1+x)/2e6,a['s'],a['T'])['rho'] for x,w in zip(xg,wg))
   G2=2*dr['rho']**2*abs(hh)*vmean
  else:G2=nozzle(a,bb['p'])**2
  lf=x[6]*abs(x[6])-math.copysign(area**2*G2,hh)
  donor=ws[1] if x[7]>=0 else ws[2]
  lh=x[4]-kht*r0/donor['rho']*x[7]*abs(x[7])
  pd=face(ws[0],b['dviElevation_m']-z[0]);td=face(ws[2],b['dviElevation_m']-z[2])
  lr=x[8]-orifice(td,pd,kreturn,True)
  return np.array([lf,lh,lr])
 ws,_=unpack(xx);m0,e0,s0=stored(ws);initialM=m0.copy();initialE=e0.copy();initialS=sum(s0)
 totals=np.zeros(9);rows=[];maxm=maxe=0.;mins=minht=0.;nfev=0;max_laws=np.zeros(3)
 reconstruction_error=0.;max_return_head=-math.inf;max_header_pressure=0.
 def record(t,x,ws):
  nonlocal reconstruction_error,max_return_head,max_header_pressure
  reconstruction_error=max(reconstruction_error,abs((ws[1]['p']-ws[2]['p'])*1e6-x[4]))
  pd=face(ws[0],b['dviElevation_m']-z[0]);td=face(ws[2],b['dviElevation_m']-z[2])
  max_return_head=max(max_return_head,(td['p']-pd['p'])*1e6);max_header_pressure=max(max_header_pressure,ws[1]['p'])
  rows.append(dict(t_s=t,p_MPa=[w['p'] for w in ws],T_C=[w['T']-273.15 for w in ws],
   fill_kg_s=x[6],headerTrain_kg_s=x[7],dviReturn_kg_s=x[8],relief_kg_s=0.,
   fillMass_kg=totals[0],dviReturnMass_kg=totals[4],reliefMass_kg=0.,reliefEnergy_J=0.,
   explicitFillHead_Pa=x[2],explicitHeaderTrainHead_Pa=x[4]))
 record(time_origin,xx,ws)
 for k in range(1,count+1):
  t=time_origin+k*step;old=xx.copy()
  def residual(dx):
   x=old+scale*dx;ww,ph=unpack(x);m,e,_=stored(ww);dm,de,_=transport(x,ww)
   return np.r_[(m-m0-step*dm),(e-e0-step*de)/1e6,laws(x,ww,ph,t)]
  def jacobian(dx):
   cols=[]
   for j in range(9):
    d=probe[j]/scale[j];aa=dx.copy();cc=dx.copy();aa[j]+=d;cc[j]-=d
    cols.append((residual(aa)-residual(cc))/(2*d))
   return np.array(cols).T
  # A new nonzero valve demand needs a nonzero seed for its q|q| row.
  ww,ph=unpack(old);target_squared=old[6]*abs(old[6])-laws(old,ww,ph,t)[0]
  guess=np.zeros(9)
  if old[6]==0.:guess[6]=math.copysign(math.sqrt(abs(target_squared)),target_squared)/scale[6]
  sol=root(residual,guess,jac=jacobian,method='hybr',options={'xtol':1e-10,'maxfev':150})
  rr=residual(sol.x);candidate=old+scale*sol.x;nfev+=sol.nfev
  if not (np.all(np.isfinite(rr)) and np.all(np.isfinite(candidate))) or max(abs(rr[:3]))>1e-5 or max(abs(rr[3:6]))>1e-6 or max(abs(rr[6:]))>1e-6:
   return dict(case='normal',method='conservative backward Euler mixed head/flow',status='REJECTED_LOCAL_STEP',
    maxStep_s=step,checks=dict(localStep=False),failedTime_s=t,lastAcceptedTime_s=time_origin+(k-1)*step,
    lastAcceptedMixedState=old.tolist(),trialMixedState=candidate.tolist(),residual=rr.tolist(),solverMessage=sol.message,
    nfev=nfev,trace=rows,wall_s=time.monotonic()-start)
  xx=candidate;ws,_=unpack(xx);m,e,s=stored(ws);dm,de,ff=transport(xx,ws)
  if not all(np.all(np.isfinite(v)) for v in [m,e,s,dm,de,ff]):raise ValueError('Nonfinite native accepted-state output')
  if ws[1]['p']>=b['reliefOpen_MPa']:raise ValueError('Normal branch crossed excluded relief regime')
  totals[:6]+=step*ff
  max_laws=np.maximum(max_laws,abs(rr[6:]));minht=min(minht,xx[7]);mins=min(mins,sum(s)-initialS)
  expectedM=np.array([-totals[0]+totals[4],totals[0]-totals[2],totals[2]-totals[4]])
  expectedE=np.array([-totals[1]+totals[5],totals[1]-totals[3],totals[3]-totals[5]])
  maxm=max(maxm,max(abs(m-initialM-expectedM)));maxe=max(maxe,max(abs(e-initialE-expectedE)))
  m0=m;e0=e;record(t,xx,ws)
  if k%100==0:print(json.dumps(dict(progress='accepted',case='normal-implicit',maxStep_s=step,t_s=t,
   fill_kg_s=xx[6],headerTrain_kg_s=xx[7],fillHead_Pa=xx[2],headerTrainHead_Pa=xx[4])),file=sys.stderr,flush=True)
 final=np.r_[[v for w in ws for v in [w['p'],w['T']]],totals]
 return dict(case='normal',method='conservative backward Euler mixed head/flow',maxStep_s=step,status='duration',events=[],
  checks=dict(localMass=bool(maxm<=1e-5),localEnergy=bool(maxe<=1.),entropy=bool(mins>=-.01),forwardPumpPassage=bool(minht>=-1e-5)),
  maxLocalMass_kg=maxm,maxLocalEnergy_J=maxe,minEntropyChange_J_K=mins,minimumHeaderTrainFlow_kg_s=minht,
  maxConstitutiveResidual=max_laws.tolist(),maximumHeadReconstructionDifference_Pa=reconstruction_error,
  maximumReturnDrivingHead_Pa=max_return_head,maximumHeaderPressure_MPa=max_header_pressure,
  initialMass_kg=initialM.tolist(),initialEnergy_J=initialE.tolist(),
  finalState=final.tolist(),trace=rows,nfev=nfev,wall_s=time.monotonic()-start)
def run(kind,step,jac_factor=1.,duration=None):
 t0=time.monotonic();fault=kind!='normal'
 y=np.array([b['faultPressure_MPa'] if fault else b['normalPressure_MPa'],
  (b['faultTemperature_C'] if fault else b['normalTemperature_C'])+273.15,
  b['receiverPressure_MPa'],b['receiverTemperature_C']+273.15,
  b['receiverPressure_MPa'],b['receiverTemperature_C']+273.15]+[0.]*9)
 initial=y.copy();m0,e0,s0=stored(rates(0,y,kind,False)[1]);states=[];events=[];t=0.;opened=False;status='duration'
 horizon=duration if duration is not None else (b['normalDuration_s'] if kind=='normal' else 20.)
 def opening(t,y):return y[2]-b['reliefOpen_MPa']
 def limit(t,y):return y[2]-b['envelope_MPa']
 def reseat(t,y):return y[2]-b['reliefReseat_MPa']
 for f in [opening,limit,reseat]:f.terminal=True
 opening.direction=1;limit.direction=1;reseat.direction=-1
 calls=0
 for stage in range(2):
  trial_calls=0
  def rhs(t,y):
   nonlocal trial_calls
   result=rates(t,y,kind,opened);trial_calls+=1
   if trial_calls%1000==0:
    print(json.dumps(dict(progress='trial-not-accepted',case=kind,maxStep_s=step,calls=trial_calls,
     t_s=t,pT=y[:6].tolist(),flows=[x[0] for x in result[2]])),file=sys.stderr,flush=True)
   return result[0]
  ev=[limit,reseat] if opened else [limit,opening]
  sol=solve_ivp(rhs,(t,horizon),y,method='Radau',rtol=1e-9,
   atol=np.array([1e-10,1e-8]*3+[1e-9,1e-2]*3+[1e-9,1e-2,1e-5]),max_step=step,events=ev,
   jac=lambda t,y:physical_jac(t,y,kind,opened,jac_factor))
  calls+=sol.nfev
  states.extend((float(tt),yy.copy(),opened) for tt,yy in zip(sol.t,sol.y.T))
  if not sol.success:raise ValueError('Finite admission integration rejected: '+sol.message)
  t=float(sol.t[-1]);y=sol.y[:,-1].copy()
  if len(sol.t_events[0]):status='equipment-envelope';events.append(dict(event=status,time_s=t,header_MPa=y[2]));break
  if len(sol.t_events[1]):
   if opened:status='ideal-relief-reseat';events.append(dict(event=status,time_s=t,header_MPa=y[2]));break
   opened=True;events.append(dict(event='ideal-relief-full-open',time_s=t,header_MPa=y[2]));continue
  break
 maxm=maxe=0.;mins=0.;minht=0.;rows=[]
 for tt,yy,op in states:
  _,ws,ff,rr=rates(tt,yy,kind,op);m,e,s=stored(ws)
  transfer_m=np.array([-yy[6]+yy[10],yy[6]-yy[8]-yy[12],yy[8]-yy[10]])
  transfer_e=np.array([-yy[7]+yy[11],yy[7]-yy[9]-yy[13],yy[9]-yy[11]])
  maxm=max(maxm,float(max(abs(m-m0-transfer_m))));maxe=max(maxe,float(max(abs(e-e0-transfer_e))))
  mins=min(mins,float(sum(s)-sum(s0)+yy[14]))
  minht=min(minht,ff[1][0])
  rows.append(dict(t_s=tt,p_MPa=yy[:6:2].tolist(),T_C=(yy[1:6:2]-273.15).tolist(),
   fill_kg_s=ff[0][0],headerTrain_kg_s=ff[1][0],dviReturn_kg_s=ff[2][0],relief_kg_s=rr,
   fillMass_kg=yy[6],dviReturnMass_kg=yy[10],reliefMass_kg=yy[12],reliefEnergy_J=yy[13]))
 # Signed extension aids the nonlinear solve; substantial accepted reverse
 # pump-path receipt is outside the selected zero-speed forward-loss evidence.
 checks=dict(localMass=maxm<=1e-5,localEnergy=maxe<=1.,entropy=mins>=-.01,forwardPumpPassage=minht>=-1e-5)
 return dict(case=kind,maxStep_s=step,status=status,events=events,checks=checks,maxLocalMass_kg=maxm,
  maxLocalEnergy_J=maxe,minEntropyChange_J_K=mins,minimumHeaderTrainFlow_kg_s=minht,initialMass_kg=m0.tolist(),initialEnergy_J=e0.tolist(),
  finalState=y.tolist(),trace=rows,nfev=calls,wall_s=time.monotonic()-t0)
def compare(a,c):
 if 'finalState' not in a or 'finalState' not in c:return dict(passGate=False,reason='Incomplete physical duration')
 p=max(abs(np.array(a['finalState'][:6:2])-np.array(c['finalState'][:6:2])))*1e6
 T=max(abs(np.array(a['finalState'][1:6:2])-np.array(c['finalState'][1:6:2])))
 mi=[6,8,10,12];ei=[7,9,11,13]
 ma=np.array(a['finalState'])[mi];mc=np.array(c['finalState'])[mi]
 ea=np.array(a['finalState'])[ei];ec=np.array(c['finalState'])[ei]
 m=abs(ma-mc);e=abs(ea-ec)
 mr=m/np.maximum(1e-3,abs(mc));er=e/np.maximum(1.,abs(ec))
 dt=abs(a['trace'][-1]['t_s']-c['trace'][-1]['t_s'])
 event_same=a['status']==c['status'] and [x['event'] for x in a['events']]==[x['event'] for x in c['events']]
 return dict(pressure_Pa=p,temperature_K=T,massAbsolute_kg=m.tolist(),massRelative=mr.tolist(),
  energyAbsolute_J=e.tolist(),energyRelative=er.tolist(),eventTime_s=dt,sameTerminalEvent=event_same,
  passGate=bool(p<=(1000 if a['case']=='normal' else 100) and T<=.05 and max(mr)<=.01 and max(er)<=.01
   and dt<=max(1e-5,.01*c['trace'][-1]['t_s']) and event_same
   and all(a['checks'].values()) and all(c['checks'].values())))
def primitives():
 derivatives=[]
 for p,T in [(1.,423.15),(15.2,563.15),(.3,313.15),(1.3,313.15)]:
  w=water(p,T);J=storage_jac(w,1);fd=[]
  for col,h in [(0,1e-5),(1,1e-3)]:
   aa=[p,T];cc=[p,T];aa[col]+=h;cc[col]-=h
   def me(pt):
    ww=water(*pt);m=V[1]*ww['rho'];return np.array([m,m*(ww['u']+g*z[1])])
   fd.append((me(aa)-me(cc))/(2*h))
  fd=np.array(fd).T;err=float(max((abs(J-fd)/np.maximum(1.,abs(J))).ravel()));derivatives.append(err)
 if max(derivatives)>1e-5:raise ValueError('Storage differential identity failed')
 w=water(1.,313.15);down=face(w,z[1]-z[0]);hw=water(down['p'],down['T'])
 y=np.array([w['p'],w['T'],hw['p'],hw['T'],hw['p'],hw['T']]+[0.]*9)
 _,_,ff,_=rates(2.,y,'normal',False);held=max(abs(q) for q,E in ff)
 if held>.001:raise ValueError('Hydrostatic held-state face flow failed')
 weak=[nozzle(w,w['p']-x/1e6) for x in [0.,.001,.002]]
 if not weak[0]==0<weak[1]<weak[2]:raise ValueError('Weak-head nozzle response failed')
 y=np.array([15.2,563.15,.3,313.15,.3,313.15]+[0.]*9)
 jj=physical_jac(0,y,'full',False);jh=physical_jac(0,y,'full',False,.5)
 row_scale=np.maximum(1e-12,np.max(abs(jj),axis=1))
 scaled=jj/row_scale[:,None];difference=(jj-jh)/row_scale[:,None]
 per_column=[float(max(abs(difference[:,i]))/max(1e-12,max(abs(scaled[:,i])))) for i in range(4)]
 jr=max(per_column)
 if jr>1e-3:raise ValueError('Physical Jacobian half-probe discrepancy '+str(per_column))
 aa=run('full',1e-5,duration=1e-5);cc=run('full',1e-5,jac_factor=.5,duration=1e-5)
 check=compare(aa,cc)
 if not check['passGate']:raise ValueError('First-step half-probe root/ledger mismatch')
 return dict(storageDerivativeRelative=derivatives,heldMaximumFlow_kg_s=held,weakHeadFlux_kg_m2_s=weak,
  activeJacobianHalfProbeRelative=per_column,chokedDownstreamDerivative_kg_s_MPa=[jj[6,2],jh[6,2]],
  firstStepHalfProbe=check,firstStep=aa)
mode=sys.argv[1] if len(sys.argv)>1 else 'all'
if mode not in ['normal','normal-step','limited','full','all','primitive']:raise ValueError('Unknown case')
out=dict(scope='Finite uniform-liquid apparatus; no gas, actual plant dynamics, relief lift law or protection qualification',
 python=platform.python_version(),iapws=iapws.__version__,numpy=np.__version__,scipy=scipy.__version__,basis=b,
 propertyCache='water(p,T) and ps(p,s,Tguess), exact keys, maximum65536 each, immutable mapping records; no interpolation',
 commonEquivalentCdA_m2=common_area,referenceDensity_kg_m3=r0,stoppedPumpParallelResistance=kparallel)
out['primitives']=primitives()
if mode=='normal-step':
 aa=normal_implicit(.02,duration=.02);cc=normal_implicit(.02,duration=.02,jac_factor=.5)
 out['normalFirstStep']=dict(full=aa,half=cc,comparison=compare(aa,cc))
elif mode!='primitive':
 cases=['normal','limited','full'] if mode=='all' else [mode];result=[]
 for kind in cases:
  step=.02 if kind=='normal' else (.005 if kind=='limited' else .00001)
  a=normal_implicit(step) if kind=='normal' else run(kind,step)
  c=normal_implicit(step/2) if kind=='normal' else run(kind,step/2)
  comparison=compare(a,c)
  if kind=='normal' and 'finalState' in a and 'finalState' in c:
   pc=tc=mc=0.
   for ra,rc in zip(a['trace'],c['trace'][::2]):
    pc=max(pc,max(abs(np.array(ra['p_MPa'])-np.array(rc['p_MPa'])))*1e6)
    tc=max(tc,max(abs(np.array(ra['T_C'])-np.array(rc['T_C']))))
    mc=max(mc,abs(ra['fillMass_kg']-rc['fillMass_kg']))
   comparison['history']=dict(pressure_Pa=pc,temperature_K=tc,fillMassDifference_kg=mc)
   comparison['passGate']=bool(comparison['passGate'] and pc<=1000 and tc<=.05)
  result.append(dict(coarse=a,fine=c,comparison=comparison))
 out['cases']=result
out['elapsed_s']=time.monotonic()-started
print(json.dumps(out,default=lambda x:x.item() if isinstance(x,np.generic) else (_ for _ in ()).throw(TypeError(str(type(x)))),allow_nan=False))
`

export async function runRhrAdmission(document: string, python: string, mode = 'all') {
  const input = JSON.stringify(parseRhrAdmissionBasis(document))
  const source = await Bun.file(import.meta.path).text()
  const child = Bun.spawn([python, '-c', rhrAdmissionCalculation, mode], { stdin: Buffer.from(input), stdout: 'pipe', stderr: 'pipe' })
  const stderr = (async () => {
    const decoder = new TextDecoder()
    let retained = ''
    for await (const bytes of child.stderr) {
      const chunk = decoder.decode(bytes, { stream: true })
      retained += chunk
      process.stderr.write(chunk)
    }
    return retained
  })()
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), stderr, child.exited])
  if (code !== 0) throw new Error(`RHR admission failed (${code}): ${err}`)
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  return { ...JSON.parse(out), inputSha256: hash(input), calculationSha256: hash(rhrAdmissionCalculation), sourceSha256: hash(source) }
}

if (import.meta.main) {
  const [owner, python, mode = 'all', ...extra] = Bun.argv.slice(2)
  if (!owner || !python || extra.length || !['normal', 'normal-step', 'limited', 'full', 'all', 'primitive'].includes(mode))
    throw new Error('Usage: bun reference-design-rhr-admission.ts <owner.md> <python> [normal|normal-step|limited|full|all|primitive]')
  console.log(JSON.stringify(await runRhrAdmission(await Bun.file(owner).text(), python, mode), null, 2))
}
