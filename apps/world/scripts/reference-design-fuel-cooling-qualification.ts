/** One immutable actual-input cold source/cooling pair. Offline only. Compile
 * the selected binary before calling; preparation/inspection/advancement share
 * one allowance, compilation is reported separately by the caller. No retries. */
import {createHash} from 'node:crypto'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {basename,join,resolve} from 'node:path'
import {compileFuelCooling,nativeFuelCoolingFixture} from './reference-design-fuel-cooling'
import {compileSourceEvolution,sourceEvolutionOwnerFiles} from './reference-design-source-evolution'
import {sourceEvolutionOutput,sourceHelperFiles,sourceProcessUsage} from './reference-design-source-evolution-qualification'
import {requireControlledLoaderEnvironment,verifySelectedNativeStack,selectedNativeStackUnchanged} from './reference-design-native-stack'
import {z} from 'zod'
const sha=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex')
const admittedRatio=z.number().finite().nonnegative().max(1),arm=z.object({passed:z.literal(true),lastAdmittedTime:z.literal(300),commonSamples:z.literal(14)})
export const coolingEnergyCoordinates={
 base:'G=sum-installed-energy-change-minus-fission-barrel-fuel-binding-mobile-binding-BODY-guide-release-plus-barrel-fuel-binding-mobile-binding-BODY-guide-ambient-export',
 prhr:'G=sum-installed-energy-change-including-finite-WST-and-ROOM-minus-fission-barrel-fuel-binding-mobile-binding-BODY-guide-release-minus-signed-spring-release-and-electrical-receipts-plus-barrel-fuel-binding-mobile-binding-BODY-guide-ambient-WST-surface-work-connector-and-ROOM-ambient-export',
} as const
export const coolingCarrierComparisonPolicy='closed-mobile-generated-products-separate-H-B;local-remaining-targets;local-product-distribution-diagnostic' as const
export const coolingMobileCapturePolicy='birth-site-primary-H-B;physical-liquid-self;physical-origin-diffuse-serial-clad-barrel-guide-BODY;explicit-unrepresented-wall-boundary' as const
export const coolingMobileDevelopmentPolicy='separate-positive-H-B-paid-and-finite-recipient-power;min-normal-tighter>10-pair-difference+20-existing-resolution' as const
export const coolingAbsorberGuidePolicy='fixed-original-finite-BODY-guide;actual-birth-region-cohort;canonical-products;full-physical-host-photons' as const
export const absorberGuideAdmission=z.object({kind:z.literal('absorber-guide-pair'),passed:z.literal(true),
 policy:z.literal(coolingAbsorberGuidePolicy),hosts:z.number().int().positive(),
 powerLocalRatio:admittedRatio,powerSUMABSRatio:admittedRatio,paidEnergyRatio:admittedRatio,
 developedAllCaptureFamilies:z.literal(true),
 familyOrder:z.tuple([z.literal('BODY-B10'),z.literal('BODY-304-and-Mn'),z.literal('GUIDE-Zr')]),
 normalFamilyPowerW:z.tuple([z.number().finite().positive(),z.number().finite().positive(),z.number().finite().positive()]),
 tighterFamilyPowerW:z.tuple([z.number().finite().positive(),z.number().finite().positive(),z.number().finite().positive()]),
 normalPaidJ:z.number().finite().positive(),tighterPaidJ:z.number().finite().positive(),
 normalExportJ:z.number().finite().nonnegative(),tighterExportJ:z.number().finite().nonnegative(),
 normalFiniteRecipientPowerW:z.number().finite().positive(),tighterFiniteRecipientPowerW:z.number().finite().positive(),
 guideThermalWitness:z.object({host:z.number().int().nonnegative(),normalChangeK:z.number().finite().positive(),
  tighterChangeK:z.number().finite().positive(),resolved:z.literal(true)})})
const energyPair=z.tuple([z.number().finite().nonnegative(),z.number().finite().nonnegative()])
export const mobileCaptureReceipts=z.object({policy:z.literal(coolingMobileCapturePolicy),routeCount:z.number().int().positive(),
 wallOriginCount:z.number().int().positive(),speciesOrder:z.tuple([z.literal('H'),z.literal('B')]),
 channelOrder:z.tuple([z.literal('emitted'),z.literal('charged-liquid'),z.literal('liquid-photon'),z.literal('installed-wall'),
  z.literal('beyond-installed-wall-export'),z.literal('unrepresented-wall-boundary-export')]),
 normalPaidSpeciesJ:energyPair,tighterPaidSpeciesJ:energyPair,normalExclusiveExportsJ:energyPair,tighterExclusiveExportsJ:energyPair,
 normalSpeciesPowerTotalsW:z.array(z.number().finite().nonnegative()).length(12),
 tighterSpeciesPowerTotalsW:z.array(z.number().finite().nonnegative()).length(12),
 normalFiniteRecipientPowerW:z.number().finite().positive(),tighterFiniteRecipientPowerW:z.number().finite().positive()})
/** A native success flag alone cannot credit a truncated or diagnostically
 * incomplete pair. The physical/error policy is owned by the native qualifier. */
export const fuelCoolingAdmission=z.object({kind:z.literal('source-cooling-pair'),passed:z.literal(true),lastAdmittedTime:z.literal(300),
 dimension:z.number().int().positive(),differential:z.number().int().positive(),normal:arm,tighter:arm,
 settings:z.object({accuracyPolicy:z.literal('cold-source-nuclear-heat'),carrierComparisonPolicy:z.literal(coolingCarrierComparisonPolicy),provisional:z.literal(true),horizon:z.literal(300),
  mobileCapturePolicy:z.literal(coolingMobileCapturePolicy),
  mobileCaptureDevelopmentPolicy:z.literal(coolingMobileDevelopmentPolicy),
  carrierCoordinates:z.literal('hydrogen-product,direct-boron10,boron-product'),
  pressureCoordinates:z.literal('finite-pool-cushion-and-surge-forward-DAE;direct-liquid-B10-and-phase-H-products'),
  pressureResponseResolutionPa:z.literal(1),pressureChangeRelativeBudget:z.literal(0.005),
  surgeHydraulicModel:z.literal('finite-storage-two-algebraic-resistances'),
  surgeGravityModel:z.literal('owned-bulk-density-hydrostatic-face-heads'),
  surgeReductionScope:z.literal('sound-filtered-slow-support;no-inertial-waveform-credit'),
  surgeFlowResolutionKgS:z.literal(1e-5),
  pressureChartHeightScope:z.literal('hydrostatic-equivalent-1Pa;P-T-coupled-correction-and-metal-caloric-admitted'),
  fuelPowerErrorWeights:z.literal('sparse-current-response-proportional-budget-cap'),fuelPowerResolutionW:z.literal(1e-12),
  barrelPowerErrorWeights:z.literal('sparse-current-bulk-capture-Mn-proportional-budget-cap'),barrelPowerResolutionW:z.literal(1e-12),
  capturePowerErrorWeights:z.literal('sparse-current-fuel-capture-and-temperature-proportional-budget-cap'),capturePowerResolutionW:z.literal(1e-12),
  capturePowerWeightScope:z.literal('emitted-per-intersection;held-route-fractions-at-most-one;all-five-recipient-channels-independently-paired'),
  costGuard:z.literal('aggregate-native-and-external-wall-deadlines;accepted-step-count-diagnostic'),
  nonlinearClosure:z.literal('stock-Newton-and-current-physical-network-pressure-charts'),
  linearWeightedL2Budget:z.literal(0.0165),
  algebraicLTE:z.literal('excluded-from-temporal-control;retained-in-Newton-physical-closure-and-output-pair'),
  solverEnergyCoordinate:z.enum([coolingEnergyCoordinates.base,coolingEnergyCoordinates.prhr]),
  energyDefectATOLJ:z.number().finite().positive(),
  referenceAllATOLandRTOLDivisor:z.literal(10),perRowErrorWeights:z.literal('source-carrier-barrel-binding-receipts-relative-consequences;network-thermal-absolute-only;energy-defect-absolute')}),
 gates:z.object({fullPairComparisonEvaluated:z.literal(true),developedThermalResponse:z.literal(true),developedSourceResponse:z.literal(true),
  developedMobileCaptureResponse:z.literal(true),
  developedBarrelResponse:z.literal(true),barrelPairRatio:admittedRatio,barrelPowerPairRatio:admittedRatio,
  capturePowerLocalRatio:admittedRatio,capturePowerSUMABSRatio:admittedRatio,capturePaidEnergyRatio:admittedRatio,
  mobileCapturePowerLocalRatio:admittedRatio,mobileCapturePowerSUMABSRatio:admittedRatio,mobileCapturePaidEnergyRatio:admittedRatio,
  developedPressureResponse:z.literal(true),pressurePairRatio:admittedRatio,pressureMaterialPairRatio:admittedRatio,
  pressureChartRatio:admittedRatio,pressureFlowClosureRatio:admittedRatio,
  sourceLocalRatio:admittedRatio,sourceFamilyRatio:admittedRatio,sourceObservableRatio:admittedRatio,sourceNCOperatorRatio:admittedRatio,
  thermalPairRatio:admittedRatio,networkPairRatio:admittedRatio,depositionPairRatio:admittedRatio,carrierPairRatio:admittedRatio}),
 pairedComparisons:z.array(z.unknown()).length(14),fuelTemperatureFeedbackDiagnostic:z.object({}),mobileCaptureReceipts})
 .refine(value=>Math.abs(value.settings.energyDefectATOLJ/(0.01/Math.sqrt(value.dimension))-1)<=4*Number.EPSILON,
  'Energy-defect coordinate must retain its declared normal absolute scale')
export function coolingStateHeader(bytes:Uint8Array){
 if(bytes.length<24)throw Error('Truncated coupled state header')
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),magic=new TextDecoder().decode(bytes.subarray(0,8)),
  coordinates=Number(view.getBigUint64(8,true)),time=view.getFloat64(16,true),width=magic==='LDPTST01'?16:magic==='LDPTCM01'?8:0
 if(!width||!Number.isSafeInteger(coordinates)||coordinates<=0||!Number.isFinite(time)||time<0
  ||bytes.length!==24+width*coordinates)throw Error('Invalid coupled state frame')
 return {magic,coordinates,time}
}
/** Retention is independent of the physical/accuracy verdict. A failed pair
 * can still leave every requested state available for a no-rerun diagnosis. */
// Wire schedule of qualification/cooling_accuracy.rs::OUTPUTS, not a solver
// step cap. State filenames carry the corresponding zero-based output index.
export const coolingCommonTimes=[.001,.01,.1,1,2,5,10,20,30,60,120,180,240,300] as const
export function coolingStatesComplete(states:readonly {path:string;magic?:string;coordinates?:number;time?:number;frameError?:string}[],coordinates:unknown){
 if(!Number.isSafeInteger(coordinates)||Number(coordinates)<=0||states.length!==2*(coolingCommonTimes.length+1)
  ||new Set(states.map(s=>s.path)).size!==states.length
  ||states.some(s=>s.frameError||s.coordinates!==coordinates))return false
 return ['normal','tighter'].every(arm=>coolingCommonTimes.every((time,index)=>states.some(s=>s.path.endsWith(`input.${arm}.common-${index}.bin`)
   &&s.magic==='LDPTCM01'&&s.time===time))
   &&states.filter(s=>s.path.endsWith(`input.${arm}.checkpoint`)&&s.magic==='LDPTST01'&&s.time===300).length===1
 )
}
type Options={wiki:string;partition:string;material:string;water:string;materialEvidence:string;
 binary:string;selectedStackManifest:string;output:string;priorAttempt?:string;features?:{prhr:boolean}}
export function fuelCoolingPriorSeconds(value:unknown){
 return z.object({passed:z.literal(false),allowanceSeconds:z.literal(180),elapsedSeconds:z.number().finite().nonnegative().lt(180),
  noWholePlantReadinessCredit:z.literal(true)}).parse(value).elapsedSeconds
}
export async function qualifyFuelCooling(options:Options){
 const began=performance.now(),allowanceSeconds=180,output=resolve(options.output),directory=output+'.artifacts',
  root=resolve(import.meta.dir,'../native/process-plant')
 if(await Bun.file(output).exists()||await Bun.file(join(directory,'input.txt')).exists())throw Error('Refusing to overwrite cold coupling evidence')
 requireControlledLoaderEnvironment(process.env)
 const inputs=[options.partition,options.material,options.water,options.materialEvidence,
  options.materialEvidence+'.artifacts/material.json',options.selectedStackManifest,...(options.priorAttempt?[options.priorAttempt]:[])].map(p=>resolve(p)),
  texts=await Promise.all(inputs.map(p=>Bun.file(p).text())),parent=JSON.parse(texts[3]!),payload=JSON.parse(texts[4]!),
  selected=JSON.parse(texts[5]!)
 const prior=options.priorAttempt?JSON.parse(texts[6]!):undefined,priorComputationSeconds=prior?fuelCoolingPriorSeconds(prior):0
 if(parent.passed!==true||parent.artifacts?.directory!==resolve(options.materialEvidence)+'.artifacts')throw Error('Unadmitted receiving property parent')
 if(!parent.consumed?.some((r:{path:string;sha256:string})=>r.path===inputs[2]&&r.sha256===sha(texts[2]!)))throw Error('Wrong original primary parent')
 if(!selected?.idaLibrary||!selected?.prefix||!Array.isArray(selected.inputs))throw Error('Explicit previously inspected native stack required')
 if(!(await Promise.all(selected.inputs.map(async (r:{path:string;sha256:string})=>sha(await readFile(r.path))===r.sha256))).every(Boolean))
  throw Error('Previously selected native inputs changed')
 const propertyPath=join(parent.artifacts.directory,'receiving-output.ndjson'),propertyText=await Bun.file(propertyPath).text()
 if(propertyText.trim().split('\n').length!==1||JSON.stringify(JSON.parse(propertyText))!==JSON.stringify(payload.receiving.property))
  throw Error('Native receiving property differs from retained preparation')
 inputs.push(propertyPath);texts.push(propertyText)
 const ownerPaths=sourceEvolutionOwnerFiles.map(p=>join(resolve(options.wiki),p)),
  ownerTexts=await Promise.all(ownerPaths.map(p=>Bun.file(p).text())),
  source=compileSourceEvolution(texts[0]!,texts[1]!,texts[2]!,new Map(sourceEvolutionOwnerFiles.map((p,i)=>[p,ownerTexts[i]!])),payload.receiving.property)
 if(sha(source.material.fixture)!==parent.fixtureSHA256)throw Error('Recompiled material differs from admitted parent')
 const prepared=await compileFuelCooling(resolve(options.wiki),options.features??{prhr:false}),fixture=nativeFuelCoolingFixture(prepared,source),
  helpers=await sourceHelperFiles([import.meta.path]),
  native=await Array.fromAsync(new Bun.Glob('{src,examples,qualification,tests}/**/*.{rs,cpp,c,h}').scan({cwd:root})),
  paths=[...helpers.keys(),...native.sort().map(p=>join(root,p)),...['Cargo.toml','Cargo.lock','build.rs'].map(p=>join(root,p)),resolve(options.binary)],
  bytes=await Promise.all(paths.map(p=>readFile(p)))
 if(prior&&prior.fixtureSHA256!==sha(fixture))throw Error('Prior attempt did not consume this physical joining payload')
 await mkdir(directory)
 await Promise.all(paths.map((p,i)=>writeFile(join(directory,`${i}-${basename(p)}`),bytes[i]!,{flag:'wx'})))
 await writeFile(join(directory,'input.txt'),fixture,{flag:'wx'})
 await writeFile(join(directory,'composition.json'),JSON.stringify({conditioning:prepared.conditioning,thermal:prepared.thermal,primary:prepared.primary,barrel:prepared.barrel,capture:prepared.capture,mobileCapture:prepared.mobileCapture,absorberGuide:prepared.absorberGuide,pressure:prepared.pressure,
  prhr:prepared.prhr,ownerIdentities:prepared.ownerIdentities,limitations:prepared.limitations},null,2)+'\n',{flag:'wx'})
 // All linked non-system libraries must be retained; the old receipt is not a
 // substitute for inspecting this newly built binary and its actual links.
 const nativeStack=await verifySelectedNativeStack({binary:resolve(options.binary),prefix:selected.prefix,
  idaLibrary:selected.idaLibrary,artifacts:selected.inputs.map((r:{path:string})=>r.path),directory:join(directory,'native-stack')})
 const remaining=allowanceSeconds-priorComputationSeconds-(performance.now()-began)/1000
 const preparationSeconds=(performance.now()-began)/1000
 if(remaining<=2)throw Error('Cold coupling preparation exhausted its numerical allowance')
 const command=[resolve(options.binary),join(directory,'input.txt'),String(remaining)],child=Bun.spawn(command,{stdout:'pipe',stderr:'pipe'})
 let timedOut=false
 const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL')},remaining*1000)
 const [stdout,stderr,exitCode]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]).finally(()=>clearTimeout(timer))
 const executionWallSeconds=(performance.now()-began)/1000-preparationSeconds
 const states=await Promise.all((await Array.fromAsync(new Bun.Glob('input.*').scan({cwd:directory}))).sort()
  .filter(name=>name!=='input.txt'&&!name.endsWith('.pressure-evidence.json')).map(async name=>{
   const path=join(directory,name),bytes=await readFile(path)
   try{return {path,sha256:sha(bytes),bytes:bytes.length,...coolingStateHeader(bytes)}}
   catch(error){return {path,sha256:sha(bytes),bytes:bytes.length,frameError:String(error)}}
  })),
  parsed=sourceEvolutionOutput(stdout),outcome=parsed.outcome,admission=fuelCoolingAdmission.safeParse(outcome),
  selectedEnergyCoordinate=outcome?.settings?.solverEnergyCoordinate===coolingEnergyCoordinates[prepared.prhr?'prhr':'base'],
  pressureEvidence=[...parsed.records].reverse().find(row=>row?.kind==='pressure-evidence-pair')?.report,
  prhrEvidence=[...parsed.records].reverse().find(row=>row?.kind==='prhr-connected-receiver'),
  bundleRecords=parsed.records.filter(row=>row?.kind==='absorber-guide-pair'),
  bundleAdmission=absorberGuideAdmission.safeParse(bundleRecords.length===1?bundleRecords[0]:undefined),
  bundleAdmitted=bundleAdmission.success&&bundleAdmission.data.hosts===prepared.absorberGuide.hosts.length
   &&bundleAdmission.data.guideThermalWitness.host<prepared.absorberGuide.hosts.length
   &&prepared.absorberGuide.hosts[bundleAdmission.data.guideThermalWitness.host]!.kind==='guide',
  observations=await Promise.all(['normal','tighter'].map(async arm=>{
   const path=join(directory,`input.${arm}.pressure-evidence.json`)
   if(!await Bun.file(path).exists())return {path,missing:true}
   const bytes=await readFile(path);return {path,sha256:sha(bytes),bytes:bytes.length}
  })),
  completeStates=coolingStatesComplete(states,outcome?.dimension),
  unchanged=(await Promise.all(paths.map(p=>readFile(p)))).every((b,i)=>b.equals(bytes[i]!))
   &&(await Promise.all(inputs.map(p=>Bun.file(p).text()))).every((s,i)=>s===texts[i])
   &&(await Promise.all(ownerPaths.map(p=>Bun.file(p).text()))).every((s,i)=>s===ownerTexts[i])
   &&(await Promise.all(prepared.ownerIdentities.map(async r=>sha(await Bun.file(join(options.wiki,r.name)).text())===r.sha256))).every(Boolean),
  stackUnchanged=await selectedNativeStackUnchanged(nativeStack),currentAttemptSeconds=(performance.now()-began)/1000,
  elapsedSeconds=priorComputationSeconds+currentAttemptSeconds,
  receipt={recordedAt:new Date().toISOString(),passed:exitCode===0&&!timedOut&&admission.success&&bundleAdmitted&&selectedEnergyCoordinate&&completeStates
    &&pressureEvidence?.passed===true&&observations.every(r=>!('missing' in r))
    &&(!prepared.prhr||prhrEvidence?.passed===true)
    &&unchanged&&stackUnchanged&&elapsedSeconds<=allowanceSeconds,
   allowanceSeconds,elapsedSeconds,currentAttemptSeconds,priorComputationSeconds,priorAttempt:options.priorAttempt?resolve(options.priorAttempt):null,
   preparationSeconds,executionWallSeconds,compilationOutsideAdvancementAllowance:true,command,exitCode,timedOut,
   termination:timedOut?'external-wall-deadline':outcome?'native-final-result':'native-final-result-missing',
   stdout,stderr,processUsageScope:'current native process; prior attempt usage retained separately',
   ...sourceProcessUsage(child.resourceUsage()),...parsed,unchanged,pressureEvidence,prhrEvidence,selectedEnergyCoordinate,
   absorberGuideEvidence:bundleRecords[0],absorberGuideAdmitted:bundleAdmitted,
   admissionError:!admission.success?admission.error.message:!bundleAdmitted?'Missing, failed or mismatched finite BODY/guide pair receipt':!selectedEnergyCoordinate?'Native energy coordinate does not match the selected physical composition':undefined,
   inputCounts:{bands:prepared.thermal.bands.length,thermalPhysicalStocks:prepared.thermal.thermalCoordinates,
    thermalSolverCoordinates:2*prepared.thermal.thermalCoordinates,primaryCells:prepared.network.water.length,
    primaryCarrierCoordinates:3*prepared.network.water.length,primarySourceIntersections:prepared.primary.rows.length,
    pressureCoordinates:45,pressurizerMetalStocks:prepared.pressure.metals.length,
    captureBands:prepared.capture.bands.length,captureExportCoordinates:1,
    mobileCaptureBirthRoutes:prepared.mobileCapture.routes.length,mobileCaptureWallOrigins:prepared.mobileCapture.wall_origins.length,
    mobileCaptureExportCoordinates:2,mobileCapturePaidEnergy:'existing-complete-closed-H-B-products-no-extra-emitted-integral',
    absorberGuideHosts:prepared.absorberGuide.hosts.length,absorberGuideThermalCoordinates:2*prepared.absorberGuide.hosts.length,
    captureEventKinds:['fertile','xenon','samarium'],capturePaidEnergy:'Q-times-existing-gross-progress-no-extra-emitted-integral'},
   consumed:[...inputs.map((path,i)=>({path,sha256:sha(texts[i]!)})),...ownerPaths.map((path,i)=>({path,sha256:sha(ownerTexts[i]!)}))],
   sources:paths.map((path,i)=>({path,sha256:sha(bytes[i]!)})),fixtureSHA256:sha(fixture),
   artifacts:{directory,nativeStack,nativeStackUnchanged:stackUnchanged,states,completeStates,observations},noWholePlantReadinessCredit:true,
   limitations:prepared.limitations}
 await writeFile(output,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'})
 return receipt
}
