/** Offline installed mapping and local phase-receiving decision; no line/vessel trajectory. */
import {createHash} from 'node:crypto'
import {parseSurgeRoute,resolveSurgeRoute,type SurgeRoute} from './reference-design-surge-route'
import {sprayContactDefinitionsPython,sprayNozzleDefinitionsPython,sprayPhaseAreas} from './reference-design-controlled-spray-phase'

export function surgeConnectionGeometry(input:SurgeRoute){
 const route=resolveSurgeRoute(input),mainArea=Math.PI/4,width=Math.sqrt(mainArea),nodeLength=1
 return {route,hot:{totalVolume_m3:15,nodeVolume_m3:mainArea*nodeLength,remainingVolume_m3:15-mainArea*nodeLength,
  mainArea_m2:mainArea,sideArea_m2:route.area_m2,nodeLength_m:nodeLength,width_m:width,
  remainingPositiveSideWall_m2:width*nodeLength-route.area_m2,negativeSideWall_m2:width*nodeLength,
  distributedLoss:0.49504493,retiredLocalizedThroughLoss:0.00405},
  bottom:{radius_m:.8,area_m2:route.area_m2,innerEdge_m:.8-input.internalDiameter_m/2,outerEdge_m:.8+input.internalDiameter_m/2,
   elevation_m:input.receiverElevation_m,vesselAxisPlan_m:[route.endpoint_m[0]!-.8,route.endpoint_m[1]!],
   reservoirEntryCdA_m2:route.area_m2/Math.sqrt(1+input.entryLoss),bareExitArea_m2:route.area_m2},
  retainedElbowLoss:2*input.elbowLoss,retiredExitLoss:input.exitLoss,
 }
}

const calculation=sprayContactDefinitionsPython+sprayNozzleDefinitionsPython+String.raw`
geometry=d['geometry'];A=geometry['bottom']['area_m2'];CdA=geometry['bottom']['reservoirEntryCdA_m2'];z=geometry['bottom']['elevation_m']
# Two actual phase donors at one mechanical pressure, NOT a flashed PZR average.
p=15e6;ts=sat(p)['T'];donors=[]
for phase,T,key in [('liquid',ts-10.,'T|liquid'),('gas',ts+10.,'T|gas')]:
 donors.append(dict(phase=phase,p=p,T=T,h=P('H','P',p,key,T,'Water'),s=P('S','P',p,key,T,'Water'),rho=P('D','P',p,key,T,'Water')))
def phase_withdrawal(fraction,donor,pback):
 if fraction==0:return dict(mass=0.,energy=0.,payload=0.)
 q=nozzle(donor['h'],donor['s'],pback,fraction*CdA)
 return dict(mass=q['mass'],energy=q['mass']*(donor['h']+g*z),payload=q['mass']*.001 if donor['phase']=='liquid' else 0.,throatPressure=q['exitP'])
rows=[]
for alpha in [0.,.5,1.]:
 shares=[alpha,1-alpha];flux=[phase_withdrawal(f,x,14.9e6) for f,x in zip(shares,donors)]
 if alpha==0:check('absent liquid bypass',phase_withdrawal(0.,{},-1.)['mass'],0.)
 if alpha==1:check('absent gas bypass',phase_withdrawal(0.,{},-1.)['energy'],0.)
 admitted('actual donor-directed outsurge',all(q['mass']>=0 for q in flux) and sum(q['mass'] for q in flux)>0)
 rows.append(dict(liquidAreaFraction=alpha,phaseFluxes=flux,mass=sum(q['mass'] for q in flux),energy=sum(q['energy'] for q in flux),payload=sum(q['payload'] for q in flux)))
for k in ['mass','energy','payload']:check('area-continuous phase sum',rows[1][k]-.5*(rows[0][k]+rows[2][k]),1e-6)
for donor in donors:
 prest=nozzle(donor['h'],donor['s'],p,CdA)['p0']
 check('equal mechanical head gives zero',nozzle(donor['h'],donor['s'],prest,CdA)['mass'],0.)
check('entry coefficient includes kinetic acceleration',A*A/(CdA*CdA)-1.-.5,1e-12)

# One finite, initially cold HEM line receiver. Donors supply a frozen 1us parcel;
# their phase energies are debited separately, not re-equilibrated by this coupon.
pr=14.9e6;Tr=550.;V=A;M=P('D','P',pr,'T',Tr,'Water')*V;u=P('U','P',pr,'T',Tr,'Water');dt=1e-6
row=rows[1];dm=row['mass']*dt;dE=row['energy']*dt;M1=M+dm
# Native receiving bore speed from the incoming mixed enthalpy and common face p.
Hmix=row['energy']/row['mass']-g*z
def bore(h):return h+.5*(row['mass']/(P('D','P',pr,'H',h,'Water')*A))**2-Hmix
hin=brentq(bore,min(x['h'] for x in donors),Hmix,xtol=1e-7);rhoin=P('D','P',pr,'H',hin,'Water');vin=row['mass']/(rhoin*A)
check('actual incoming bore total enthalpy',bore(hin),1e-5)
momentum=-dm*vin;E=M*(u+g*z);E1=E+dE;u1=(E1-momentum**2/(2*M1))/M1-g*z
p1=P('P','D',M1/V,'U',u1,'Water');T1=P('T','D',M1/V,'U',u1,'Water')
admitted('native finite receiver remains admitted',p1>0 and T1>0)
check('separate donor and receiver energy incidence',sum(-q['energy']*dt for q in row['phaseFluxes'])+E1-E,1e-6)
check('separate donor and receiver mass incidence',sum(-q['mass']*dt for q in row['phaseFluxes'])+M1-M,1e-12)
S0=M*P('S','P',pr,'T',Tr,'Water');S1=M1*P('S','D',M1/V,'U',u1,'Water')
Sin=sum(q['mass']*x['s']*dt for q,x in zip(row['phaseFluxes'],donors))
admitted('finite receiving entropy including supplied parcel',S1-S0-Sin>=-1e-7)
finite=dict(scope='Frozen two-temperature phase donor flux into ONE finite HEM line cell; donor removal incidence, not coupled PZR/line pressure recovery',dt_s=dt,volume_m3=V,initialMass_kg=M,receivedMass_kg=dm,receivedEnergy_J=dE,receivedAxialMomentum_kg_m_s=momentum,receivedTracer_kg_eq=row['payload']*dt,incomingFacePressure_Pa=pr,incomingBoreVelocity_m_s=vin,initialPressure_Pa=pr,finalPressure_Pa=p1,initialTemperature_K=Tr,finalTemperature_K=T1,entropyIncreaseAfterInflow_J_K=S1-S0-Sin)

# Opposite direction: a native wet bore trace supplies separate PZR phase owners.
# This is an imposed material trace, NOT an independently solved discharge rate.
pi=1e6;quality=.1;s=sat(pi);speed=2.;rho=P('D','P',pi,'Q',quality,'Water');m=rho*A*speed
phase=[dict(phase='liquid',mass=m*(1-quality),h=s['hl']),dict(phase='gas',mass=m*quality,h=s['hv'])]
for q in phase:q.update(momentum=q['mass']*speed,energy=q['mass']*(q['h']+.5*speed**2+g*z))
hm=P('H','P',pi,'Q',quality,'Water')
check('insurge mass source split',sum(q['mass'] for q in phase)-m,1e-10)
check('insurge momentum source split',sum(q['momentum'] for q in phase)-m*speed,1e-10)
check('insurge total energy source split',sum(q['energy'] for q in phase)-m*(hm+.5*speed**2+g*z),1e-6)
check('no retired exit mixing charge',sum(q['energy'] for q in phase)-m*(hm+.5*speed**2+g*z),1e-6)

# Actual new tube diameter uses the already selected contact family, no retuning.
thermal=[]
for p in [1e6,15e6]:
 TL=sat(p)['T']-20.;tc,tm,peak,qm,qz=tube_endpoints(p,TL,0.,1.)
 for Tw in [TL-5,TL,tc,(tc+tm)/2,tm,950.]:
  q,mode=tube_wet(p,TL,Tw,0.)
  admitted('surge tube signed thermal contact',q*(Tw-TL)>=0)
  thermal.append(dict(p_Pa=p,liquid_K=TL,wall_K=Tw,q_W_m2=q,mode=mode))
print(json.dumps(dict(scope='Installed surge geometry, held phase outsurge/finite receiving incidence and opposite wet source split; no coupled line or PZR trajectory',donors=donors,outsurge=rows,finiteReceiving=finite,insurge=dict(scope='Prescribed wet native bore trace and phase source split, not hydraulic delivery',pressure_Pa=pi,quality=quality,speed_m_s=speed,phaseFluxes=phase),thermal=thermal,checks=checks,dependencies=dict(CoolProp=CoolProp.__version__,scipy=scipy.__version__)),allow_nan=False))
`

if(import.meta.main){
 const [routePath,python,output,...extra]=process.argv.slice(2)
 if(!routePath||!python||!output||extra.length)throw Error('Usage: surge-connection <surge-route.md> <python> <receipt>')
 const routeBytes=await Bun.file(routePath).text(),route=parseSurgeRoute(routeBytes),geometry=surgeConnectionGeometry(route)
 const paths=[import.meta.path,...['reference-design-surge-route.ts','reference-design-controlled-spray-phase.ts','reference-design-controlled-spray-delivery.ts','reference-design-pool-boiling.ts','reference-design-native-pool-contact.ts'].map(n=>new URL(n,import.meta.url).pathname)]
 const bytes=await Promise.all(paths.map(p=>Bun.file(p).text()))
 const input={geometry,basis:{diameter_m:route.internalDiameter_m,wall_m:route.wallThickness_m},phaseAreas:sprayPhaseAreas(geometry.bottom.area_m2,.5)}
 const child=Bun.spawn([python,'-c',calculation,JSON.stringify(input)],{stdout:'pipe',stderr:'pipe'})
 const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
 if(code!==0)throw Error(err)
 for(let i=0;i<paths.length;i++)if(bytes[i]!==await Bun.file(paths[i]!).text())throw Error('Consumed source changed')
 if(routeBytes!==await Bun.file(routePath).text())throw Error('Consumed route owner changed')
 const hash=(s:string)=>createHash('sha256').update(s).digest('hex'),result=JSON.parse(out)
 const receipt={sources:paths.map((path,i)=>({path,sha256:hash(bytes[i]!)})),routeOwnerSha256:hash(routeBytes),calculationSha256:hash(calculation),input,inputSha256:hash(JSON.stringify(input)),resultSha256:hash(JSON.stringify(result)),result}
 await Bun.write(output,JSON.stringify(receipt,null,2)+'\n')
 console.log(JSON.stringify({output,source:receipt.sources[0]!.sha256,calculation:receipt.calculationSha256,result:receipt.resultSha256,checks:result.checks.length,finite:result.finiteReceiving}))
}
