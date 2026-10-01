/** One bounded finite NI contact coupon; no source, acquisition or plant runtime. */
import {createHash} from 'node:crypto'
import {resolve} from 'node:path'
import {z} from 'zod'
import {runNuclearObservation} from './reference-design-nuclear-observation'
import {b4cCaloric} from './reference-design-fuel-handling'
import {solid304Python} from './reference-design-pressurizer-heater-contact'
import {fuelMaterialPython} from './reference-design-fuel-materials'
const sha=(s:string)=>createHash('sha256').update(s).digest('hex')
const basis=z.object({observation_s:z.literal(60),captureUpper_MeV:z.literal(2.791),wet_W_m2_K:z.literal(250),gas_W_m2_K:z.literal(5),warmBound_K:z.literal(593.15),roomBound_K:z.literal(300),contacts:z.tuple([z.literal(.5),z.literal(1),z.literal(2)])}).strict()
export function parseNuclearObservationResponse(doc:string){
 const blocks=[...doc.matchAll(/```reference-nuclear-observation-response\s*\n([\s\S]*?)\n```/g)]
 if(blocks.length!==1)throw Error('Expected one finite NI response record')
 return basis.parse(JSON.parse(blocks[0]![1]!))
}
export function converterLoads(receipt:any){
 const rows=receipt?.result?.rows
 if(!Array.isArray(rows)||rows.length!==2)throw Error('Expected paired cold/normal NI field')
 const cold=rows.find((x:any)=>x.bodyTravel_m===0&&x.marker_ppm===2000),normal=rows.find((x:any)=>x.marker_ppm===1000)
 if(!cold||!normal||normal.preparation?.pressure_Pa!==15200000||normal.preparation?.temperature_K!==578.045678)throw Error('Unmatched native NI preparation')
 return [cold,normal].map((x:any)=>{
  const q=x.combinedConverter
  if(!q?.signalMeanOnly||!Number.isFinite(q.allCaptures_s)||q.allCaptures_s<0||!Number.isFinite(q.omittedCaptureUpper_W)||q.omittedCaptureUpper_W<0||!Number.isFinite(q.initialN10_atoms)||q.initialN10_atoms<=0||!Number.isFinite(q.detectableEvents_s)||q.detectableEvents_s<0||q.detectableEvents_s>q.allCaptures_s)throw Error('Invalid physical capture mean')
  const expected=q.allCaptures_s*2.791e6*1.602176634e-19
  if(Math.abs(q.omittedCaptureUpper_W-expected)>1e-12*Math.max(1,expected))throw Error('Capture diagnostic energy mismatch')
  return {name:x===cold?'cold':'normal',receiver_K:x===cold?300:578.045678,capture_s:q.allCaptures_s,upper_W:expected,initialN10:q.initialN10_atoms,eventMean_s:q.detectableEvents_s}
 })
}
export const nuclearObservationResponsePython=String.raw`
import sys,json,math,numpy as np
from scipy.integrate import solve_ivp,quad
from scipy.optimize import root
d=json.load(sys.stdin)
`+solid304Python+fuelMaterialPython+String.raw`
b=d['apparatus'];h=d['geometryOwner'];g=d['geometry'];r=d['response'];raw=d['stocks']
ri=h['sourceThimbleDiameter_m']/2-b['wall_m'];ro=ri+b['wall_m'];rc=b['carrierOD_m']/2;rci=rc-b['carrierWall_m']
edges=[h['sourceThimbleBottom_m'],*b['diaphragmCentres_m'],h['sourceThimbleTop_m']]
filmR=g['filmOuterRadius_m'];L=b['carrierLength_m'];aw=math.pi*(b['leadOD_m']/2)**2
group=lambda id:'COLLECTOR' if id in ['CARRIER','CONVERTER','RING.0','RING.1'] else 'SOURCE' if id in ['CAPSULE','CAPSULE.SUPPORT','EMITTER','CAPSULE.He'] else id
ids=list(dict.fromkeys(group(x['id']) for x in raw));ix={s:i for i,s in enumerate(ids)};members={s:[x for x in raw if group(x['id'])==s] for s in ids}
def cp(x,T):
 if x['material']=='304':return x['mass_kg']*steel(T)['cp']
 if x['material']=='B4C':
  if not d['b4cKnots_K'][0]<=T<=d['b4cKnots_K'][-1]:raise ValueError('B4C outside consumed coupon caloric table; no extrapolation or clamp')
  return x['mass_kg']*float(np.interp(T,d['b4cKnots_K'],d['b4cCp_J_kg_K']))
 return x['capacity_J_K']
def energy(x,T):
 if x['material']=='304':return x['mass_kg']*steel(T)['e']
 if x['material']=='B4C':
  total=0.
  for a,z,ca,cz in zip(d['b4cKnots_K'],d['b4cKnots_K'][1:],d['b4cCp_J_kg_K'],d['b4cCp_J_kg_K'][1:]):
   dt=max(0.,min(T,z)-a);total+=ca*dt+.5*(cz-ca)/(z-a)*dt*dt
  return x['mass_kg']*(total-d['b4cPrimitiveAt300'])
 return x['capacity_J_K']*(T-300)
def C(T):return np.array([sum(cp(x,T[i]) for x in members[s]) for i,s in enumerate(ids)])
def E(T):return sum(energy(x,T[i]) for i,s in enumerate(ids) for x in members[s])
def khe(T):return gap([T]*4,b['heliumOriginal_Pa'],[filmR,ri,ro,L,0,0,filmR],0)[3]
links=[];baths=[]
def link(a,c,kind,geom):
 if geom==0:return
 if a==c or geom<=0:raise ValueError(('contact incidence',a,c,geom))
 links.append(dict(a=ix[a],b=ix[c],kind=kind,geometry=geom,owners=[a,c]))
def bath(a,area,kind):
 if area<=0:raise ValueError('absent bath patch')
 baths.append(dict(a=ix[a],area=area,kind=kind,owner=a))
def length(stock):return stock['volume_m3']/(math.pi*(ro*ro-ri*ri))
stocks={x['id']:x for x in raw}
wallL=[length(stocks['WALL.'+str(i)]) for i in range(5)]
shell=math.pi*(ro*ro-ri*ri)
link('TERMINAL','WALL.0','steel',shell/(.5*(g['terminalBand']['length_m']+wallL[0])))
bath('TERMINAL',g['terminalBand']['outerContactArea_m2'],'wet');bath('TERMINAL',b['terminalToRoom_W_K'],'room')
for i in range(5):
 bath('WALL.'+str(i),2*math.pi*ro*wallL[i],'wet')
 if i<4:link('WALL.'+str(i),'WALL.'+str(i+1),'steel',shell/(.5*(wallL[i]+wallL[i+1])))
 # Inner lateral patches exclude endcaps, diaphragms, rings and capsule support contacts.
 lo=edges[i]+(b['endcap_m'] if i==0 else b['diaphragm_m']/2);hi=edges[i+1]-(b['endcap_m'] if i==4 else b['diaphragm_m']/2)
 absent=(2*b['ringWidth_m'] if i==3 else 0.)
 area=2*math.pi*ri*(hi-lo-absent)-(3*ri*b['barAngle_rad']*b['barWidth_m'] if i==1 else 0.)
 if i==0:
  terminalArea=2*math.pi*ri*(g['terminalBand']['hi_m']-lo)
  link('He.0','TERMINAL','helium',2*terminalArea/ri);area-=terminalArea
 gapSize=ri-filmR if i==3 else ri-b['capsuleOD_m']/2 if i==1 else ri
 link('He.'+str(i),'WALL.'+str(i),'helium',2*area/gapSize)
gasLo=[edges[i]+(b['endcap_m'] if i==0 else b['diaphragm_m']/2) for i in range(5)]
gasHi=[edges[i+1]-(b['endcap_m'] if i==4 else b['diaphragm_m']/2) for i in range(5)]
for i in range(4):
 s='DIAPHRAGM.'+str(i);edgeArea=2*math.pi*ri*b['diaphragm_m']
 link(s,'WALL.'+str(i),'steel',.5*edgeArea/(ri/2));link(s,'WALL.'+str(i+1),'steel',.5*edgeArea/(ri/2))
 faceArea=stocks[s]['volume_m3']/b['diaphragm_m']
 for j in [i,i+1]:link(s,'He.'+str(j),'helium',faceArea/(.5*(gasHi[j]-gasLo[j])))
for s,j,wall in [('ENDCAP.LOWER',0,'TERMINAL'),('ENDCAP.UPPER',4,'WALL.4')]:
 link(s,wall,'steel',2*math.pi*ri*b['endcap_m']/(ri/2))
 link(s,'He.'+str(j),'helium',(stocks[s]['volume_m3']/b['endcap_m'])/(.5*(gasHi[j]-gasLo[j])))
link('COLLECTOR','WALL.3','steel',2*math.pi*b['ringWidth_m']/math.log(ri/rci)*g['ringMetalFractionSum'])
link('COLLECTOR','He.3','helium',2*(2*math.pi*filmR*L)/(ri-filmR)+2*(2*math.pi*rci*L)/rci)
cr=b['capsuleOD_m']/2
link('SOURCE','WALL.1','steel',3*b['barAngle_rad']*b['barWidth_m']/math.log(ri/cr))
capsuleArea=2*math.pi*cr*b['capsuleLength_m']+2*math.pi*cr**2-3*cr*b['barAngle_rad']*b['barWidth_m']
barFaces=3*((ri*ri-cr*cr)*b['barAngle_rad']+2*(ri-cr)*b['barWidth_m'])
link('SOURCE','He.1','helium',2*(capsuleArea+barFaces)/(ri-cr))
for wire in [0,1]:
 parts=[x for x in d['leadSegments'] if x['id'].startswith('LEAD.'+str(wire)+'.')]
 for a,c in zip(parts,parts[1:]):link(a['id'],c['id'],'steel',aw/(.5*((a['hi_m']-a['lo_m'])+(c['hi_m']-c['lo_m']))))
 for p in parts:
  j=int(p['id'].split('.')[-1]);link(p['id'],'He.'+str(j),'helium',2*math.pi*b['leadOD_m']*p['gasExposedLength_m']/ (ri-filmR if j==3 else ri-cr if j==1 else ri))
 def covering(z):return next(x['id'] for x in parts if x['lo_m']<=z<x['hi_m'])
 for x in raw:
  if x['material']!='glass' or not x['id'].endswith('.'+str(wire)):continue
  z=x['zMoment_m4']/x['volume_m3'];lead=covering(z)
  parent=x['id'].split('.GLASS.')[0];metal='COLLECTOR' if parent.startswith('RING.') else parent
  span=x['volume_m3']/(math.pi*((b['sleeveOD_m']/2)**2-(b['leadOD_m']/2)**2))
  G=2*math.pi*b['glassK_W_m_K']*span/math.log(b['sleeveOD_m']/b['leadOD_m'])
  link(lead,x['id'],'fixed',2*G);link(x['id'],metal,'fixed',2*G)
 final=parts[-1]['id'];metal='COLLECTOR' if wire==0 else 'DIAPHRAGM.3'
 link(final,metal,'steel',g['bareContactArea_m2']/b['bareContactLength_m'])
def rates(T,factor,bathT,load):
 q=np.zeros(len(ids));q[ix['COLLECTOR']]=load;q[ix['SOURCE']]=b['capsuleDecayUpper_W'];external=load+b['capsuleDecayUpper_W']
 for p in links:
  a,c=p['a'],p['b'];mean=.5*(T[a]+T[c]);k=steel(mean)['k'] if p['kind']=='steel' else khe(mean) if p['kind']=='helium' else 1.
  Q=factor*p['geometry']*k*(T[c]-T[a]);q[a]+=Q;q[c]-=Q
 for p in baths:
  a=p['a'];G=factor*p['area']*(r['wet_W_m2_K'] if p['kind']=='wet' else 1.);tb=r['roomBound_K'] if p['kind']=='room' else bathT
  Q=G*(tb-T[a]);q[a]+=Q;external+=Q
 return q,external
rows=[];T0=np.full(len(ids),300.);initial=E(T0)
for load in d['loads']:
 for bathT in ([load['receiver_K']] if load['name']=='cold' else [load['receiver_K'],r['warmBound_K']]):
  for upper in [False,True]:
   for factor in r['contacts']:
    Q=load['upper_W'] if upper else 0.
    def rhs(t,y):
     q,external=rates(y[:-1],factor,bathT,Q);return np.r_[q/C(y[:-1]),external]
    sol=solve_ivp(rhs,[0,r['observation_s']],np.r_[T0,0.],method='BDF',rtol=2e-10,atol=1e-11,max_step=2.)
    if not sol.success:raise ValueError(sol.message)
    T=sol.y[:-1,-1];defect=E(T)-initial-sol.y[-1,-1]
    stationary=root(lambda x:rates(x,factor,bathT,Q)[0],np.full(len(ids),max(300,bathT)),tol=1e-10)
    if not stationary.success and np.max(np.abs(stationary.fun))>1e-7:raise ValueError(('stationary contact',stationary.message))
    Ts=stationary.x;residual=float(np.max(np.abs(rates(Ts,factor,bathT,Q)[0])))
    if not np.all(np.isfinite(Ts)) or residual>1e-6 or abs(defect)>2e-4:raise ValueError(('thermal coupon residual',residual,defect))
    rows.append(dict(case=load['name'],receiver_K=bathT,loadMeaning='omitted-upper diagnostic' if upper else 'selected omission',captureDiagnostic_W=Q,contactFactor=factor,seconds=r['observation_s'],converterAtStop_K=float(T[ix['COLLECTOR']]),converterMaximumSampled_K=float(max(sol.y[ix['COLLECTOR']])),conditionalStationaryConverter_K=float(Ts[ix['COLLECTOR']]),energyDefect_J=float(defect),stationaryResidual_W=residual,stopTemperatures_K=dict(zip(ids,map(float,T))),stationaryTemperatures_K=dict(zip(ids,map(float,Ts))),withinResponse=bool(290<=min(sol.y[ix['COLLECTOR']]) and max(sol.y[ix['COLLECTOR']])<=900 and 290<=Ts[ix['COLLECTOR']]<=900)))
print(json.dumps(dict(rows=rows,nodeOwners=members,contacts=links,baths=baths),allow_nan=False))
`
export async function runNuclearObservationResponse(directory:string,python:string,pairedPath:string){
 const sourcePaths=[import.meta.path,resolve(import.meta.dir,'reference-design-nuclear-observation.ts'),resolve(import.meta.dir,'reference-design-fuel-handling.ts'),resolve(import.meta.dir,'reference-design-cold-nuclear.ts'),resolve(import.meta.dir,'reference-design-fuel-materials.ts'),resolve(import.meta.dir,'reference-design-pressurizer-heater-contact.ts')]
 const sourceHashes=Object.fromEntries(await Promise.all(sourcePaths.map(async p=>[p,sha(await Bun.file(p).text())])))
 const docPath=resolve(directory,'systems/instrumentation/nuclear-observation-apparatus.md'),doc=await Bun.file(docPath).text(),pairedText=await Bun.file(pairedPath).text(),paired=JSON.parse(pairedText)
 const response=parseNuclearObservationResponse(doc),apparatus=await runNuclearObservation(directory,python),loads=converterLoads(paired)
 if(paired.input.heatDiagnostic.boronUpperEnergy_MeV!==response.captureUpper_MeV)throw Error('Unmatched authoritative capture upper')
 if(JSON.stringify(paired.input.apparatus)!==JSON.stringify(apparatus.consumedInputs.apparatus))throw Error('Paired optical apparatus differs from current owner')
 const knots=[290,298.15,300,400,500,600,700,800,900],mm=apparatus.consumedInputs.geometryOwner.b4cMolarMass_kg_mol
 const cp=knots.map(t=>b4cCaloric(t,mm).cp_J_kg_K),primitive=knots.slice(0,2).reduce((s,a,i)=>s+.5*(cp[i]!+cp[i+1]!)*(knots[i+1]!-a),0)
 const input={...apparatus.consumedInputs,response,stocks:apparatus.stocks,geometry:apparatus.geometry,leadSegments:apparatus.leadSegments,loads,b4cKnots_K:knots,b4cCp_J_kg_K:cp,b4cPrimitiveAt300:primitive}
 const child=Bun.spawn([python,'-c',nuclearObservationResponsePython],{stdin:'pipe',stdout:'pipe',stderr:'pipe'});child.stdin.write(JSON.stringify(input));child.stdin.end()
 const [out,err,status]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);if(status!==0)throw Error(err)
 if(await Bun.file(docPath).text()!==doc||await Bun.file(pairedPath).text()!==pairedText)throw Error('NI response source input changed during calculation')
 if((await Promise.all(sourcePaths.map(async p=>sha(await Bun.file(p).text())))).some((s,i)=>s!==sourceHashes[sourcePaths[i]!]))throw Error('NI response calculation changed during calculation')
 return {result:JSON.parse(out),consumedInputs:input,calculationSha256:sha(nuclearObservationResponsePython+converterLoads.toString()),inputSha256:sha(JSON.stringify(input)),pairedReceiptSha256:sha(pairedText),pairedCalculationSha256:paired.calculationSHA256,pairedInputSha256:paired.inputSHA256,sourceHashes,reviewedContextSha256:sha(doc),scope:'60s finite apparatus plus conditional stationary held-wet recipient comparison; not achieved cooling, acquired counts, exposure life or operating authority'}
}
if(import.meta.main){const [directory,python,paired,out]=Bun.argv.slice(2);if(!directory||!python||!paired||!out)throw Error('Usage: nuclear-observation-response <LD01-dir> <python> <paired-json> <new-json>');if(await Bun.file(out).exists())throw Error('Refusing to replace retained receipt');await Bun.write(out,JSON.stringify(await runNuclearObservationResponse(directory,python,paired),null,2)+'\n')}
