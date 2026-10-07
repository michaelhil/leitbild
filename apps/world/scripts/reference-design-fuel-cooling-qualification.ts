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
/** A native success flag alone cannot credit a truncated or diagnostically
 * incomplete pair. The physical/error policy is owned by the native qualifier. */
export const fuelCoolingAdmission=z.object({kind:z.literal('source-cooling-pair'),passed:z.literal(true),lastAdmittedTime:z.literal(300),
 dimension:z.number().int().positive(),differential:z.number().int().positive(),normal:arm,tighter:arm,
 settings:z.object({accuracyPolicy:z.literal('cold-source-cooling-5'),provisional:z.literal(true),horizon:z.literal(300),
  fuelPowerErrorWeights:z.literal('sparse-current-response-proportional-budget-cap'),fuelPowerResolutionW:z.literal(1e-12),
  barrelPowerErrorWeights:z.literal('sparse-current-bulk-capture-Mn-proportional-budget-cap'),barrelPowerResolutionW:z.literal(1e-12),
  costGuard:z.literal('aggregate-native-and-external-wall-deadlines;accepted-step-count-diagnostic'),
  nonlinearClosure:z.literal('stock-Newton-and-current-physical-network-chart'),
  linearWeightedL2Budget:z.literal(0.0165),algebraicLTE:z.literal('included'),
  solverEnergyCoordinate:z.literal('G=sum-installed-energy-change-independent-fuel-and-barrel-release-plus-barrel-export'),
  energyDefectATOLJ:z.number().finite().positive(),
  referenceAllATOLandRTOLDivisor:z.literal(10),perRowErrorWeights:z.literal('source-carrier-barrel-receipts-relative-consequences;network-thermal-absolute-only;energy-defect-absolute')}),
 gates:z.object({fullPairComparisonEvaluated:z.literal(true),developedThermalResponse:z.literal(true),developedSourceResponse:z.literal(true),
  developedBarrelResponse:z.literal(true),barrelPairRatio:admittedRatio,barrelPowerPairRatio:admittedRatio,
  sourceLocalRatio:admittedRatio,sourceFamilyRatio:admittedRatio,sourceObservableRatio:admittedRatio,sourceNCOperatorRatio:admittedRatio,
  thermalPairRatio:admittedRatio,networkPairRatio:admittedRatio,depositionPairRatio:admittedRatio,carrierPairRatio:admittedRatio}),
 pairedComparisons:z.array(z.unknown()).length(14),fuelTemperatureFeedbackDiagnostic:z.object({})})
 .refine(value=>Math.abs(value.settings.energyDefectATOLJ/(0.01/Math.sqrt(value.dimension))-1)<=4*Number.EPSILON,
  'Energy-defect coordinate must retain its declared normal absolute scale')
export function coolingStateHeader(bytes:Uint8Array){
 if(bytes.length<24)throw Error('Truncated coupled state header')
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),magic=new TextDecoder().decode(bytes.subarray(0,8)),
  coordinates=Number(view.getBigUint64(8,true)),time=view.getFloat64(16,true),width=magic==='LDCOOL01'?16:magic==='LDCCOM01'?8:0
 if(!width||!Number.isSafeInteger(coordinates)||coordinates<=0||!Number.isFinite(time)||time<0
  ||bytes.length!==24+width*coordinates)throw Error('Invalid coupled state frame')
 return {magic,coordinates,time}
}
type Options={wiki:string;partition:string;material:string;water:string;materialEvidence:string;
 binary:string;selectedStackManifest:string;output:string;priorAttempt?:string}
export function fuelCoolingPriorSeconds(value:unknown){
 return z.object({passed:z.literal(false),allowanceSeconds:z.literal(120),elapsedSeconds:z.number().finite().nonnegative().lt(120),
  noWholePlantReadinessCredit:z.literal(true)}).parse(value).elapsedSeconds
}
export async function qualifyFuelCooling(options:Options){
 const began=performance.now(),allowanceSeconds=120,output=resolve(options.output),directory=output+'.artifacts',
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
 const prepared=await compileFuelCooling(resolve(options.wiki)),fixture=nativeFuelCoolingFixture(prepared,source),
  helpers=await sourceHelperFiles([import.meta.path]),
  native=await Array.fromAsync(new Bun.Glob('{src,examples,qualification,tests}/**/*.{rs,cpp,c,h}').scan({cwd:root})),
  paths=[...helpers.keys(),...native.sort().map(p=>join(root,p)),...['Cargo.toml','Cargo.lock','build.rs'].map(p=>join(root,p)),resolve(options.binary)],
  bytes=await Promise.all(paths.map(p=>readFile(p)))
 if(prior&&prior.fixtureSHA256!==sha(fixture))throw Error('Prior attempt did not consume this physical joining payload')
 await mkdir(directory)
 await Promise.all(paths.map((p,i)=>writeFile(join(directory,`${i}-${basename(p)}`),bytes[i]!,{flag:'wx'})))
 await writeFile(join(directory,'input.txt'),fixture,{flag:'wx'})
 await writeFile(join(directory,'composition.json'),JSON.stringify({thermal:prepared.thermal,primary:prepared.primary,barrel:prepared.barrel,
  ownerIdentities:prepared.ownerIdentities,limitations:prepared.limitations},null,2)+'\n',{flag:'wx'})
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
  .filter(name=>name!=='input.txt').map(async name=>{
   const path=join(directory,name),bytes=await readFile(path)
   try{return {path,sha256:sha(bytes),bytes:bytes.length,...coolingStateHeader(bytes)}}
   catch(error){return {path,sha256:sha(bytes),bytes:bytes.length,frameError:String(error)}}
  })),
  parsed=sourceEvolutionOutput(stdout),outcome=parsed.outcome,admission=fuelCoolingAdmission.safeParse(outcome),
  completeStates=admission.success&&states.filter(s=>'magic' in s&&s.magic==='LDCCOM01'&&s.coordinates===outcome.dimension).length===28
   &&states.filter(s=>'magic' in s&&s.path.endsWith('.checkpoint')&&s.magic==='LDCOOL01'&&s.coordinates===outcome.dimension&&s.time===300).length===2
   &&states.every(s=>!s.frameError),
  unchanged=(await Promise.all(paths.map(p=>readFile(p)))).every((b,i)=>b.equals(bytes[i]!))
   &&(await Promise.all(inputs.map(p=>Bun.file(p).text()))).every((s,i)=>s===texts[i])
   &&(await Promise.all(ownerPaths.map(p=>Bun.file(p).text()))).every((s,i)=>s===ownerTexts[i])
   &&(await Promise.all(prepared.ownerIdentities.map(async r=>sha(await Bun.file(join(options.wiki,r.name)).text())===r.sha256))).every(Boolean),
  stackUnchanged=await selectedNativeStackUnchanged(nativeStack),currentAttemptSeconds=(performance.now()-began)/1000,
  elapsedSeconds=priorComputationSeconds+currentAttemptSeconds,
  receipt={recordedAt:new Date().toISOString(),passed:exitCode===0&&!timedOut&&admission.success&&completeStates
    &&unchanged&&stackUnchanged&&elapsedSeconds<=allowanceSeconds,
   allowanceSeconds,elapsedSeconds,currentAttemptSeconds,priorComputationSeconds,priorAttempt:options.priorAttempt?resolve(options.priorAttempt):null,
   preparationSeconds,executionWallSeconds,compilationOutsideAdvancementAllowance:true,command,exitCode,timedOut,
   termination:timedOut?'external-wall-deadline':outcome?'native-final-result':'native-final-result-missing',
   stdout,stderr,processUsageScope:'current native process; prior attempt usage retained separately',
   ...sourceProcessUsage(child.resourceUsage()),...parsed,unchanged,
   admissionError:admission.success?undefined:admission.error.message,
   inputCounts:{bands:prepared.thermal.bands.length,thermalPhysicalStocks:prepared.thermal.thermalCoordinates,
    thermalSolverCoordinates:2*prepared.thermal.thermalCoordinates,primaryCells:prepared.network.water.length,
    primaryProductCoordinates:2*prepared.network.water.length,primarySourceIntersections:prepared.primary.rows.length},
   consumed:[...inputs.map((path,i)=>({path,sha256:sha(texts[i]!)})),...ownerPaths.map((path,i)=>({path,sha256:sha(ownerTexts[i]!)}))],
   sources:paths.map((path,i)=>({path,sha256:sha(bytes[i]!)})),fixtureSHA256:sha(fixture),
   artifacts:{directory,nativeStack,nativeStackUnchanged:stackUnchanged,states,completeStates},noWholePlantReadinessCredit:true,
   limitations:prepared.limitations}
 await writeFile(output,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'})
 return receipt
}
