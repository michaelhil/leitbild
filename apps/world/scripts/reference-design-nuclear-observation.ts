/** Finite one-converter geometry/caloric input check; no source or detector runtime. */
import {createHash} from 'node:crypto'
import {resolve} from 'node:path'
import {z} from 'zod'
import {parseFuelHandling,b4cCaloric} from './reference-design-fuel-handling'
import {parseColdNuclear} from './reference-design-cold-nuclear'
import {solid304Python} from './reference-design-pressurizer-heater-contact'
import {fuelMaterialPython} from './reference-design-fuel-materials'
const p=z.number().finite().positive(),f=z.number().finite()
const schema=z.object({wall_m:p,endcap_m:p,diaphragm_m:p,diaphragmCentres_m:z.tuple([f,f,f,f]),
 carrierCentre_m:f,carrierLength_m:p,carrierOD_m:p,carrierWall_m:p,b10Areal_kg_m2:p,ringWidth_m:p,
 capsuleOD_m:p,capsuleLength_m:p,capsuleWall_m:p,barAngle_rad:p,barWidth_m:p,
 leadOD_m:p,leadRadius_m:p,leadAngles_rad:z.tuple([f,f]),sleeveOD_m:p,bareContactLength_m:p,
 glassDensity_kg_m3:p,glassCp_J_kg_K:p,glassK_W_m_K:p,emitterDensity_kg_m3:p,emitterCp_J_kg_K:p,
 emission_neutrons_s_g:p,capsuleDecayUpper_W:p,terminal_kg:p,terminalToRoom_W_K:p,
 heliumOriginal_Pa:p,original_K:z.literal(300),heliumMolarMass_kg_mol:p,R_J_mol_K:p,
 contactFactors:z.tuple([z.literal(.5),z.literal(1),z.literal(2)]),responseRange_K:z.tuple([z.literal(290),z.literal(900)])}).strict()
export function parseNuclearObservation(document:string){
 const blocks=[...document.matchAll(/^```reference-nuclear-observation-apparatus\s*\n([\s\S]*?)^```\s*$/gm)]
 if(blocks.length!==1)throw Error('Expected one nuclear observation apparatus block')
 return schema.parse(JSON.parse(blocks[0]![1]!))
}
type Stock={id:string,material:'304'|'B4C'|'glass'|'emitter'|'He',volume_m3:number,mass_kg:number,zMoment_m4:number,capacity_J_K?:number,energy_J?:number}
const sum=(xs:number[])=>xs.reduce((a,q)=>a+q,0)
type Envelope=Pick<ReturnType<typeof parseFuelHandling>,'sourceThimbleDiameter_m'|'sourceThimbleBottom_m'|'sourceThimbleTop_m'|'sourceCapsule_m'|'b4cDensity_kg_m3'|'b10AtomFraction'|'b10MolarMass_kg_mol'|'b4cMolarMass_kg_mol'>
export function nuclearObservationGeometry(b:ReturnType<typeof parseNuclearObservation>,h:Envelope,source:Pick<ReturnType<typeof parseColdNuclear>['source'],'birthEmission_neutrons_s'>){
 const checks:{name:string,actual?:number}[]=[],stocks:Stock[]=[]
 const check=(name:string,ok:boolean,actual?:number)=>{if(!ok)throw Error(name);checks.push({name,...(actual===undefined?{}:{actual})})}
 const ro=h.sourceThimbleDiameter_m/2,ri=ro-b.wall_m,start=h.sourceThimbleBottom_m,end=h.sourceThimbleTop_m,
  rc=b.carrierOD_m/2,rci=rc-b.carrierWall_m,c=b.carrierCentre_m,L=b.carrierLength_m,filmLo=c-L/2,filmHi=c+L/2,
  f10=4*h.b10AtomFraction*h.b10MolarMass_kg_mol/h.b4cMolarMass_kg_mol,
  filmR=Math.sqrt(rc*rc+2*rc*b.b10Areal_kg_m2/(h.b4cDensity_kg_m3*f10)),filmV=Math.PI*(filmR**2-rc**2)*L,
  aw=Math.PI*(b.leadOD_m/2)**2,as=Math.PI*(b.sleeveOD_m/2)**2,rb=b.leadRadius_m,
  rings:[[number,number],[number,number]]=[[filmLo-b.ringWidth_m,filmLo],[filmHi,filmHi+b.ringWidth_m]],
  endpoints=[rings[1][1],b.diaphragmCentres_m[3]+b.diaphragm_m/2],edges=[start,...b.diaphragmCentres_m,end],
  rhoHe=b.heliumOriginal_Pa*b.heliumMolarMass_kg_mol/(b.R_J_mol_K*b.original_K),steelDensity=7920,g=9.80665,
  shellArea=Math.PI*(ro**2-ri**2),terminalVolume=b.terminal_kg/steelDensity,terminalLength=terminalVolume/shellArea
 const add=(id:string,material:Stock['material'],V:number,z:number,density:number,capacity_J_K?:number,energy_J?:number)=>{
  check('finite positive stock '+id,Number.isFinite(V)&&V>0&&Number.isFinite(z)&&density>0,V)
  stocks.push({id,material,volume_m3:V,mass_kg:V*density,zMoment_m4:V*z,...(capacity_J_K===undefined?{}:{capacity_J_K}),...(energy_J===undefined?{}:{energy_J})})
 }
 check('disjoint capsule/carrier/bore dimensions',start<end&&ri>0&&rci>0&&filmR<ri&&b.capsuleWall_m*2<b.capsuleLength_m&&b.capsuleOD_m/2>b.capsuleWall_m)
 check('strict diaphragm order',b.diaphragmCentres_m.every((z,i)=>z>start+b.endcap_m&&(i===0||z>b.diaphragmCentres_m[i-1]!+b.diaphragm_m))&&b.diaphragmCentres_m[3]<end-b.endcap_m)
 check('single film fits passive collection cell',filmLo>edges[3]!+b.diaphragm_m/2&&rings[0][0]>edges[3]!+b.diaphragm_m/2&&rings[1][1]<edges[4]!-b.diaphragm_m/2)
 check('naked wire clears film',rb-b.leadOD_m/2>filmR,rb-b.leadOD_m/2-filmR)
 check('sleeves fit bore without film overlap',rb+b.sleeveOD_m/2<ri&&rb-b.sleeveOD_m/2>rci,ri-rb-b.sleeveOD_m/2)
 check('positive carrier/ring end patch',rc>rci&&rings.every(([a,z])=>z>a),Math.PI*(rc**2-rci**2))
 const holes:(id:string,lo:number,hi:number) => {v:number,moment:number}=(id,lo,hi)=>{
  let v=0,moment=0
  endpoints.forEach((endpoint,k)=>{
   const hiHere=Math.min(hi,endpoint);if(hiHere<=lo)return
   const bareLo=endpoint-b.bareContactLength_m,sleeveHi=Math.min(hiHere,bareLo)
   if(sleeveHi>lo){const len=sleeveHi-lo,vs=(as-aw)*len;add(id+'.GLASS.'+k,'glass',vs,(lo+sleeveHi)/2,b.glassDensity_kg_m3,vs*b.glassDensity_kg_m3*b.glassCp_J_kg_K,0);v+=as*len;moment+=as*len*(lo+sleeveHi)/2}
   const a=Math.max(lo,bareLo);if(hiHere>a){const len=hiHere-a;v+=aw*len;moment+=aw*len*(a+hiHere)/2}
  });return {v,moment}
 }
 check('terminal is a carved lower wall band',terminalLength>b.endcap_m&&start+terminalLength<edges[1]!,terminalLength)
 add('TERMINAL','304',terminalVolume,start+terminalLength/2,steelDensity)
 for(let i=0;i<5;i++){
  const lo=i===0?start+terminalLength:edges[i]!,hi=edges[i+1]!
  add('WALL.'+i,'304',shellArea*(hi-lo),(hi+lo)/2,steelDensity)
 }
 for(let i=0;i<4;i++){
  const z=edges[i+1]!,a=z-b.diaphragm_m/2,e=z+b.diaphragm_m/2,removed=holes('DIAPHRAGM.'+i,a,e),V=Math.PI*ri**2*b.diaphragm_m-removed.v
  add('DIAPHRAGM.'+i,'304',V,(Math.PI*ri**2*b.diaphragm_m*z-removed.moment)/V,steelDensity)
 }
 for(const [name,a,e] of [['LOWER',start,start+b.endcap_m],['UPPER',end-b.endcap_m,end]] as const){
  const removed=holes('ENDCAP.'+name,a,e),gross=Math.PI*ri**2*(e-a),V=gross-removed.v
  add('ENDCAP.'+name,'304',V,(gross*(a+e)/2-removed.moment)/V,steelDensity)
 }
 let ringMetalFraction=0
 rings.forEach(([a,e],i)=>{const removed=holes('RING.'+i,a,e),gross=Math.PI*(ri**2-rci**2)*(e-a),V=gross-removed.v
  add('RING.'+i,'304',V,(gross*(a+e)/2-removed.moment)/V,steelDensity);ringMetalFraction+=V/gross})
 add('CARRIER','304',Math.PI*(rc**2-rci**2)*L,c,steelDensity)
 const b4cMass=filmV*h.b4cDensity_kg_m3,b4c=b4cCaloric(b.original_K,h.b4cMolarMass_kg_mol)
 add('CONVERTER','B4C',filmV,c,h.b4cDensity_kg_m3,b4cMass*b4c.cp_J_kg_K,b4cMass*b4c.e_J_kg)
 const contactSpans=[...rings,...b.diaphragmCentres_m.map(z=>[z-b.diaphragm_m/2,z+b.diaphragm_m/2] as [number,number]),[start,start+b.endcap_m],[end-b.endcap_m,end]]
 const leadSegments:{id:string,lo_m:number,hi_m:number,gasExposedLength_m:number,sleeveLength_m:number,bareMetalLength_m:number}[]=[]
 endpoints.forEach((e,i)=>{
  for(let j=0;j<5;j++){
   const a=edges[j]!,q=Math.min(e,edges[j+1]!);if(q<=a)continue
   let sleeveLength_m=0,bareMetalLength_m=0
   for(const [lo,hi] of contactSpans){
    const l=Math.max(a,lo!),r=Math.min(q,hi!);if(r<=l)continue
    sleeveLength_m+=Math.max(0,Math.min(r,e-b.bareContactLength_m)-l)
    bareMetalLength_m+=Math.max(0,r-Math.max(l,e-b.bareContactLength_m))
   }
   const gasExposedLength_m=q-a-sleeveLength_m-bareMetalLength_m
   check('complementary exposed lead patches '+i+'.'+j,gasExposedLength_m>=0&&sleeveLength_m>=0&&bareMetalLength_m>=0)
   const id='LEAD.'+i+'.'+j;add(id,'304',aw*(q-a),(q+a)/2,steelDensity)
   leadSegments.push({id,lo_m:a,hi_m:q,gasExposedLength_m,sleeveLength_m,bareMetalLength_m})
  }
 })
 const cr=b.capsuleOD_m/2,ci=cr-b.capsuleWall_m,cz=h.sourceCapsule_m,cv=Math.PI*cr**2*b.capsuleLength_m,
  internalV=Math.PI*ci**2*(b.capsuleLength_m-2*b.capsuleWall_m),emitterMass=source.birthEmission_neutrons_s/b.emission_neutrons_s_g/1000,
  emitterV=emitterMass/b.emitterDensity_kg_m3,barV=3*.5*(ri**2-cr**2)*b.barAngle_rad*b.barWidth_m
 check('capsule and source support fit one passive cell',cz-b.capsuleLength_m/2>edges[1]!+b.diaphragm_m/2&&cz+b.capsuleLength_m/2<edges[2]!-b.diaphragm_m/2&&cr<ri&&b.barAngle_rad<2*Math.PI/3&&emitterV<internalV)
 for(const angle of b.leadAngles_rad){const clearance=Math.min(...[0,2*Math.PI/3,4*Math.PI/3].map(t=>Math.abs(Math.atan2(Math.sin(angle-t),Math.cos(angle-t)))))
  check('source bar/lead transverse clearance '+angle,clearance>b.barAngle_rad/2+Math.asin(b.leadOD_m/(2*rb)))}
 add('CAPSULE','304',cv-internalV,cz,steelDensity);add('CAPSULE.SUPPORT','304',barV,cz,steelDensity)
 add('EMITTER','emitter',emitterV,cz,b.emitterDensity_kg_m3,emitterMass*b.emitterCp_J_kg_K,0)
 const gas=(id:string,V:number,z:number)=>add(id,'He',V,z,rhoHe,1.5*b.heliumOriginal_Pa*V/b.original_K,1.5*b.heliumOriginal_Pa*V)
 gas('CAPSULE.He',internalV-emitterV,cz)
 for(let i=0;i<5;i++){
  const lo=edges[i]!+(i===0?b.endcap_m:b.diaphragm_m/2),hi=edges[i+1]!-(i===4?b.endcap_m:b.diaphragm_m/2)
  let V=Math.PI*ri**2*(hi-lo),moment=V*(hi+lo)/2
  const debit=(vol:number,z:number)=>{V-=vol;moment-=vol*z}
  if(i===1){debit(cv,cz);debit(barV,cz)}
  if(i===3){debit(Math.PI*(filmR**2-rci**2)*L,c);for(const [a,e] of rings)debit(Math.PI*(ri**2-rci**2)*(e-a),(a+e)/2)}
  endpoints.forEach(e=>{
   const top=Math.min(hi,e);if(top<=lo)return
   let wireV=aw*(top-lo),wireMoment=wireV*(top+lo)/2
   for(const [a,q] of rings){const l=Math.max(lo,a),r=Math.min(top,q);if(r>l){wireV-=aw*(r-l);wireMoment-=aw*(r-l)*(l+r)/2}}
   V-=wireV;moment-=wireMoment
  });gas('He.'+i,V,moment/V)
 }
 const envelope=Math.PI*ro**2*(end-start),internalTotal=sum(stocks.map(s=>s.volume_m3)),defect=internalTotal-envelope
 check('once-only full thimble volume union',Math.abs(defect)<1e-16,defect)
 const b10Mass=b4cMass*f10,sourcePowerComparison_W=emitterMass*1000*38.5
 check('selected capsule decay upper exceeds sourced comparison',sourcePowerComparison_W<=b.capsuleDecayUpper_W,sourcePowerComparison_W)
 return {checks,stocks,leadSegments,geometry:{filmOuterRadius_m:filmR,filmThickness_m:filmR-rc,b10Mass_kg:b10Mass,
  opticalArea_m2:2*Math.PI*rc*L,ringMetalFractionSum:ringMetalFraction,bareContactArea_m2:Math.PI*b.leadOD_m*b.bareContactLength_m,
  outerEnvelope_m3:envelope,internalVolume_m3:internalTotal,volumeDefect_m3:defect,sourcePowerComparison_W,
  terminalBand:{lo_m:start,hi_m:start+terminalLength,length_m:terminalLength,outerContactArea_m2:2*Math.PI*ro*terminalLength,shellArea_m2:shellArea,wall0Length_m:edges[1]!-start-terminalLength},
  gasVolume_m3:sum(stocks.filter(s=>s.material==='He').map(s=>s.volume_m3)),
  gravitationalEnergy_J:sum(stocks.map(s=>s.mass_kg*g*s.zMoment_m4/s.volume_m3))},
  meaning:'Static original stocks and positive contact geometry only; no source rate, detector exposure, acquisition or plant authority'}
}
const sha=(s:string)=>createHash('sha256').update(s).digest('hex')
const caloricCalculation=String.raw`
import sys,json,math
d=json.load(sys.stdin)
`+solid304Python+fuelMaterialPython+String.raw`
rows=[]
for T in [d['apparatus']['responseRange_K'][0],d['apparatus']['original_K'],d['apparatus']['responseRange_K'][1]]:
 s=steel(T)
 if min(s['cp'],s['k'])<=0:raise ValueError('NI material domain')
 b=d['apparatus'];v=d['geometry'];ri=d['geometryOwner']['sourceThimbleDiameter_m']/2-b['wall_m']
 khe=gap([T]*4,b['heliumOriginal_Pa'],[v['filmOuterRadius_m'],ri,ri+b['wall_m'],b['carrierLength_m'],0,0,v['filmOuterRadius_m']],0)[3]
 if khe<=0:raise ValueError('NI helium conductivity')
 contacts=dict(rings_W_K=2*math.pi*s['k']*b['ringWidth_m']/math.log(ri/(b['carrierOD_m']/2-b['carrierWall_m']))*v['ringMetalFractionSum'],
  capsuleSupports_W_K=3*s['k']*b['barAngle_rad']*b['barWidth_m']/math.log(ri/(b['capsuleOD_m']/2)),
  eachBareTermination_W_K=s['k']*v['bareContactArea_m2']/b['bareContactLength_m'],
  terminalRoom_W_K=b['terminalToRoom_W_K'],
  terminalWall0_W_K=s['k']*v['terminalBand']['shellArea_m2']/(.5*(v['terminalBand']['length_m']+v['terminalBand']['wall0Length_m'])),
  lowerEndcapTerminal_W_K=s['k']*2*math.pi*ri*b['endcap_m']/(ri/2),
  eachGlassSleevePerLength_W_m_K=2*math.pi*b['glassK_W_m_K']/math.log(b['sleeveOD_m']/b['leadOD_m']),
  detectorAnnulus_h_W_m2_K=2*khe/(ri-v['filmOuterRadius_m']),carrierInside_h_W_m2_K=2*khe/(b['carrierOD_m']/2-b['carrierWall_m']),
  capsuleCell_h_W_m2_K=2*khe/(ri-b['capsuleOD_m']/2),emptyCell_h_W_m2_K=2*khe/ri)
 sensitivities=[]
 for factor in b['contactFactors']:
  scaled={name:factor*x for name,x in contacts.items()}
  if min(scaled.values())<=0 or not all(math.isfinite(x) for x in scaled.values()):raise ValueError('NI contact')
  # Independent recipient is credited with the same signed heat, not a second sink.
  sensitivities.append(dict(factor=factor,contacts=scaled,forwardDelta_K=10,reverseDelta_K=-10))
 rows.append(dict(temperature_K=T,steel=s,heliumConductivity_W_m_K=khe,contactSensitivity=sensitivities))
print(json.dumps(rows,allow_nan=False))
`
export async function runNuclearObservation(directory:string,python:string){
 const sourceFiles=[import.meta.path,resolve(import.meta.dir,'reference-design-fuel-handling.ts'),resolve(import.meta.dir,'reference-design-cold-nuclear.ts'),resolve(import.meta.dir,'reference-design-pressurizer-heater-contact.ts'),resolve(import.meta.dir,'reference-design-fuel-materials.ts')],sourceHashes=Object.fromEntries(await Promise.all(sourceFiles.map(async p=>[p,sha(await Bun.file(p).text())])))
 const paths=['systems/instrumentation/nuclear-observation-apparatus.md','systems/reactor/fuel-handling-and-pool.md','systems/reactor/cold-source-and-startup.md'],docs=await Promise.all(paths.map(p=>Bun.file(resolve(directory,p)).text())),
  b=parseNuclearObservation(docs[0]!),h=parseFuelHandling(docs[1]!),s=parseColdNuclear(docs[2]!).source,
  consumedInputs={apparatus:b,geometryOwner:{sourceThimbleDiameter_m:h.sourceThimbleDiameter_m,sourceThimbleBottom_m:h.sourceThimbleBottom_m,sourceThimbleTop_m:h.sourceThimbleTop_m,sourceCapsule_m:h.sourceCapsule_m,b4cDensity_kg_m3:h.b4cDensity_kg_m3,b10AtomFraction:h.b10AtomFraction,b10MolarMass_kg_mol:h.b10MolarMass_kg_mol,b4cMolarMass_kg_mol:h.b4cMolarMass_kg_mol},source:{identity:s.identity,birthEmission_neutrons_s:s.birthEmission_neutrons_s}},
  geo=nuclearObservationGeometry(b,h,s),child=Bun.spawn([python,'-c',caloricCalculation],{stdin:'pipe',stdout:'pipe',stderr:'pipe'})
 child.stdin.write(JSON.stringify({...consumedInputs,geometry:geo.geometry}));child.stdin.end();const [out,err,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);if(exit!==0)throw Error(err)
 const caloric=JSON.parse(out) as {temperature_K:number,steel:{cp:number,k:number,e:number},heliumConductivity_W_m_K:number,contactSensitivity:{factor:number,contacts:Record<string,number>,forwardDelta_K:number,reverseDelta_K:number}[]}[],at300=caloric.find(x=>x.temperature_K===300)!.steel
 const stocks=geo.stocks.map(x=>x.material==='304'?{...x,capacity_J_K:x.mass_kg*at300.cp,energy_J:0}:x)
 const context=Object.fromEntries(docs.map((q,i)=>[paths[i]!,sha(q)]))
 if((await Promise.all(paths.map(p=>Bun.file(resolve(directory,p)).text()))).some((q,i)=>q!==docs[i]))throw Error('NI owner changed during check')
 if((await Promise.all(sourceFiles.map(async p=>sha(await Bun.file(p).text())))).some((q,i)=>q!==sourceHashes[sourceFiles[i]!]))throw Error('NI calculation source changed during check')
 return {...geo,stocks,caloric,consumedInputs,calculationSha256:sha(nuclearObservationGeometry.toString()+caloricCalculation),inputSha256:sha(JSON.stringify(consumedInputs)),sourceHashes,reviewedContextSha256:context}
}
if(import.meta.main){const [dir,python,out]=Bun.argv.slice(2);if(!dir||!python||!out)throw Error('Expected LD01 directory, Python and new receipt path');const result=await runNuclearObservation(dir,python);await Bun.write(out,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({checks:result.checks.length,geometry:result.geometry,calculationSha256:result.calculationSha256,inputSha256:result.inputSha256}))}
