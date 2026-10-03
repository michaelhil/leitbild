/** One finite HP admission/shaft coupon with prescribed boundary states, not a plant. */
import { createHash } from 'node:crypto'
import { runCycle } from './reference-design-cycle'
import { parseTurbinePreparation } from './reference-design-turbine-preparation'
import { pureWaterNozzleFunctions } from './reference-design-pure-water-nozzle'

const calculation = String.raw`
import sys,json,math,time,signal
import numpy as np
from scipy.integrate import solve_ivp
from CoolProp.CoolProp import PropsSI as P, PhaseSI
import CoolProp,scipy
d=json.load(sys.stdin);signal.alarm(600);b=d['body'];exec(d['nozzle']);c=d['cycle'];omega0=1500*2*math.pi/60
J=2*5500e6/omega0**2;loss=.005-.5/1030.662217;V=10.;C=b['hpCapacity_J_K'];G=b['hpContact_W_K'];Cr=2e8
ps=5.98e6;hs=c['points']['main_steam']['h_kJ_kg']*1000;nominal=c['flows']['SG_total_kg_s']*(1-c['flows']['reheat_fraction'])
admArea=nominal/waterflux_ph(ps,hs,5.96e6)
hp=c['points']['HP_bleed'];drop=(hs-hp['h_kJ_kg']*1000)/c['basis']['HPTurbineEfficiency']
R=math.sqrt(2*drop)/(2*omega0);eta=c['basis']['HPTurbineEfficiency']
passageArea=nominal/waterflux_ph(5.96e6,hs,hp['p_MPaAbs']*1e6)
def native(M,U):
 if M<=0:raise ValueError('Negative coupon mass')
 rho=M/V;u=U/M
 T=P('T','Dmass',rho,'Umass',u,'Water');p=P('P','Dmass',rho,'Umass',u,'Water');h=u+p/rho
 q=P('Q','Dmass',rho,'Umass',u,'Water')
 phase=PhaseSI('Dmass',rho,'Umass',u,'Water')
 if phase=='twophase':liquid=M*(1-q)/P('Dmass','T',T,'Q',0,'Water')
 elif phase=='gas':liquid=0.
 else:raise ValueError(('Outside selected water coupon domain',phase,p,T))
 return p,T,h,liquid/V
def vapor_boundary(M):
 T=P('T','Dmass',M/V,'Q',1,'Water');u=P('Umass','T',T,'Q',1,'Water')
 rho=P('Dmass','T',T,'Q',1,'Water')
 dr=P('d(Dmass)/d(T)|sigma','T',T,'Q',1,'Water');du=P('d(Umass)/d(T)|sigma','T',T,'Q',1,'Water')
 return M*u,u+rho*du/dr
def run(name,pr,drainOpen,scale,dt):
 # Original0.5%-liquid40C wet preparation; dry boundary is an explicit event.
 # It is a disclosed wet preparation, not a reached cold unit or removal of NC.
 T0=313.15;ml=.005*V*P('Dmass','T',T0,'Q',0,'Water');mv=.995*V*P('Dmass','T',T0,'Q',1,'Water');M0=ml+mv
 U0=ml*P('Umass','T',T0,'Q',0,'Water')+mv*P('Umass','T',T0,'Q',1,'Water')
 hr=P('Hmass','P',pr,'Q',1,'Water');y0=np.array([M0,U0,T0,303.15,0.,0.,0.,0.,0.])
 # M,U,bodyT,roomT,omega,externalMaterial,externalEnergy,oilEnergy,drainMass.
 drainClose=None
 def rhs(t,y,phase,drainPhase):
  M,U,Tb,Tr,w=y[:5];p,T,h,liquid=native(M,U)
  a=min(.01*scale,t) if phase=='admit' else max(0.,.01*scale-(t-5.))
  mi=a*admArea*(waterflux_ph(ps,hs,p) if ps>=p else -waterflux_ph(p,h,ps))
  inletH=hs if mi>=0 else h
  if p>=pr:
   mo=passageArea*waterflux_ph(p,h,pr);s=P('Smass','P',p,'Hmass',h,'Water');dh=h-P('Hmass','P',pr,'Smass',s,'Water')
   if dh<0:raise ValueError('Negative forward expansion work')
   torque=2*eta*mo*R*(math.sqrt(2*dh)-R*w)
  else:mo=-passageArea*waterflux_ph(pr,hr,p);torque=0.
  outH=h if mo>=0 else hr;work=torque*w
  tl=loss*torque if work>=0 else 0.;drag=500000*w/omega0**2;qo=(tl+drag)*w
  md=0.;hd=h
  drainPosition=1. if drainClose is None or t<=drainClose else max(0.,1-(t-drainClose)/b['drainStroke_s'])
  moving=drainClose is not None and drainClose<t<drainClose+b['drainStroke_s']
  actuator=b['drainMotion_W'] if moving else 0.
  if drainOpen and p>pr:
   hd=P('Hmass','P',p,'Q',0,'Water') if drainPhase=='liquid' else h
   md=drainPosition*b['drainCdA_m2']*waterflux_ph(p,hd,pr)
  qf=G*(T-Tb);qr=b['roomContact_W_K']*(Tb-Tr)
  # Turbine work leaves outgoing transported energy, NOT the upstream store twice.
  ext=mi*inletH-mo*outH-md*hd+work+actuator
  return [mi-mo-md,mi*inletH-mo*outH-md*hd-qf,(qf-qr+actuator)/C,qr/Cr,(torque-tl-drag)/J,mi-mo-md,ext,qo,md]
 pieces=[];y=y0;mode='liquid';events=[];shares=[];eventEnergyCorrections=[]
 for start,end,phase in [(0.,5.,'admit'),(5.,5.+.01*scale,'close'),(5.+.01*scale,10.+.01*scale,'closed')]:
  t=start
  while t<end:
   if len(events)>20:raise ValueError('Unresolved repeated phase events')
   def boundary(t,z):
    full=np.insert(z,1,vapor_boundary(z[0])[0]);B=vapor_boundary(z[0])[1]
    L=np.array(rhs(t,full,phase,'liquid'));Gv=np.array(rhs(t,full,phase,'gas'))
    FL=L[1]-B*L[0];FG=Gv[1]-B*Gv[0]
    share=-FG/(FL-FG) if FL!=FG else 0.
    return full,L,Gv,share,FL,FG
   if mode=='boundary':
    full,L,Gv,share,FL,FG=boundary(t,np.delete(y,1))
    if not (FL>0 and FG<0):
     mode='gas' if FG>=0 else 'liquid'
     continue
    def fun(t,z):
     full,L,Gv,share,FL,FG=boundary(t,z)
     return np.delete(share*L+(1-share)*Gv,1)
    def leave_gas(t,z):return boundary(t,z)[-1]
    def leave_liquid(t,z):return boundary(t,z)[-2]
    leave_gas.terminal=True;leave_gas.direction=1
    leave_liquid.terminal=True;leave_liquid.direction=-1
    sol=solve_ivp(fun,[t,end],np.delete(y,1),events=[leave_gas,leave_liquid],method='Radau',rtol=1e-7,atol=[1e-8,1e-8,1e-8,1e-9,1e-8,.001,.001,1e-8],max_step=dt)
    fullY=np.array([boundary(tt,z)[0] for tt,z in zip(sol.t,sol.y.T)]).T
    shares.extend(boundary(tt,z)[3] for tt,z in zip(sol.t,sol.y.T))
    sol.y=fullY
    nextMode='gas' if len(sol.t_events[0]) else 'liquid'
   else:
    fun=lambda t,q:rhs(t,q,phase,mode)
    def dry_event(t,q):return q[1]-vapor_boundary(q[0])[0]
    dry_event.terminal=True;dry_event.direction=1 if mode=='liquid' else -1
    sol=solve_ivp(fun,[t,end],y,events=dry_event,method='Radau',rtol=1e-7,atol=[1e-8,.001,1e-8,1e-8,1e-9,1e-8,.001,.001,1e-8],max_step=dt)
    nextMode='boundary'
   if not sol.success:raise ValueError(sol.message)
   pieces.append(sol);y=sol.y[:,-1];t=float(sol.t[-1])
   if sol.status==1:
    eventU=vapor_boundary(y[0])[0]
    if abs(y[1]-eventU)>.001:raise ValueError('Phase-event location energy error')
    eventEnergyCorrections.append(eventU-y[1])
    y[1]=eventU
    if drainOpen and drainClose is None:drainClose=2*math.ceil(t/2)
    events.append(dict(time_s=t,fromMode=mode,toMode=nextMode));mode=nextMode
 allY=np.concatenate([q.y for q in pieces],axis=1);times=np.concatenate([q.t for q in pieces]);initial=U0+C*T0+Cr*303.15
 defects=allY[1]+C*allY[2]+Cr*allY[3]+.5*J*allY[4]**2+allY[7]-initial-allY[6]
 states=[native(q[0],q[1]) for q in allY.T];atClose=allY[:,np.argmin(abs(times-(5+.01*scale)))]
 return dict(case=name,scale=scale,maxStep_s=dt,sourcePressure_Pa=ps,receiverPressure_Pa=pr,bodyRise_K=float(y[2]-T0),peakRPM=float(max(allY[4])*60/(2*math.pi)),endRPM=float(y[4]*60/(2*math.pi)),retainedMass_kg=float(y[0]),drained_kg=float(y[8]),maxLiquidFraction=float(max(q[3] for q in states)),endLiquidFraction=states[-1][3],closureRetainedMass_kg=float(atClose[0]),closureRetainedRPM=float(atClose[4]*60/(2*math.pi)),maxEnergyDefect_J=float(max(abs(defects))),massDefect_kg=float(max(abs(allY[0]-M0-allY[5]))),evaluations=sum(q.nfev for q in pieces),admissionClosedAt_s=5+.01*scale,phaseEvents=events,liquidShareRange=[min(shares),max(shares)] if shares else None,drainCloseRequest_s=drainClose,eventEnergyCorrections_J=eventEnergyCorrections,closureMismatch_K=abs(native(atClose[0],atClose[1])[1]-atClose[2]),endMismatch_K=abs(states[-1][1]-y[2]),postClosureBodyRise_K=y[2]-atClose[2],postClosureObservation_s=5.)
rows=[]
for name,pr,drain in [('supported-drain',8000.,True),('closed-drain',8000.,False),('raised-receiver',60000.,True)]:
 for dt in [.1,.05]:
  q=run(name,pr,drain,1.,dt);rows.append(q);print(json.dumps(q),file=sys.stderr,flush=True)
for q in rows:
 assert q['maxEnergyDefect_J']<10 and q['massDefect_kg']<1e-5,q
good=rows[1];assert good['bodyRise_K']>.1 and good['peakRPM']>0 and good['closureRetainedMass_kg']>0,good
assert good['postClosureBodyRise_K']>0 and good['endMismatch_K']<good['closureMismatch_K'] and good['endRPM']<=50,good
for q in rows:
 if q['liquidShareRange']:assert q['liquidShareRange'][0]>=-1e-9 and q['liquidShareRange'][1]<=1+1e-9,q
assert rows[3]['drained_kg']==0 and rows[3]['maxLiquidFraction']>good['maxLiquidFraction'],rows
for i in range(0,len(rows),2):
 assert abs(rows[i]['bodyRise_K']-rows[i+1]['bodyRise_K'])<.01
 assert abs(rows[i]['endRPM']-rows[i+1]['endRPM'])<.1
print(json.dumps(dict(scope='One finite HP1/body/ROOM/shaft pure-water coupon; held source and downstream boundary, no other stages/NC/actual condenser/support/control acquisition. Not complete warming or all-region rolling qualification.',versions=dict(CoolProp=CoolProp.__version__,scipy=scipy.__version__),area_m2=dict(admission=admArea,HPpassage=passageArea),inertia_kg_m2=J,rows=rows)))
`

if (import.meta.main) {
  const [cyclePath, bodyPath, python, receipt, ...extra] = Bun.argv.slice(2)
  if (!cyclePath || !bodyPath || !python || !receipt || extra.length) throw new Error('Usage: turbine-warming <cycle-owner> <casing-owner> <python> <receipt>')
  if (await Bun.file(receipt).exists()) throw new Error(`Refusing to overwrite receipt: ${receipt}`)
  const cycle = await runCycle(await Bun.file(cyclePath).text(), python)
  const body = parseTurbinePreparation(await Bun.file(bodyPath).text())
  const input = JSON.stringify({ cycle, body, nozzle: pureWaterNozzleFunctions })
  const child = Bun.spawn([python, '-c', calculation], { stdin: new Blob([input]), stdout: 'pipe', stderr: 'pipe' })
  const [out, err, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (status) { await Bun.write(receipt, JSON.stringify({ status: 'rejected-calculation', exitStatus: status, diagnostic: err }, null, 2) + '\n'); throw new Error(err || `Warming coupon exit ${status}`) }
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const result = { inputSHA256: hash(input), calculationSHA256: hash(calculation), sourceSHA256: hash(await Bun.file(import.meta.path).text()), ...JSON.parse(out) }
  await Bun.write(receipt, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
}
