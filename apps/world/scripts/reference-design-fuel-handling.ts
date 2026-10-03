/** Bounded LD-01 geometry/extensive-history audit; no crane or neutron runtime. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parseFuelConstruction } from './reference-design-fuel-construction'

const p=z.number().finite().positive(), finite=z.number().finite()
const schema=z.object({slotRadiusSquared:z.literal(61),supportRadius_m:p,
 bottomFittingLength_m:p,bottomFitting_kg:p,topFittingLength_m:p,topFitting_kg:p,
 guideInnerDiameter_m:p,seatedBottom_m:finite,transferBottom_m:finite,surface_m:finite,
 minimumActiveCover_m:p,sourceThimbleDiameter_m:p,sourceThimbleBottom_m:finite,
 sourceThimbleTop_m:finite,sourceCapsule_m:finite,wellArea_m2:p,wellFloor_m:finite,
 canalWidth_m:p,canalLength_m:p,canalFloor_m:finite,poolSide_m:p,poolFloor_m:finite,
 rackSide:z.number().int().positive(),rackPitch_m:p,rackSleeveSide_m:p,rackSkin_m:p,
 panelB10_kg_m2:p,b4cDensity_kg_m3:p,b10AtomFraction:z.number().positive().max(1),
 b10MolarMass_kg_mol:p,b4cMolarMass_kg_mol:p,hoistForce_N:p,hoistPower_W:p,motionSpeed_m_s:p,gravity_m_s2:p}).strict()
const b4cT=[200,298.15,300,400,500,600,700,800,900,1000,1100,1200,1300,1400,1500,1600]
const b4cCpMolar=[27.426,53.764,54.266,76.358,89.789,98.366,103.680,107.654,110.989,114.299,117.336,120.190,122.909,125.533,128.089,130.587]
export function b4cCaloric(t:number,molarMass:number){
 if(!Number.isFinite(t)||t<290||t>1600||!Number.isFinite(molarMass)||molarMass<=0)throw Error('Unadmitted B4C caloric state')
 const primitive=(temperature:number)=>{
  let e=0
  for(let i=0;i<b4cT.length-1;i++){
   const width=Math.max(0,Math.min(temperature,b4cT[i+1]!)-b4cT[i]!)
   const slope=(b4cCpMolar[i+1]!-b4cCpMolar[i]!)/(b4cT[i+1]!-b4cT[i]!)
   e+=b4cCpMolar[i]!*width+.5*slope*width*width
  }
  return e/molarMass
 }
 const i=Math.min(b4cT.length-2,b4cT.findIndex((q,j)=>j>0&&t<=q)-1)
 return {cp_J_kg_K:(b4cCpMolar[i]!+(b4cCpMolar[i+1]!-b4cCpMolar[i]!)*(t-b4cT[i]!)/(b4cT[i+1]!-b4cT[i]!))/molarMass,e_J_kg:primitive(t)-primitive(300)}
}
export function parseFuelHandling(document:string){
 const blocks=[...document.matchAll(/^```reference-fuel-handling\s*\n([\s\S]*?)^```\s*$/gm)]
 if(blocks.length!==1)throw Error('Expected one reference-fuel-handling block')
 return schema.parse(JSON.parse(blocks[0]![1]!))
}
export function fuelHandlingChecks(b:ReturnType<typeof parseFuelHandling>,f:ReturnType<typeof parseFuelConstruction>){
 const checks:{name:string,value?:number}[]=[]
 const require=(name:string,ok:boolean,value?:number)=>{if(!ok)throw Error(name);checks.push({name,...(value===undefined?{}:{value})})}
 const sum=(v:number[])=>v.reduce((a,q)=>a+q,0)
 const pitch=f.latticeSide*f.pitch_m,slots:{id:string,x_m:number,y_m:number}[]=[]
 for(let y=-8;y<=8;y++)for(let x=-8;x<=8;x++)if(x*x+y*y<=b.slotRadiusSquared)
  slots.push({id:`LD01.FUEL.FA${String(slots.length+1).padStart(3,'0')}`,x_m:x*pitch,y_m:y*pitch})
 require('exact unique original assembly identity',slots.length===f.assemblies&&new Set(slots.map(s=>s.id)).size===slots.length)
 const corner=Math.max(...slots.map(s=>Math.hypot(Math.abs(s.x_m)+pitch/2,Math.abs(s.y_m)+pitch/2)))
 require('actual square-cell corners fit support',corner<b.supportRadius_m,corner)
 require('rack single-load capacity',b.rackSide*b.rackSide>=f.assemblies)
 require('rack outer envelope fits finite pool',(b.rackSide-1)*b.rackPitch_m+b.rackSleeveSide_m<b.poolSide_m)
 require('rack sleeve clears entire FA envelope',b.rackSleeveSide_m-4*b.rackSkin_m>pitch)
 require('positive rack inter-sleeve water gap',b.rackPitch_m>b.rackSleeveSide_m)
 const b10Fraction=4*b.b10AtomFraction*b.b10MolarMass_kg_mol/b.b4cMolarMass_kg_mol,
  matrixArealMass=b.panelB10_kg_m2/b10Fraction,matrixThickness=matrixArealMass/b.b4cDensity_kg_m3,
  sleeveInner=b.rackSleeveSide_m-2*(2*b.rackSkin_m+matrixThickness),
  matrixArea=4*(b.rackSleeveSide_m-2*b.rackSkin_m-matrixThickness)*f.activeLength_m,
  matrixVolume=matrixArea*matrixThickness,
  sleeveDisplacement=(b.rackSleeveSide_m**2-sleeveInner**2)*f.activeLength_m,
  matrixMass=matrixVolume*b.b4cDensity_kg_m3,
  skinMass=(sleeveDisplacement-matrixVolume)*7920
 require('physical isotope fraction and finite B4C matrix thickness',b10Fraction>0&&b10Fraction<1&&matrixThickness>0&&sleeveInner>pitch)
 require('areal B10 matches actual absorber slab mass',Math.abs(matrixMass*b10Fraction/matrixArea-b.panelB10_kg_m2)<1e-14)
 let maxInverseError=0
 for(const t of [290,294.3,298.15,300,400,800,1200,1600]){
  const q=b4cCaloric(t,b.b4cMolarMass_kg_mol);require('positive B4C Cp at '+t,q.cp_J_kg_K>0)
  let lo=290,hi=1600
  for(let i=0;i<60;i++){const mid=(lo+hi)/2;if(b4cCaloric(mid,b.b4cMolarMass_kg_mol).e_J_kg<q.e_J_kg)lo=mid;else hi=mid}
  maxInverseError=Math.max(maxInverseError,Math.abs((lo+hi)/2-t))
 }
 require('B4C caloric monotone inverse',maxInverseError<1e-9,maxInverseError)
 require('B4C300K datum and negative cold sensible energy',b4cCaloric(300,b.b4cMolarMass_kg_mol).e_J_kg===0&&b4cCaloric(290,b.b4cMolarMass_kg_mol).e_J_kg<0)
 const panelCpDiscrepancy=b4cCaloric(294.3,b.b4cMolarMass_kg_mol).cp_J_kg_K/935.1-1
 require('distinct historical B4C calorimetry discrepancy retained',Math.abs(panelCpDiscrepancy)<.03,panelCpDiscrepancy)
 const rf=f.pelletDiameter_m/2,ro=f.rodOuterDiameter_m/2,ri=ro-f.cladThickness_m,
  go=f.guideOuterDiameter_m/2,gi=b.guideInnerDiameter_m/2,st=b.sourceThimbleDiameter_m/2,
  active=f.activeLength_m,plenum=f.plenumLength_m,
  fullLength=b.bottomFittingLength_m+active+plenum+b.topFittingLength_m,
  rodArea=f.rodsPerAssembly*Math.PI*ro*ro,guideArea=f.guidesPerAssembly*Math.PI*(go*go-gi*gi),
  fuel_kg=f.rodsPerAssembly*Math.PI*rf*rf*active*f.fuelDensityFraction*f.fuelTheoreticalDensity_kg_m3,
  activeClad_kg=f.rodsPerAssembly*Math.PI*(ro*ro-ri*ri)*active*f.cladDensity_kg_m3,
  plenumClad_kg=activeClad_kg*plenum/active,guide_kg=guideArea*fullLength*f.cladDensity_kg_m3,
  fittings_kg=b.bottomFitting_kg+b.topFitting_kg,
  mass_kg=fuel_kg+activeClad_kg+plenumClad_kg+guide_kg+fittings_kg,
  fullDisplacement_m3=rodArea*(active+plenum)+guideArea*fullLength+fittings_kg/f.cladDensity_kg_m3
 require('distinct positive guide annulus and stationary thimble clearance',st<gi&&gi<go,gi-st)
 require('source capsule inside unique fixed thimble',b.sourceThimbleBottom_m<b.sourceCapsule_m&&b.sourceCapsule_m<b.sourceThimbleTop_m)
 require('no overlapping rod gap',rf<ri&&ri<ro)
 const guideIndices=[2,5,8,11,14],pinSites=[] as {x:number,y:number,r:number,guide:boolean}[]
 for(let y=0;y<f.latticeSide;y++)for(let x=0;x<f.latticeSide;x++){
  const guide=guideIndices.includes(x)&&guideIndices.includes(y)
  pinSites.push({x:(x-8)*f.pitch_m,y:(y-8)*f.pitch_m,r:guide?go:ro,guide})
 }
 require('source-independent guide pattern has declared rod and guide counts',pinSites.filter(p=>p.guide).length===f.guidesPerAssembly&&pinSites.filter(p=>!p.guide).length===f.rodsPerAssembly)
 require('central guide actually exists at stationary source axis',pinSites.some(p=>p.guide&&p.x===0&&p.y===0))
 require('all guide and rod circles fit assembly cell',pinSites.every(p=>Math.abs(p.x)+p.r<pitch/2&&Math.abs(p.y)+p.r<pitch/2))
 require('declared rod and guide pattern has no spatial overlap',pinSites.every((a,i)=>pinSites.slice(i+1).every(q=>Math.hypot(a.x-q.x,a.y-q.y)>a.r+q.r)))
 const activeBottom=b.seatedBottom_m+b.bottomFittingLength_m,
  activeTop=activeBottom+active,assemblyTop=b.seatedBottom_m+fullLength,
  transferActiveTop=b.transferBottom_m+b.bottomFittingLength_m+active,
  transferTop=b.transferBottom_m+fullLength
 require('original heated elevations unchanged',Math.abs(activeBottom+2)<1e-12&&Math.abs(activeTop-2)<1e-12)
 require('complete transfer envelope above actual sill',b.transferBottom_m>=b.canalFloor_m)
 require('transfer clears actual well and receiving floors',b.transferBottom_m>Math.max(b.wellFloor_m,b.canalFloor_m,b.poolFloor_m),b.transferBottom_m-Math.max(b.wellFloor_m,b.canalFloor_m,b.poolFloor_m))
 require('actual active-fuel transfer cover',b.surface_m-transferActiveTop>=b.minimumActiveCover_m,b.surface_m-transferActiveTop)
 require('whole assembly remains immersed in original preparation',b.surface_m>transferTop,b.surface_m-transferTop)
 const seatedRackTop=b.poolFloor_m+fullLength,rackPanelTop=b.poolFloor_m+b.bottomFittingLength_m+active
 require('horizontal transfer clears complete occupied rack FA by at least 0.25m',b.transferBottom_m-seatedRackTop>=.25,b.transferBottom_m-seatedRackTop)
 require('horizontal transfer clears fixed rack panels',b.transferBottom_m>rackPanelTop,b.transferBottom_m-rackPanelTop)
 require('rack descent stays within already required core hoist reach',b.poolFloor_m>=b.seatedBottom_m,b.poolFloor_m-b.seatedBottom_m)
 require('dry loaded hoist force is finite and sufficient',mass_kg*b.gravity_m_s2<b.hoistForce_N,mass_kg*b.gravity_m_s2)
 require('paid nominal lift work fits selected supply',mass_kg*b.gravity_m_s2*b.motionSpeed_m_s<b.hoistPower_W)
 const sourceActiveVolume=Math.PI*st*st*active,
  coreGrossVolume=f.assemblies*pitch*pitch*active,
  activeFAvolume=(rodArea+guideArea)*active,
  coreFree=coreGrossVolume-f.assemblies*activeFAvolume-sourceActiveVolume,
  exteriorCore=f.assemblies*(pitch*pitch-rodArea-f.guidesPerAssembly*Math.PI*go*go)*active,
  boreCore=f.assemblies*f.guidesPerAssembly*Math.PI*gi*gi*active-sourceActiveVolume
 require('external water plus new wet bores equals actual core free volume',Math.abs(exteriorCore+boreCore-coreFree)<1e-12)
 require('original full-core free volume positive',coreFree>0,coreFree)
 // Achieved displacement changes continuously; no restored full-core cell volume.
 const overlap=(a:number,z:number,l:number)=>Math.max(0,Math.min(z+l,a+active)-Math.max(z,a))
 const displaced=(z:number)=>rodArea*(overlap(-2,z+b.bottomFittingLength_m,active+plenum))+
  guideArea*overlap(-2,z,fullLength)+b.bottomFitting_kg/f.cladDensity_kg_m3*overlap(-2,z,b.bottomFittingLength_m)/b.bottomFittingLength_m+
  b.topFitting_kg/f.cladDensity_kg_m3*overlap(-2,z+fullLength-b.topFittingLength_m,b.topFittingLength_m)/b.topFittingLength_m
 const poses=[b.seatedBottom_m,-1,0,1,b.transferBottom_m],volumes=poses.map(z=>coreFree+activeFAvolume-displaced(z))
 require('first removal continuously creates native water space',volumes.every((v,i)=>i===0||v>=volumes[i-1]!-1e-12))
 require('fully raised FA restores its displaced heated volume',Math.abs(volumes.at(-1)!-coreFree-activeFAvolume)<1e-12)
 require('empty-core limit retains stationary source displacement',Math.abs((coreFree+f.assemblies*activeFAvolume)-(coreGrossVolume-sourceActiveVolume))<1e-12)
 require('return to seated pose has no geometry reset',Math.abs(displaced(b.seatedBottom_m)-activeFAvolume)<1e-12)
 // Arbitrary positive ledger vectors test the allocation identity, not a plant history.
 const testLedger=[1,2,3,4,5,6,1e9,2e9,3e9,4e9,5e9,6e9,7e18,8e18,9e18,1e19],shares=slots.map(()=>1/f.assemblies)
 const relativeAllocationDefect=Math.max(...testLedger.map(a=>Math.abs(sum(shares.map(w=>w*a))/a-1)))
 require('each extensive history allocated once not cloned',relativeAllocationDefect<1e-13,relativeAllocationDefect)
 const grossVolumes={well:b.wellArea_m2*(b.surface_m-b.wellFloor_m),canal:b.canalWidth_m*b.canalLength_m*(b.surface_m-b.canalFloor_m),pool:b.poolSide_m**2*(b.surface_m-b.poolFloor_m)}
 require('separate original finite water-space geometry',Object.values(grossVolumes).every(v=>v>0))
 const guideOuterArea=f.assemblies*f.guidesPerAssembly*Math.PI*go*go,
  boreArea=f.assemblies*f.guidesPerAssembly*Math.PI*gi*gi,sourceArea=Math.PI*st*st,
  lowerOuter=guideOuterArea*b.bottomFittingLength_m,
  upperLength=plenum+b.topFittingLength_m,upperOuter=guideOuterArea*upperLength,
  lowerBore=(boreArea-sourceArea)*b.bottomFittingLength_m,
  upperBore=(boreArea-sourceArea)*upperLength,
  lowerSourceOutside=sourceArea*(b.seatedBottom_m-b.sourceThimbleBottom_m),
  upperSourceOutside=sourceArea*(b.sourceThimbleTop_m-assemblyTop),
  lowerExternal=28.5-lowerOuter-f.assemblies*b.bottomFitting_kg/f.cladDensity_kg_m3-lowerSourceOutside,
  upperExternal=33.5-upperOuter-f.assemblies*(b.topFitting_kg/f.cladDensity_kg_m3+rodArea*plenum)-upperSourceOutside
 require('end bore fluid partitions old plenum geometry not duplicated water',lowerExternal>0&&upperExternal>0&&lowerBore>0&&upperBore>0)
 const freshGeometry={guideOuterArea_m2:guideOuterArea,guideInnerArea_m2:boreArea,sourceArea_m2:sourceArea,
  active:{bottom_m:-2,top_m:2,guideOuterDisplacement_m3:guideOuterArea*active,guideWallDisplacement_m3:f.assemblies*guideArea*active,boreVolume_m3:boreCore,thimbleDisplacement_m3:sourceActiveVolume,externalFreeVolume_m3:exteriorCore,totalFreeVolume_m3:coreFree},
  lower:{boreBottom_m:b.seatedBottom_m,boreTop_m:-2,guideOuterDisplacement_m3:lowerOuter,guideWallDisplacement_m3:lowerOuter-lowerBore-sourceArea*b.bottomFittingLength_m,fittingDisplacement_m3:f.assemblies*b.bottomFitting_kg/f.cladDensity_kg_m3,thimbleDisplacement_m3:sourceArea*(-2-b.sourceThimbleBottom_m),thimbleOutsideBore_m3:lowerSourceOutside,externalFreeVolume_m3:lowerExternal,boreVolume_m3:lowerBore,totalFreeVolume_m3:lowerExternal+lowerBore},
  upper:{boreBottom_m:2,boreTop_m:assemblyTop,guideOuterDisplacement_m3:upperOuter,guideWallDisplacement_m3:upperOuter-upperBore-sourceArea*upperLength,fittingDisplacement_m3:f.assemblies*b.topFitting_kg/f.cladDensity_kg_m3,sealedRodPlenumDisplacement_m3:f.assemblies*rodArea*plenum,plenumCladdingDisplacement_m3:f.assemblies*plenumClad_kg/f.cladDensity_kg_m3,thimbleDisplacement_m3:sourceArea*(b.sourceThimbleTop_m-2),thimbleOutsideBore_m3:upperSourceOutside,externalFreeVolume_m3:upperExternal,boreVolume_m3:upperBore,totalFreeVolume_m3:upperExternal+upperBore}}
 return {checks,assemblies:slots.length,slotCornerRadius_m:corner,grossVolumes,freshGeometry,rack:{b10MassFraction:b10Fraction,matrixArealMass_kg_m2:matrixArealMass,matrixThickness_m:matrixThickness,oneSleeveMatrix_kg:matrixMass,oneSleeveSkin_kg:skinMass,totalSleeveDisplacement_m3:b.rackSide**2*sleeveDisplacement,totalB10_kg:b.rackSide**2*matrixMass*b10Fraction,panelCpDiscrepancy,b4cAt290K:b4cCaloric(290,b.b4cMolarMass_kg_mol)},assembly:{fullLength_m:fullLength,fuel_kg,activeClad_kg,plenumClad_kg,guide_kg,fittings_kg,mass_kg,fullDisplacement_m3,assemblyTop_m:assemblyTop,transferTop_m:transferTop,transferActiveTop_m:transferActiveTop,transferActiveCover_m:b.surface_m-transferActiveTop},core:{grossVolume_m3:coreGrossVolume,externalWater_m3:exteriorCore,newBoreWater_m3:boreCore,fullFreeWater_m3:coreFree,emptyFreeWater_m3:coreGrossVolume-sourceActiveVolume,poses_m:poses,oneAssemblyRemovalFreeWater_m3:volumes},relativeAllocationDefect,limits:'Geometry, solid caloric and algebraic equivalent-history allocation only; no neutron, native receiving, reached motion, pressure/head, cooling or operator authority qualification.'}
}
if(import.meta.main){
 const [directory,output]=Bun.argv.slice(2)
 if(!directory||!output)throw Error('Usage: bun reference-design-fuel-handling.ts <reactor directory> <receipt.json>')
 const files=['fuel-construction.md','fuel-handling-and-pool.md'],documents=await Promise.all(files.map(n=>Bun.file(`${directory}/${n}`).text()))
 const input={fuel:parseFuelConstruction(documents[0]!),basis:parseFuelHandling(documents[1]!)},sha=(s:string)=>createHash('sha256').update(s).digest('hex')
 const result=fuelHandlingChecks(input.basis,input.fuel)
 await Bun.write(output,JSON.stringify({calculationSHA256:sha(await Bun.file(import.meta.path).text()),inputSHA256:sha(JSON.stringify(input)),consumed:files.map((name,i)=>({name,sha256:sha(documents[i]!)})),input,result},null,2)+'\n')
 console.log(JSON.stringify({receipt:output,checks:result.checks.length,inputSHA256:sha(JSON.stringify(input))}))
}
