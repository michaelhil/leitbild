/** Bounded offline PZR wall-source selection; no carrier or plant trajectory. */
import {createHash} from 'node:crypto'
import {heaterBankBasis,heaterBankGeometry} from './reference-design-pressurizer-heater-banks'
import {poolBoilingPython} from './reference-design-pool-boiling'

/** Effective exposed areas, not a claim of resolved optical paths through bubbles. */
export function heaterContactAreas(height:number,liquidContactFraction:number){
 if(!Number.isFinite(liquidContactFraction)||liquidContactFraction<0||liquidContactFraction>1)throw Error('Liquid contact fraction outside [0,1]')
 const geo=heaterBankGeometry(height)
 return Object.fromEntries((['normal','backup'] as const).map(name=>{
  const x=geo.banks[name],wet=x.wetSideArea_m2*liquidContactFraction
  return [name,{wet_m2:wet,gas_m2:x.fullSideArea_m2-wet,steelMass_kg:x.steelMass_kg}]
 }))
}

/** Named shared source definitions; the original heater calculation remains unchanged. */
export const heaterContactDefinitionsPython=String.raw`
import json,sys,math,functools
import CoolProp,scipy
from CoolProp.CoolProp import PropsSI as P
from scipy.optimize import brentq
d=json.load(sys.stdin);g=9.80665;sb=5.670374419e-8;b=dict(surfaceFactor=1.)
checks=[]
def check(name,value,expected=0.,tol=1e-7):
 if not math.isfinite(value) or abs(value-expected)>tol:raise ValueError((name,value,expected,tol))
 checks.append(dict(name=name,actual=value,expected=expected,tolerance=tol))
def admitted(name,condition):check(name,1. if condition else 0.,1.,0.)
def steel(T):
 if not math.isfinite(T) or not 300<=T<=1600:raise ValueError('Solid steel thermal applicability300–1600K; not an integrity rating or protection action')
 # ANL-75-55 Eq5/Eq28, 304/304L solid fit. Thermochemical cal=4.184J;
 # exact integral of selected cp with300K datum, not rounded report enthalpy offset.
 return dict(cp=4184*(.1122+3.222e-5*T),k=8.116+.01618*T,
  e=4184*(.1122*(T-300)+1.611e-5*(T*T-300**2)))
`+poolBoilingPython+String.raw`
@functools.cache
def sat(p):
 if not .01e6<=p<=.9*22.064e6:raise ValueError('Selected pool pressure applicability')
 s={n:P(k,'P',p,'Q',q,'Water') for n,k,q in [('T','T',0),('rl','D',0),('rv','D',1),('hl','H',0),('hv','H',1),('kl','L',0),('kv','L',1),('muv','V',1),('cp','C',0),('sigma','I',0)]}
 return dict(s,p=p,hfg=s['hv']-s['hl'])
def liquid(s,T):
 if T>s['T']:raise ValueError('Heated liquid must be subcooled or saturated; no silent equilibrium reset')
 return s['hl'] if T==s['T'] else P('H','P',s['p'],'T|liquid',T,'Water')
def pre(s,TL,Tw,chi=1.,h=2000.):
 hl=liquid(s,TL);fc=h*(Tw-TL);phi=math.radians(38);F=1-math.exp(-phi**3-.5*phi)
 a=2*h*s['sigma']*s['T']/(F*F*s['rv']*s['hfg']*s['kl'])
 ton=s['T']+.5*(a+math.sqrt(a*a+4*a*(s['T']-TL)))
 if Tw<=ton:q=fc;qb=0.
 else:
  enh=pool(s['p']/1e6,Tw-s['T'])-pool(s['p']/1e6,ton-s['T'])
  q=(fc**3+enh**3)**(1/3);qb=enh**3/(q*q+q*fc+fc*fc)
 return dict(q=q,gamma=chi*qb/(s['hv']-hl),qb=qb,onset=ton)
def minimum_film(s,TL,Tw):
 m=steel(Tw);rv=s['rv'];rl=s['rl'];ts=s['T'];hf=s['hfg']
 eff=math.sqrt(s['kl']*rl*s['cp']/(m['k']*7920*m['cp']))
 tb=ts+.127*rv*hf/s['kv']*(g*(rl-rv)/(rl+rv))**(2/3)*(s['sigma']/(g*(rl-rv)))**.5*(s['muv']/(g*(rl-rv)))**(1/3)
 henry=tb+.42*(tb-TL)*(eff*hf/(m['cp']*(tb-ts)))**.6
 x=3203.6-s['p']/6894.757293168
 hn=(705.44-.04722*x+2.3907e-5*x*x-5.8193e-9*x**3-32)*5/9+273.15
 return max(755.3722222222222,min(898.7055555555555,max(henry,hn+(hn-TL)*eff)))
def film(s,Tw,L,factor=1.):
 tf=(Tw+s['T'])/2
 kv,rv,mu=[P(k,'P',s['p'],'T',tf,'Water') for k in ['L','D','V']]
 h=1.13*(kv**3*rv*(s['rl']-rv)*g*s['hfg']/(mu*(Tw-s['T'])*L))**.25
 return factor*h*(Tw-s['T'])+.3*sb*(Tw**4-s['T']**4)
@functools.cache
def endpoints(p,TL,L,chi=1.,factor=1.):
 s=sat(p);qz=.131*s['hfg']*math.sqrt(s['rv'])*(g*s['sigma']*(s['rl']-s['rv']))**.25*math.sqrt(s['rl']/(s['rl']+s['rv']))
 # PZR selection: endpoint material properties, rather than instantaneous-Tw core convention.
 tm=brentq(lambda t:t-minimum_film(s,TL,t),755.3722222222222,898.7055555555555)
 tc=brentq(lambda t:pre(s,TL,t,chi)['qb']-qz,s['T'],tm)
 peak=pre(s,TL,tc,chi);qm=film(s,tm,L,factor)
 if not peak['onset']<tc<tm or not 0<qm<peak['q']:raise ValueError(('Unordered wall endpoints',p,TL,L,tc,tm,qm,peak['q']))
 return tc,tm,peak,qm,qz
def wet(p,TL,Tw,L,chi=1.,factor=1.):
 steel(Tw);s=sat(p);r=pre(s,TL,Tw,chi)
 if Tw<=r['onset']:q=r['q'];gamma=0.;mode='sensible'
 else:
  tc,tm,peak,qm,_=endpoints(p,TL,L,chi,factor)
  if Tw<=tc:q=r['q'];gamma=r['gamma'];mode='wet'
  elif Tw<tm:
   w=((Tw-tm)/(tc-tm))**2;q=w*peak['q']+(1-w)*qm
   gamma=w*peak['gamma']+(1-w)*qm/(s['hv']-liquid(s,TL));mode='transition'
  else:q=film(s,Tw,L,factor);gamma=q/(s['hv']-liquid(s,TL));mode='film'
 return dict(q=q,gamma=gamma,mode=mode,liquidEnergy=q-gamma*s['hv'],vaporEnergy=gamma*s['hv'])
def radiation(areas,temperatures,epsilon=.3):
 for T in temperatures:steel(T)
 if sum(areas)==0:return [0. for a in areas]
 mean=sum(a*epsilon*sb*t**4 for a,t in zip(areas,temperatures))/sum(a*epsilon for a in areas)
 return [a*epsilon*(sb*t**4-mean) for a,t in zip(areas,temperatures)]
def gas_contact(Tw,Tg,pv,ptotal,z,eta,area=1.,h=5.,speed=.01,present=True):
 steel(Tw)
 if not present or area==0:return dict(condensation_kg_s=0.,metal_W=0.,gas_W=0.,receiver_W=0.,landingHeight_m=min(z,eta),fallDissipation_W=0.,sensible_W=0.)
 # The passed gas state is actual. No absent-steam property query.
 sensible=area*h*(Tw-Tg);mass=0.;metal=-sensible;gas=sensible;receiver=0.;landing=min(z,eta)
 if pv>0:
  ts=P('T','P',pv,'Q',1,'Water')
  if Tw<ts:
   rv=P('D','P',pv,'Q',1,'Water') if abs(Tg-ts)<1e-8 else P('D','P',pv,'T|gas',Tg,'Water')
   hv=P('H','P',pv,'Q',1,'Water') if abs(Tg-ts)<1e-8 else P('H','P',pv,'T|gas',Tg,'Water')
   rs=P('D','T',Tw,'Q',1,'Water');hl=P('H','P',ptotal,'T|liquid',Tw,'Water')
   mass=area*speed*max(0.,rv-rs);metal+=mass*(hv-hl);gas-=mass*(hv+g*z)
   receiver=mass*(hl+g*z)
 return dict(condensation_kg_s=mass,metal_W=metal,gas_W=gas,receiver_W=receiver,
  landingHeight_m=landing,fallDissipation_W=mass*g*(z-landing),sensible_W=sensible)

`
export const heaterContactPython=heaterContactDefinitionsPython+String.raw`rows=[];ends=[]
for p in [1e5,1e6,15e6]:
 s=sat(p)
 for sub in [0.,20.]:
  TL=s['T']-sub
  for L in [1.,3.]:
   tc,tm,peak,qm,qz=endpoints(p,TL,L)
   sample=[755.3722222222222+i*(898.7055555555555-755.3722222222222)/16 for i in range(17)]
   residual=[t-minimum_film(s,TL,t) for t in sample]
   admitted('sampled endpoint residual strictly increasing',all(a<c for a,c in zip(residual,residual[1:])))
   check('self-consistent minimum-film endpoint',tm-minimum_film(s,TL,tm),tol=1e-8)
   ends.append(dict(p_Pa=p,subcooling_K=sub,L_m=L,onset_K=peak['onset'],turnover_K=tc,minimumFilm_K=tm,peak_W_m2=peak['q'],minimum_W_m2=qm,boilingTurnover_W_m2=qz))
   for Tw in [TL-5,TL,s['T']+2,tc,(tc+tm)/2,tm,950.,1200.,1600.]:
    q=wet(p,TL,Tw,L);check('wet total-energy source',q['liquidEnergy']+q['vaporEnergy']-q['q'])
    admitted('wet phase transfer nonnegative',q['gamma']>=0)
    rows.append(dict(p_Pa=p,subcooling_K=sub,L_m=L,wall_K=Tw,**q))
   for boundary in [tc,tm]:
    lo=wet(p,TL,boundary-1e-6,L);hi=wet(p,TL,boundary+1e-6,L)
    check('endpoint relative heat continuity',(hi['q']-lo['q'])/peak['q'],tol=1e-5)
    check('endpoint relative birth continuity',(hi['gamma']-lo['gamma'])/(peak['q']/s['hfg']),tol=1e-5)
# Fixed-height source increment: finite steel, actual liquid and initially absent vapor.
# Held mechanical pressure supplies p*dV work; not a sealed PZR trajectory.
s=sat(1e6);TL=s['T']-20.;Tw=900.;L=3.;A=.02*math.pi*.1;mass=7920*math.pi*.01**2*.1;dt=.001
w=wet(1e6,TL,Tw,L);ml=1.;hl=liquid(s,TL);dm=A*w['gamma']*dt
ml1=ml-dm;Hl1=ml*hl+A*w['liquidEnergy']*dt;mv1=dm;Hv1=A*w['vaporEnergy']*dt
Tl1=P('T','P',1e6,'H',Hl1/ml1,'Water');rho1=P('D','P',1e6,'H',Hl1/ml1,'Water')
Tw1=brentq(lambda t:mass*(steel(t)['e']-steel(Tw)['e'])+A*w['q']*dt,300,Tw)
v0=ml/P('D','P',1e6,'T',TL,'Water');v1=ml1/rho1+mv1/s['rv']
energy0=ml*hl-1e6*v0+mass*steel(Tw)['e']
energy1=Hl1+Hv1-1e6*v1+mass*steel(Tw1)['e']
check('finite source mass',ml1+mv1,ml,1e-12)
check('finite native U plus work',energy1-energy0+1e6*(v1-v0),tol=1e-6)
admitted('finite hot-wall cooling with retained mass',300<Tw1<Tw and ml1>0 and mv1>0)
coupon=dict(scope='Single finite isobaric source increment; zero initial vapor insertion, no transport trajectory',dt_s=dt,area_m2=A,steelMass_kg=mass,initialWall_K=Tw,finalWall_K=Tw1,initialLiquid_K=TL,finalLiquid_K=Tl1,bornVapor_kg=mv1,pressureWork_J=1e6*(v1-v0),energyResidual_J=energy1-energy0+1e6*(v1-v0))
# Complementary exposure at each fixed slice; effective shell visibility uses the same gas fraction.
rad=[];perimeter=2*math.sqrt(math.pi*d['geometry']['vesselArea_m2'])
for height,counts in [(.5,[32,256]),(2.,[0,256])]:
 for gasFraction in [0.,.5,1.]:
  areas=[n*math.pi*.02*.1*gasFraction for n in counts]+[perimeter*.1*gasFraction]
  temps=[900.,800.,550.];q=radiation(areas,temps)
  check('reciprocal enclosure energy',sum(q),tol=1e-9)
  admitted('reciprocal enclosure entropy',-sum(v/t for v,t in zip(q,temps))>=-1e-10)
  rad.append(dict(heightAboveBottom_m=height,gasFraction=gasFraction,areas_m2=areas,outwardHeat_W=q))
gas=[]
for pv,Tg,Tw,eta in [(1e6,s['T'],400.,0.),(1e6,s['T'],400.,1.),(1e6,s['T'],400.,6.),(1e6,s['T'],s['T'],0.),(1e6,s['T'],900.,0.),(0.,500.,400.,0.),(0.,500.,900.,0.)]:
 q=gas_contact(Tw,Tg,pv,max(pv,1e5),8.,6.5+eta)
 check('gas condensation/drain totalH',q['metal_W']+q['gas_W']+q['receiver_W'],tol=1e-8)
 if eta==0 and q['condensation_kg_s']>0:check('empty pool receives at actual bottom',q['landingHeight_m'],6.5)
 gas.append(dict(vaporPressure_Pa=pv,gas_K=Tg,wall_K=Tw,occupiedHeight_m=eta,**q))
# Empty return insertion has finite liquid U and volume, not an EOS call on zero mass.
c=gas[0];dt=.001;dm=c['condensation_kg_s']*dt;z=8.;landing=c['landingHeight_m'];p=1e6
hl=P('H','P',p,'T|liquid',400.,'Water')+g*(z-landing)
rho=P('D','P',p,'H',hl,'Water');u=P('U','P',p,'H',hl,'Water');v=dm/rho
insertedE=dm*(u+g*landing)
check('empty return native U plus displacement work',insertedE+p*v,c['receiver_W']*dt,tol=1e-8)
emptyReturn=dict(scope='Zero-speed condensate insertion derivative with held mechanical pressure; not coupled vessel recovery',mass_kg=dm,volume_m3=v,nativeEnergy_J=insertedE,displacementWork_J=p*v,receiverTotalH_J=c['receiver_W']*dt)
for kwargs in [dict(present=False),dict(area=0.)]:
 absent=gas_contact(900.,0.,-1.,-1.,8.,6.5,**kwargs)
 check('absent contact avoids unavailable gas properties',sum(abs(absent[k]) for k in ['condensation_kg_s','metal_W','gas_W','receiver_W']))
material=[]
for T in [300.,650.,900.,973.15,1200.,1600.]:
 m=steel(T);admitted('steel positive capacity/conductivity',m['cp']>0 and m['k']>0)
 material.append(dict(T_K=T,**m))
for T in [400.,650.,973.15,1500.]:
 check('caloric derivative equals capacity',(steel(T+.001)['e']-steel(T-.001)['e'])/.002,steel(T)['cp'],1e-4)
check('selected caloric datum',steel(300)['e'])
# Published fit coefficients and Table10 are separately rounded: compare within
# one displayed table increment0.01W/(m K), not a specimen accuracy claim.
for T,k in [(300.,12.97),(600.,17.82),(1000.,24.29),(1600.,34.)]:check('ANL Table10 conductivity',steel(T)['k'],k,.01)
overlap=[]
for T in [300.,650.,900.,973.15]:
 oldcp=6.683+.04906*T+80.74*math.log(T);oldk=9.705+.0176*T-1.60e-6*T*T
 overlap.append(dict(T_K=T,capacityRelativeChange=steel(T)['cp']/oldcp-1,conductivityRelativeChange=steel(T)['k']/oldk-1))
adiabaticSeconds={str(T):(steel(1600)['e']-steel(T)['e'])*sum(x['steelMass_kg'] for x in d['contactAtHalfMetre'].values())/3e6 for T in [650.,973.15]}
rejected=[]
for T in [299.99,1600.01,float('nan')]:
 try:steel(T)
 except ValueError as e:rejected.append(dict(wall_K=T if math.isfinite(T) else 'nonfinite',reason=str(e)))
admitted('outside steel domain explicitly rejected',len(rejected)==3)
sensitivity=[dict(L_m=L,factor=f,q950_W_m2=film(s,950.,L,f)) for L in [1.,3.] for f in [.5,1.,2.]]
print(json.dumps(dict(scope='Local wall-source family only; no dense carrier, pressure response, prolonged dry survival or installed qualification',
 materialRange_K=[300,1600],material=material,materialOverlap=overlap,adiabaticHeatingTo1600_s=adiabaticSeconds,rows=rows,endpoints=ends,finiteIncrement=coupon,radiation=rad,gasContact=gas,emptyReturnInsertion=emptyReturn,filmSensitivity=sensitivity,
 gasSensibleSensitivity_W_m2=[f*5*(900-s['T']) for f in [.5,1.,2.]],rejectedMaterial=rejected,checks=checks,
 dependencies=dict(CoolProp=CoolProp.__version__,scipy=scipy.__version__)),allow_nan=False))
`

export async function runHeaterContact(python:string){
 const hash=(x:string)=>createHash('sha256').update(x).digest('hex'),source=await Bun.file(import.meta.path).text()
 const dependencies=await Promise.all(['reference-design-pool-boiling.ts','reference-design-pressurizer-heater-banks.ts'].map(async name=>({name,bytes:await Bun.file(new URL(name,import.meta.url)).text()})))
 const input={geometry:heaterBankBasis,contactAtHalfMetre:heaterContactAreas(.5,.5)}
 const child=Bun.spawn([python,'-c',heaterContactPython],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'})
 const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
 if(code!==0)throw Error(err)
 if(source!==await Bun.file(import.meta.path).text())throw Error('Source changed during calculation')
 for(const dependency of dependencies)if(dependency.bytes!==await Bun.file(new URL(dependency.name,import.meta.url)).text())throw Error(`Dependency changed during calculation: ${dependency.name}`)
 return {sourceSha256:hash(source),sourceDependencies:Object.fromEntries(dependencies.map(x=>[x.name,hash(x.bytes)])),calculationSha256:hash(heaterContactPython),inputSha256:hash(JSON.stringify(input)),input,...JSON.parse(out)}
}
if(import.meta.main){
 const [python,output,...rest]=process.argv.slice(2)
 if(!python||!output||rest.length)throw Error('Usage: heater-contact <python> <receipt.json>')
 const result=await runHeaterContact(python)
 await Bun.write(output,JSON.stringify(result,null,2)+'\n')
 console.log(JSON.stringify({output,sourceSha256:result.sourceSha256,calculationSha256:result.calculationSha256,checks:result.checks.length,finiteIncrement:result.finiteIncrement}))
}
