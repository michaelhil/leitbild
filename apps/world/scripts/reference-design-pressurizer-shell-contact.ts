/** Offline shell/head source selection, not a vessel transient or a resolved film. */
import {createHash} from 'node:crypto'
import {heaterContactDefinitionsPython} from './reference-design-pressurizer-heater-contact'

export function shellContactGeometry(){
 const radius=Math.sqrt(5/Math.PI),heights=[0,1,3,6,9,12],rho=7920,thickness=.15
 return {
  shell:heights.slice(1).map((top,i)=>({bottom_m:heights[i]!,top_m:top,
   area_m2:2*Math.PI*radius*(top-heights[i]!),
   steelMass_kg:rho*Math.PI*((radius+thickness)**2-radius**2)*(top-heights[i]!)})),
  heads:(['bottom','top'] as const).flatMap(name=>[.5,4.5].map((area,i)=>({name,lane:i===0?'inner':'outer',
   z_m:name==='bottom'?6.5:18.5,orientation:name==='bottom'?'upward':'downward',grossSolidArea_m2:area,
   area_m2:area-(name==='bottom'&&i===0?288*Math.PI*.01**2:0),steelMass_kg:rho*area*thickness}))),
 }
}

export const shellContactPython=heaterContactDefinitionsPython+String.raw`
def shell_film(s,Tw,kind,gap=.001):
 if kind=='shell':return film(s,Tw,12.)
 if kind not in ['bottom','top']:raise ValueError('Unknown physical wall')
 # Effective thermal resistance, NOT a film thickness, storage or gravity law.
 kv=P('L','P',s['p'],'T',(Tw+s['T'])/2,'Water')
 return kv/gap*(Tw-s['T'])+.3*sb*(Tw**4-s['T']**4)
@functools.cache
def wall_endpoints(p,TL,kind,gap=.001):
 s=sat(p);tm=brentq(lambda t:t-minimum_film(s,TL,t),755.3722222222222,898.7055555555555)
 qz=.131*s['hfg']*math.sqrt(s['rv'])*(g*s['sigma']*(s['rl']-s['rv']))**.25*math.sqrt(s['rl']/(s['rl']+s['rv']))
 tc=brentq(lambda t:pre(s,TL,t,h=1000.)['qb']-qz,s['T'],tm)
 peak=pre(s,TL,tc,h=1000.);qm=shell_film(s,tm,kind,gap)
 if not peak['onset']<tc<tm or not 0<qm<peak['q']:raise ValueError(('Unordered shell/head branch',p,TL,kind,gap,tc,tm,qm,peak['q']))
 return tc,tm,peak,qm
def wall_wet(p,TL,Tw,kind,area=1.,present=True,gap=.001):
 if area==0 or not present:return dict(q=0.,gamma=0.,liquidEnergy=0.,vaporEnergy=0.,mode='absent')
 steel(Tw);s=sat(p);r=pre(s,TL,Tw,h=1000.)
 if Tw<=r['onset']:q=r['q'];gamma=0.;mode='sensible'
 else:
  tc,tm,peak,qm=wall_endpoints(p,TL,kind,gap)
  if Tw<=tc:q=r['q'];gamma=r['gamma'];mode='wet'
  elif Tw<tm:
   w=((Tw-tm)/(tc-tm))**2;q=w*peak['q']+(1-w)*qm
   gamma=w*peak['gamma']+(1-w)*qm/(s['hv']-liquid(s,TL));mode='transition'
  else:q=shell_film(s,Tw,kind,gap);gamma=q/(s['hv']-liquid(s,TL));mode='film'
 return dict(q=area*q,gamma=area*gamma,liquidEnergy=area*(q-gamma*s['hv']),vaporEnergy=area*gamma*s['hv'],mode=mode)

rows=[];ends=[]
for p in [1e5,1e6,15e6]:
 s=sat(p)
 for kind in ['shell','bottom','top']:
  TL=s['T']-20.;tc,tm,peak,qm=wall_endpoints(p,TL,kind)
  ends.append(dict(p_Pa=p,kind=kind,onset_K=peak['onset'],turnover_K=tc,minimumFilm_K=tm,peak_W_m2=peak['q'],minimum_W_m2=qm))
  for Tw in [TL-5,TL,tc,(tc+tm)/2,tm,950.,1600.]:
   q=wall_wet(p,TL,Tw,kind);check('complete wet source energy',q['liquidEnergy']+q['vaporEnergy']-q['q'],tol=1e-8)
   admitted('birth is nonnegative and local',q['gamma']>=0)
   if Tw<=TL:admitted('signed cold or equal wall',q['q']<=0 and q['gamma']==0)
   rows.append(dict(p_Pa=p,kind=kind,wall_K=Tw,**q))
  for boundary in [tc,tm]:
   lo=wall_wet(p,TL,boundary-1e-6,kind);hi=wall_wet(p,TL,boundary+1e-6,kind)
   check('heat continuity',(hi['q']-lo['q'])/peak['q'],tol=1e-5)
   check('mass continuity',(hi['gamma']-lo['gamma'])/(peak['q']/s['hfg']),tol=1e-5)
for kwargs in [dict(area=0.),dict(present=False)]:
 q=wall_wet(-1.,-1.,-1.,'top',**kwargs)
 check('absent wet contact bypasses properties',sum(abs(q[k]) for k in ['q','gamma','liquidEnergy','vaporEnergy']))

# Complementary exposed-area contact. Local z=0 removes no physical fall energy:
# condensate is born beside its donor at the SAME actual height in the native field.
gas=[];s=sat(1e6)
for Tg,Tw,pv in [(s['T'],400.,1e6),(s['T'],s['T'],1e6),(s['T'],950.,1e6),(500.,400.,0.),(500.,950.,0.)]:
 q=gas_contact(Tw,Tg,pv,1e6,0.,0.)
 check('local gas condensation source energy',q['metal_W']+q['gas_W']+q['receiver_W'],tol=1e-8)
 gas.append(dict(gas_K=Tg,wall_K=Tw,steamPressure_Pa=pv,**q))
for kwargs in [dict(present=False),dict(area=0.)]:
 q=gas_contact(900.,-1.,-1.,-1.,0.,0.,**kwargs)
 check('absent gas bypasses properties',sum(abs(q[k]) for k in ['metal_W','gas_W','receiver_W','condensation_kg_s']))

# Band-local diffuse exchange, with actual head patches ONLY at the two ends.
rad=[]
for band,(zi,zj) in enumerate(zip([0,1,3,6,9],[1,3,6,9,12])):
 for fi,fo in [(0.,0.),(1.,1.),(.2,.8)]:
  dz=zj-zi;nr=32 if zi<1 else 0;nb=256 if zi<3 else 0
  areas=[nr*math.pi*.02*dz*fi,nb*math.pi*.02*dz*fi,2*math.sqrt(math.pi*5)*dz*fo]
  temps=[950.,900.,550.]
  if band in [0,4]:areas += [(.5-(288*math.pi*.01**2 if band==0 else 0))*fi,4.5*fo];temps += [700.,600.]
  q=radiation(areas,temps)
  check('band radiation reciprocal energy',sum(q),tol=2e-9)
  admitted('band radiation nonnegative entropy',-sum(v/t for v,t in zip(q,temps))>=-1e-9)
  rad.append(dict(band=band,innerGasFraction=fi,outerGasFraction=fo,areas_m2=areas,outwardHeat_W=q))

# ONE finite source increment. Held pressure performs p*dV work, not a rigid cell solve.
p=1e6;s=sat(p);TL=s['T']-20.;Tw=950.;A=.01;metalMass=7920*.15*A;dt=.001
w=wall_wet(p,TL,Tw,'top',area=A);ml=1.;hl=liquid(s,TL);dm=w['gamma']*dt
ml1=ml-dm;HL1=ml*hl+w['liquidEnergy']*dt;HG1=w['vaporEnergy']*dt
rho1=P('D','P',p,'H',HL1/ml1,'Water');TL1=P('T','P',p,'H',HL1/ml1,'Water')
Tw1=brentq(lambda t:metalMass*(steel(t)['e']-steel(Tw)['e'])+w['q']*dt,300,Tw)
V0=ml/P('D','P',p,'T',TL,'Water');V1=ml1/rho1+dm/s['rv']
E0=ml*hl-p*V0+metalMass*steel(Tw)['e'];E1=HL1+HG1-p*V1+metalMass*steel(Tw1)['e']
check('finite source mass',ml1+dm,ml,1e-12)
check('finite native energy plus external pressure work',E1-E0+p*(V1-V0),tol=1e-6)
admitted('finite cooling and actual phase birth',Tw1<Tw and ml1>0 and dm>0)
finite=dict(scope='Single 1ms isobaric source increment into zero initial vapor; not coupled pressure or carrier recovery',initialWall_K=Tw,finalWall_K=Tw1,initialLiquid_K=TL,finalLiquid_K=TL1,bornVapor_kg=dm,steelMass_kg=metalMass,pressureWork_J=p*(V1-V0),energyDefect_J=E1-E0+p*(V1-V0))
# Actual native newborn-liquid U+pV at its unchanged formation height.
c=gas[0];dm=c['condensation_kg_s']*dt;hl=P('H','P',p,'T|liquid',400.,'Water')
rho=P('D','P',p,'T|liquid',400.,'Water');u=P('U','P',p,'T|liquid',400.,'Water')
check('empty local liquid native insertion',dm*(u+p/rho),c['receiver_W']*dt,tol=1e-8)
birth=dict(scope='Local zero-speed newborn liquid ledger, not opposing-gas pressure recovery',mass_kg=dm,volume_m3=dm/rho,internalEnergy_J=dm*u,pressureWork_J=p*dm/rho)
sensitivity=[]
for gap in [.0005,.001,.002]:
 tc,tm,peak,qm=wall_endpoints(1e6,s['T']-20.,'top',gap)
 q=wall_wet(1e6,s['T']-20.,950.,'top',gap=gap)
 sensitivity.append(dict(resistanceLength_m=gap,minimum_W_m2=qm,hot950_W_m2=q['q'],birth950_kg_m2_s=q['gamma']))
print(json.dumps(dict(scope='Selected effective shell/head source family; no resolved film, orientation-specific quench or vessel trajectory',geometry=d['geometry'],endpoints=ends,rows=rows,gasContact=gas,radiation=rad,finiteIncrement=finite,emptyLocalLiquid=birth,headResistanceSensitivity=sensitivity,checks=checks,dependencies=dict(CoolProp=CoolProp.__version__,scipy=scipy.__version__)),allow_nan=False))
`

export async function runShellContact(python:string){
 const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
 const names=['reference-design-pressurizer-shell-contact.ts','reference-design-pressurizer-heater-contact.ts','reference-design-pool-boiling.ts','reference-design-pressurizer-heater-banks.ts']
 const sources=await Promise.all(names.map(async name=>({name,bytes:await Bun.file(new URL(name,import.meta.url)).text()})))
 const input={geometry:shellContactGeometry()}
 const child=Bun.spawn([python,'-c',shellContactPython],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'})
 const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
 if(code!==0)throw Error(err)
 for(const s of sources)if(s.bytes!==await Bun.file(new URL(s.name,import.meta.url)).text())throw Error(`Source changed: ${s.name}`)
 return {sourceSha256:hash(sources[0]!.bytes),sourceDependencies:Object.fromEntries(sources.slice(1).map(s=>[s.name,hash(s.bytes)])),calculationSha256:hash(shellContactPython),inputSha256:hash(JSON.stringify(input)),input,...JSON.parse(out)}
}
if(import.meta.main){
 const [python,output,...rest]=process.argv.slice(2)
 if(!python||!output||rest.length)throw Error('Usage: shell-contact <python> <receipt.json>')
 const result=await runShellContact(python);await Bun.write(output,JSON.stringify(result,null,2)+'\n')
 console.log(JSON.stringify({output,sourceSha256:result.sourceSha256,calculationSha256:result.calculationSha256,checks:result.checks.length,finiteIncrement:result.finiteIncrement,headResistanceSensitivity:result.headResistanceSensitivity}))
}
