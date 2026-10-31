import { createHash } from 'node:crypto'
import normalOperation from '../../src/scenarios/halden-normal-operation.scenario.json'
import { compileScenarioDefinition } from '../../src/core/scenarios/compiler.ts'
import { scenarioDefinitionSchema } from '../../src/core/scenarios/definition.ts'
import type { PackPhysicalScene } from '../../src/core/packs/scene.ts'
import { processPlantPack } from '../../src/packs/process-plant/pack.ts'
import { electricGridPack } from '../../src/packs/electric-grid/pack.ts'
import { weatherPack } from '../../src/packs/weather/pack.ts'
import { physicalLayoutPack } from '../../src/packs/physical-layout/pack.ts'
import { createDirectRoutingAdapter } from '../../src/routing/direct-adapter.ts'
import { architectureLayoutDataSchema } from '../../src/packs/physical-layout/model.ts'
import { loadPhysicalSourceAsset } from '../../src/packs/physical-layout/source-loader.ts'

// Run as one fresh Bun process, not as a bun:test collection assertion. Each
// phase ends its async stack before the next host task. These are lifecycle
// transitions, not retries or a time-based wait for the collector to cooperate.
const scenario=await compileScenarioDefinition(scenarioDefinitionSchema.parse(normalOperation),[processPlantPack,electricGridPack,weatherPack,physicalLayoutPack],{routing:createDirectRoutingAdapter()})
const data=(id:string)=>architectureLayoutDataSchema.parse(scenario.initialObjects.find(object=>object.id===id)!.packData)
const firstData=data('layout:halden-1'),secondData=data('layout:halden-2')
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const sourceHashes=Object.fromEntries(await Promise.all(['source-loader.ts','source-compile.ts','source-validation.ts'].map(async name=>[name,createHash('sha256').update(new Uint8Array(await Bun.file(new URL(`../../src/packs/physical-layout/${name}`,import.meta.url)).arrayBuffer())).digest('hex')])))
let carrier:PackPhysicalScene['objects']|undefined
let firstWrapper:WeakRef<PackPhysicalScene>,warmWrapper:WeakRef<PackPhysicalScene>,objects:WeakRef<PackPhysicalScene['objects']>
let expected:{annotations:string;scopes:string;layers:string;inspection:string}
const result:Record<string,unknown>={at:new Date().toISOString(),bun:Bun.version,commit:Bun.spawnSync(['git','rev-parse','HEAD']).stdout.toString().trim(),sourceHashes,design:firstData.design,compiler:firstData.compiler,phases:[]}
const phases=result.phases as unknown[]
const fail=(error:unknown):never=>{console.error(error);process.exit(1)}
const same=(actual:unknown,expected:unknown,label:string):void=>{if(actual!==expected)throw new Error(`Source cache witness failed: ${label}`)}

const acquireFirst=async ():Promise<void>=>{
  let scene:PackPhysicalScene|null=await loadPhysicalSourceAsset(firstData)
  if((scene.planAnnotations?.length??0)<=200)throw new Error('R3 source annotation fixture is missing')
  carrier=scene.objects;firstWrapper=new WeakRef(scene);objects=new WeakRef(scene.objects)
  expected={annotations:hash(scene.planAnnotations),scopes:hash(scene.scopes),layers:hash(scene.layers),inspection:hash(scene.objects.map(object=>[object.id,object.inspectionBoundary,object.inspectionLevels]))}
  phases.push({phase:'first-delivery',annotationCount:scene.planAnnotations!.length,objectCount:scene.objects.length,hashes:expected})
  scene=null
}
const acquireWarm=async ():Promise<void>=>{
  Bun.gc(true)
  const firstWrapperCollected=firstWrapper.deref()===undefined
  let scene:PackPhysicalScene|null=await loadPhysicalSourceAsset(secondData)
  same(scene.objects,carrier,'warm objects identity');same(hash(scene.planAnnotations),expected.annotations,'warm annotations')
  same(hash(scene.scopes),expected.scopes,'warm scopes');same(hash(scene.layers),expected.layers,'warm layers')
  same(hash(scene.objects.map(object=>[object.id,object.inspectionBoundary,object.inspectionLevels])),expected.inspection,'warm inspection metadata')
  same(scene.targetObjectId,secondData.owner.objectId,'rebound owner');same(scene.anchor,secondData.placement.anchor,'rebound anchor')
  warmWrapper=new WeakRef(scene)
  phases.push({phase:'objects-carrier-only-warm-delivery',firstWrapperCollected,sharedObjects:true,metadataPreserved:true,headersRebound:true})
  scene=null;carrier=undefined
}
const finish=():void=>{
  Bun.gc(true)
  const firstWrapperCollected=firstWrapper.deref()===undefined,warmWrapperCollected=warmWrapper.deref()===undefined,objectsCollected=objects.deref()===undefined
  phases.push({phase:'last-carrier-released',firstWrapperCollected,warmWrapperCollected,objectsCollected,memory:process.memoryUsage()})
  result.observedCollection=firstWrapperCollected&&warmWrapperCollected&&objectsCollected
  result.limits=['One isolated process and one collection request per lifecycle transition; no retry or wait-until-collected loop.','Collection observations are empirical VM behavior, not an ECMAScript guarantee or a normal unit-test gate.','No browser GPU resource or worker lifecycle is measured by this source-cache witness.']
  console.log(JSON.stringify(result,null,2))
}
// A terminal handler carries only Promise<void>; it cannot retain a delivered
// scene as a fulfilled promise result across these independent host tasks.
void acquireFirst().then(()=>{setTimeout(()=>{void acquireWarm().then(()=>{setTimeout(finish,0)},fail)},0)},fail)
