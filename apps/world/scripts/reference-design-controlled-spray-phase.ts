/** Offline spray restriction/contact selection. No line or vessel trajectory. */
import { createHash } from 'node:crypto'
import { controlledSprayBasis } from './reference-design-controlled-spray-delivery'
import { poolBoilingPython } from './reference-design-pool-boiling'
import { nativePoolContactPython } from './reference-design-native-pool-contact'

export function sprayPhaseAreas(area: number, liquidVolumeFraction: number) {
  if (!Number.isFinite(area) || area < 0 || !Number.isFinite(liquidVolumeFraction) || liquidVolumeFraction < 0 || liquidVolumeFraction > 1) throw Error('Physical phase area required')
  return { liquid: area * liquidVolumeFraction, gas: area * (1 - liquidVolumeFraction) }
}
export function sprayCheckArea(area: number, forward: boolean, failedOpen: boolean) {
  if (!Number.isFinite(area) || area < 0) throw Error('Physical open area required')
  return forward || failedOpen ? area : 0
}
export function sprayJetThrust(massFlow: number, speed: number, exitPressure: number, receivingPressure: number, openExitArea: number) {
  if (![massFlow, speed, exitPressure, receivingPressure, openExitArea].every(Number.isFinite) || Math.min(massFlow, speed, openExitArea) < 0 || Math.min(exitPressure, receivingPressure) <= 0) throw Error('Physical jet state required')
  if (openExitArea === 0 && massFlow !== 0) throw Error('Blocked tips cannot carry mass')
  return { momentum: massFlow * speed, pressure: (exitPressure - receivingPressure) * openExitArea }
}

/** Shared named source definitions; extraction preserves the original assembled calculation. */
export const sprayContactDefinitionsPython = String.raw`
import json,sys,math,functools,CoolProp,scipy
from CoolProp.CoolProp import PropsSI as P
from scipy.optimize import brentq,minimize_scalar
from scipy.integrate import quad
d=json.loads(sys.argv[1]);B=d['basis'];g=9.80665;sb=5.670374419e-8;b={'surfaceFactor':1.}
geo={'steelConductivity_W_mK':15.,'steelDensity_kg_m3':7920.,'steelCp_J_kgK':500.}
checks=[]
def check(name,value,bound):
 if not math.isfinite(value) or abs(value)>bound:raise ValueError((name,value,bound))
 checks.append(dict(name=name,value=value,bound=bound))
def admitted(name,condition):check(name,0. if condition else 1.,0.)
${poolBoilingPython}
${nativePoolContactPython}
def steel(T):
 if not 300<=T<=1600:raise ValueError('Selected304solid domain300–1600K')
 return dict(k=8.116+.01618*T,cp=4184*(.1122+3.222e-5*T),e=4184*(.1122*(T-300)+1.611e-5*(T*T-300**2)))
# Independent material adaptation of the same CTF selector; historical shared callers unchanged.
def tube_tmin(p,TL,Twall):
 s=sat(p);m=steel(Twall);hf=s['hv']-s['hl'];ts=s['T']
 eff=math.sqrt(s['kl']*s['rl']*s['cp']/(m['k']*7920*m['cp']))
 x=3203.6-p/6894.757293168
 hn=(705.44-.04722*x+2.3907e-5*x*x-5.8193e-9*x**3-32)*5/9+273.15
 tb=ts+.127*s['rv']*hf/s['kv']*(g*(s['rl']-s['rv'])/(s['rl']+s['rv']))**(2/3)*(s['sigma']/(g*(s['rl']-s['rv'])))**.5*(s['muv']/(g*(s['rl']-s['rv'])))**(1/3)
 henry=tb+.42*(tb-TL)*(eff*hf/(m['cp']*(tb-ts)))**.6
 return max(755.3722222222222,min(898.7055555555555,max(hn+(hn-TL)*eff,henry)))
def tube_film(p,T,Tw,speed):
 s=sat(p);D=B['diameter_m'];tw=min(Tw,s['T']);tf=(T+tw)/2
 def props(temp):
  return [P(k,'P',p,'Q',0,'Water') if abs(temp-s['T'])<1e-7 else P(k,'P',p,'T|liquid',temp,'Water') for k in ['D','V','L','C','ISOBARIC_EXPANSION_COEFFICIENT']]
 rho,mu,k,cp,beta=props(T);_,muw,kw,cpw,_=props(tw);rhof,_,_,_,_=props(tf)
 pr=mu*cp/k;prw=muw*cpw/kw;Re=rho*abs(speed)*D/mu
 if not .5<=pr<=2000:raise ValueError('Selected liquid-film Prandtl domain')
 ratio=min(20.,max(.05,pr/prw)) # Source-defined correction bounds, not state clipping.
 Ra=g*beta*abs(Tw-T)*D**3/(mu/rhof)**2*pr
 natural=max(.59*Ra**.25,.13*Ra**(1/3));f=(1.58*math.log(Re)-3.28)**-2 if Re>1000 else 0.
 forced=(f/2)*(Re-1000)*pr/(1+12.7*math.sqrt(f/2)*(pr**(2/3)-1))*ratio**.11 if Re>1000 else 0.
 return max(3.66,natural,forced)*k/D
@functools.cache
def tube_endpoints(p,TL,speed,factor):
 s=sat(p);D=B['diameter_m'];tm=brentq(lambda t:t-tube_tmin(p,TL,t),755.3722222222222,898.7055555555555)
 qz=.131*(s['hv']-s['hl'])*math.sqrt(s['rv'])*(g*s['sigma']*(s['rl']-s['rv']))**.25*math.sqrt(s['rl']/(s['rl']+s['rv']))
 def pre(t):
  h=tube_film(p,TL,t,speed);q,on=wet_state(p,TL,t,D,h)
  return q,q-h*(t-TL),on
 tc=brentq(lambda t:pre(t)[1]-qz,s['T'],tm);peak=pre(tc)[0];qm=factor*film(p,tm,D,.3)
 if not pre(tc)[2]<tc<tm or not 0<qm<peak:raise ValueError(('Unordered tube endpoints',p,TL,speed,tc,tm,qm,peak))
 return tc,tm,peak,qm,qz
def tube_wet(p,TL,Tw,speed=0.,factor=1.):
 steel(Tw);D=B['diameter_m'];h=tube_film(p,TL,Tw,speed);q,on=wet_state(p,TL,Tw,D,h)
 if Tw<=on:return q,'sensible'
 tc,tm,peak,qm,_=tube_endpoints(p,TL,speed,factor)
 if Tw<=tc:return q,'wet'
 if Tw>=tm:return factor*film(p,Tw,D,.3),'film'
 w=((Tw-tm)/(tc-tm))**2
 return w*peak+(1-w)*qm,'transition'
def gas_heat(T,Tw,p,pv,rv,hv):
 # q positive steel→fluid. HEM owns actual phase conversion; no second mass source.
 steel(Tw);q=5*(Tw-T);j=0.
 if pv>0 and Tw<P('T','P',pv,'Q',1,'Water'):
  j=.01*max(0.,rv-P('D','T',Tw,'Q',1,'Water'))
  q-=j*(hv-P('H','P',p,'T|liquid',Tw,'Water'))
 return q,j
`
const thermalCalculation = String.raw`thermal=[]
for p in [1e5,1e6,15e6]:
 s=sat(p)
 for sub,speed in [(0.,0.),(20.,2.)]:
  TL=s['T']-sub;tc,tm,peak,qm,qz=tube_endpoints(p,TL,speed,1.)
  for Tw in [TL-5,TL,s['T']+1,tc,(tc+tm)/2,tm,950.]:
   q,mode=tube_wet(p,TL,Tw,speed)
   admitted('contact thermodynamic sign',q*(Tw-TL)>=0)
   thermal.append(dict(p=p,liquid_K=TL,wall_K=Tw,speed=speed,q=q,mode=mode))
  check('equal-temperature heat',tube_wet(p,TL,TL,speed)[0],0.)
  for t in [tc,tm]:check('complete curve continuity',(tube_wet(p,TL,t+1e-6,speed)[0]-tube_wet(p,TL,t-1e-6,speed)[0])/peak,1e-5)
  check('ANL endpoint consistency',tm-tube_tmin(p,TL,tm),1e-8)
gas=[]
for pv,T,Tw in [(0.,500.,400.),(1e6,sat(1e6)['T'],350.),(1e6,sat(1e6)['T'],650.)]:
 rv=P('D','P',pv,'Q',1,'Water') if pv else 0.;hv=P('H','P',pv,'Q',1,'Water') if pv else 0.
 q,j=gas_heat(T,Tw,1e6,pv,rv,hv)
 admitted('gas contact heat sign',q*(Tw-T)>=0)
 admitted('absent steam has no condensation',pv>0 or j==0)
 gas.append(dict(pv=pv,T=T,Tw=Tw,q=q,equivalentDemand=j))
# One finite native wet line cell + finite steel: no pressure clamp or mass source.
p=1e6;quality=.1;V=math.pi*B['diameter_m']**2/4;rho=P('D','P',p,'Q',quality,'Water');M=rho*V
u=P('U','P',p,'Q',quality,'Water');T=sat(p)['T'];Tw=950.;As=math.pi*B['diameter_m'];ms=7920*math.pi*((B['diameter_m']/2+B['wall_m'])**2-(B['diameter_m']/2)**2)
alpha=(1-quality)*rho/sat(p)['rl'];qwet=tube_wet(p,T,Tw)[0];qgas=gas_heat(T,Tw,p,p,sat(p)['rv'],sat(p)['hv'])[0];Q=As*(alpha*qwet+(1-alpha)*qgas);dt=.001
u1=u+Q*dt/M;Tw1=brentq(lambda t:ms*(steel(t)['e']-steel(Tw)['e'])+Q*dt,300,Tw)
p1=P('P','D',rho,'U',u1,'Water');T1=P('T','D',rho,'U',u1,'Water');x1=P('Q','D',rho,'U',u1,'Water')
check('finite line plus steel energy',M*(u1-u)+ms*(steel(Tw1)['e']-steel(Tw)['e']),1e-6)
admitted('finite local pressure changes without reset',p1>p and Tw1<Tw and x1>quality)
finiteThermal=dict(volume=V,mass=M,dt=dt,initialPressure=p,finalPressure=p1,initialQuality=quality,finalQuality=x1,initialWall=Tw,finalWall=Tw1,heat_W=Q,finalFluidT=T1)

`
export const sprayNozzleDefinitionsPython = String.raw`def native(p,h):return dict(p=p,h=h,rho=P('D','P',p,'H',h,'Water'),s=P('S','P',p,'H',h,'Water'),T=P('T','P',p,'H',h,'Water'),x=P('Q','P',p,'H',h,'Water'))
def nozzle(H,s,pback,area):
 guess=P('P','H',H,'S',s,'Water')
 # Refine the inverse in the same forward p,s coordinate used for capacity.
 p0=brentq(lambda p:P('H','P',p,'S',s,'Water')-H,guess*.999,guess*1.001,xtol=1e-7)
 if area==0 or pback>=p0:return dict(mass=0.,p0=p0,exitP=pback)
 def G(p):
  if p==p0:return 0.
  dh=H-P('H','P',p,'S',s,'Water')
  if dh< -1e-6:raise ValueError('Negative native nozzle work')
  return P('D','P',p,'S',s,'Water')*math.sqrt(2*max(0.,dh))
 opt=minimize_scalar(lambda p:-G(p),bounds=(pback,p0),method='bounded')
 if not opt.success:raise ValueError('Native nozzle maximum failed')
 flux,pe=max([(G(pback),pback),(G(opt.x),opt.x),(0.,p0)])
 return dict(mass=area*flux,p0=p0,exitP=pe)
`
const faceCalculation = String.raw`Aline=math.pi*B['diameter_m']**2/4;Aexit=B['tips']*math.pi*B['tipDiameter_m']**2/4;CdA=.001
p0=15.2e6;T0=563.15;h0=P('H','P',p0,'T',T0,'Water');s0=P('S','P',p0,'T',T0,'Water')
def acoustic(p):
 x=P('Q','P',p,'S',s0,'Water')
 if not 0<=x<=1:return P('A','P',p,'S',s0,'Water')
 dp=p*1e-5
 def v(pp):return 1/P('D','P',pp,'S',s0,'Water')
 lo=P('Q','P',p-dp,'S',s0,'Water');hi=P('Q','P',p+dp,'S',s0,'Water')
 if 0<=lo<=1 and 0<=hi<=1:dv=(v(p+dp)-v(p-dp))/(2*dp)
 elif 0<=lo<=1:dv=(v(p)-v(p-dp))/dp
 elif 0<=hi<=1:dv=(v(p+dp)-v(p))/dp
 else:raise ValueError('No same-phase derivative side')
 if dv>=0:raise ValueError('Nonpositive native acoustic response')
 return math.sqrt(-v(p)**2/dv)
pbirth=brentq(lambda p:P('S','P',p,'Q',0,'Water')-s0,1e6,p0)
def outwave(p):
 h=P('H','P',p,'S',s0,'Water');q=native(p,h)
 points=[pbirth] if p<pbirth<p0 else []
 vel=quad(lambda pp:1/(P('D','P',pp,'S',s0,'Water')*acoustic(pp)),p,p0,points=points,epsabs=1e-8,epsrel=1e-9)[0]
 return q,vel
def face(p,pback):
 q,v=outwave(p);H=q['h']+.5*v*v;n=nozzle(H,s0,pback,CdA)
 return q,v,H,n
def solve_face(pback):
 def residual(p):
  q,v,H,n=face(p,pback);return Aline*q['rho']*v-n['mass']
 # Only the outgoing subsonic branch can communicate with this restriction.
 sonic=brentq(lambda p:outwave(p)[1]-acoustic(p),1e6,p0,xtol=1e-5)
 lower=max(pback,sonic)
 if residual(lower)*residual(p0)>0:raise ValueError(('Restriction demands unadmitted branch',pback,lower,residual(lower),residual(p0)))
 pu=brentq(residual,lower,p0,xtol=1e-6);up,v,H,n=face(pu,pback);m=n['mass'];pe=n['exitP']
 his=P('H','P',pe,'S',s0,'Water')
 def bore(h):return h+.5*(m/(P('D','P',pe,'H',h,'Water')*Aexit))**2-H
 if bore(his)*bore(H)>0:raise ValueError(('No physical exit recovery',pback,pu,pe,m,his,H,bore(his),bore(H)))
 he=brentq(bore,his,H,xtol=1e-7);ex=native(pe,he);ve=m/(ex['rho']*Aexit);thrust=m*ve+(pe-pback)*Aexit
 check('line wave/nozzle shared mass',Aline*up['rho']*v-m,1e-6)
 check('physical exit total enthalpy',he+.5*ve*ve-H,1e-5)
 admitted('physical exit native entropy',ex['s']>=s0-1e-7)
 c=acoustic(pu);admitted('outgoing line wave',v-c<0)
 points=[p0+(pu-p0)*i/12 for i in range(13)]
 if pu<pbirth:points.extend([pbirth*(1+1e-6),pbirth*(1-1e-6)])
 points=sorted(points,reverse=True);fan=[]
 for p in points:
  _,uv=outwave(p);fan.append(dict(p=p,characteristic=uv-acoustic(p)))
 admitted('ordered outgoing rarefaction',all(a['characteristic']<=b['characteristic']+1e-4 for a,b in zip(fan,fan[1:])))
 return dict(back=pback,up=up,lineVelocity=v,totalH=H,exit=ex,exitVelocity=ve,flow=m,thrust=thrust,pressureThrust=(pe-pback)*Aexit,fan=fan)
faces=[solve_face(14.86e6),solve_face(.3e6)]
hot=faces[1];admitted('actual flashing choked outlet',hot['exit']['p']>.3e6 and 0<hot['exit']['x']<1)
xf=hot['exit']['x'];se=sat(hot['exit']['p']);commonKE=.5*hot['exitVelocity']**2
phasePayload=dict(liquidMassRate=hot['flow']*(1-xf),vaporMassRate=hot['flow']*xf,
 liquidEnergyRate=hot['flow']*(1-xf)*(se['hl']+commonKE+g*18.5),vaporEnergyRate=hot['flow']*xf*(se['hv']+commonKE+g*18.5),
 liquidImpulseRate=hot['thrust']*(1-xf),vaporImpulseRate=hot['thrust']*xf)
check('separate phase delivered mass',phasePayload['liquidMassRate']+phasePayload['vaporMassRate']-hot['flow'],1e-10)
check('separate phase delivered energy',phasePayload['liquidEnergyRate']+phasePayload['vaporEnergyRate']-hot['flow']*(hot['totalH']+g*18.5),1e-5)
check('separate phase delivered impulse',phasePayload['liquidImpulseRate']+phasePayload['vaporImpulseRate']-hot['thrust'],1e-9)
check('closed restriction',nozzle(h0,s0,.3e6,0.)['mass'],0.)
prest=nozzle(h0,s0,p0,CdA)['p0']
check('open equal pressure rest',nozzle(h0,s0,prest,CdA)['mass'],0.)
admitted('open small positive drive',nozzle(h0,s0,prest-100.,CdA)['mass']>0)
# One finite native receiving increment; no imposed receiving enthalpy or pressure reset.
pr=.3e6;Vr=4.5;Mr=P('D','P',pr,'Q',1,'Water')*Vr;ur=P('U','P',pr,'Q',1,'Water');z=18.5;dt=1e-5
dm=hot['flow']*dt;imp=hot['thrust']*dt;Mr1=Mr+dm;Pr=imp*math.sin(B['halfCone_rad']);Pz=-imp*math.cos(B['halfCone_rad'])
Er=Mr*(ur+g*z);Er1=Er+dm*(hot['totalH']+g*z);uR1=(Er1-(Pr*Pr+Pz*Pz)/(2*Mr1))/Mr1-g*z
receiver=native(P('P','D',Mr1/Vr,'U',uR1,'Water'),P('H','D',Mr1/Vr,'U',uR1,'Water'))
Vs=.01;Ms=hot['up']['rho']*Vs;us=P('U','P',hot['up']['p'],'H',hot['up']['h'],'Water');Es=Ms*(us+.5*hot['lineVelocity']**2+g*z)
Ps=Ms*hot['lineVelocity'];Ps1=Ps-dm*hot['lineVelocity'];Es1=Es-dm*(hot['totalH']+g*z)
uS1=(Es1-Ps1*Ps1/(2*(Ms-dm)))/(Ms-dm)-g*z
P('P','D',(Ms-dm)/Vs,'U',uS1,'Water')
check('source plus receiver total energy',(Es1+Er1)-(Es+Er),1e-6)
check('source plus receiver mass',(Ms-dm+Mr1)-(Ms+Mr),1e-12)
Ss=Ms*hot['up']['s'];Sr=Mr*P('S','P',pr,'Q',1,'Water')
S1=(Ms-dm)*P('S','D',(Ms-dm)/Vs,'U',uS1,'Water')+Mr1*receiver['s']
admitted('finite total native entropy nondecrease',S1>=Ss+Sr-1e-6)
receiving=dict(dt=dt,sourceMass=Ms,receiverMass=Mr,receivedMass=dm,radialImpulse=Pr,axialImpulse=Pz,receiver=receiver,sourceInternalAfter=uS1,entropyIncrease=S1-Ss-Sr,
 bodyReaction=dict(radial=-Pr,axial=dm*hot['lineVelocity']-Pz),scope='Frozen-face native equilibrium receiving feasibility, not selected two-temperature vessel advancement')
reverse=nozzle(sat(15e6)['hv'],P('S','P',15e6,'Q',1,'Water'),14.9e6,CdA)
admitted('actual reverse steam capacity',reverse['mass']>0)
print(json.dumps(dict(scope='Selected local phase-line/contact and purewater open-nozzle feasibility; no coupled line/vessel trajectory or complete NC vessel admission',dependencies=dict(CoolProp=CoolProp.__version__,scipy=scipy.__version__),thermal=thermal,gas=gas,finiteThermal=finiteThermal,faces=faces,phasePayload=phasePayload,receiving=receiving,reverse=reverse,sensitivity=[dict(factor=f,q950=tube_wet(1e6,sat(1e6)['T'],950.,0.,f)[0]) for f in [.5,1.,2.]],checks=checks),allow_nan=False))
`

const calculation = sprayContactDefinitionsPython+thermalCalculation+sprayNozzleDefinitionsPython+faceCalculation

if (import.meta.main) {
  const [python, output, ...extra] = process.argv.slice(2)
  if (!python || !output || extra.length) throw Error('Usage: controlled-spray-phase <python> <output>')
  const paths = [import.meta.path, ...['reference-design-controlled-spray-delivery.ts', 'reference-design-pool-boiling.ts', 'reference-design-native-pool-contact.ts'].map(name => new URL(name, import.meta.url).pathname)]
  const before = await Promise.all(paths.map(path => Bun.file(path).text()))
  const input = { basis: controlledSprayBasis }
  const child = Bun.spawn([python, '-c', calculation, JSON.stringify(input)], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw Error(err)
  for (let i = 0; i < paths.length; i++) if (before[i] !== await Bun.file(paths[i]!).text()) throw Error('Source changed during calculation')
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const result = JSON.parse(out)
  const receipt = { sources: paths.map((path, i) => ({ path, sha256: hash(before[i]!) })), calculationSha256: hash(calculation), input, resultSha256: hash(JSON.stringify(result)), result }
  await Bun.write(output, JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ output, source: receipt.sources[0]!.sha256, result: receipt.resultSha256, checks: result.checks.length, faces: result.faces, finiteThermal: result.finiteThermal }))
}
