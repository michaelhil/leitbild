// CPU-only attribution. Run during an agreed quiet interval, never concurrently with product timing.
import{compileScenarioDefinition}from'../../src/core/scenarios/compiler.ts'
import{scenarioDefinitionSchema}from'../../src/core/scenarios/definition.ts'
import{processPlantPack}from'../../src/packs/process-plant/pack.ts'
import{electricGridPack}from'../../src/packs/electric-grid/pack.ts'
import{weatherPack}from'../../src/packs/weather/pack.ts'
import{physicalLayoutPack}from'../../src/packs/physical-layout/pack.ts'
import{createDirectRoutingAdapter}from'../../src/routing/direct-adapter.ts'
import scenario from'../../src/scenarios/halden-normal-operation.scenario.json'
import{physicalLayoutDataSchema,draftingLayoutDataSchema,canonicalPhysicalJson}from'../../src/packs/physical-layout/model.ts'
import{validateRetainedPhysicalSource,physicalSceneShapeFacts,physicalSceneShapeHash}from'../../src/packs/physical-layout/source-validation.ts'
import{compilePhysicalScene}from'../../src/packs/physical-layout/native/drafting/compile-scene.ts'
import{copyPhysicalSceneForTransfer}from'../../src/core/packs/scene-transfer.ts'
const run=await compileScenarioDefinition(scenarioDefinitionSchema.parse(scenario),[processPlantPack,electricGridPack,weatherPack,physicalLayoutPack],{routing:createDirectRoutingAdapter()})
const rows=[]
for(const id of['layout:halden-1','layout:halden-campus']){
 const data=draftingLayoutDataSchema.parse(run.initialObjects.find(o=>o.id===id)!.packData),scene=compilePhysicalScene(data.design.id,data)
 for(let round=0;round<6;round++){
  const measure=async(kind:string)=>{Bun.gc(true);const start=performance.now();const digest=kind==='baseline'?Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalPhysicalJson(physicalSceneShapeFacts(scene.objects)))))).map(v=>v.toString(16).padStart(2,'0')).join(''):await physicalSceneShapeHash(scene.objects);if(digest!==data.physicalApplicability.geometryDigest)throw Error('Shape hash changed');return{kind,ms:performance.now()-start}}
  const order=round%2?['candidate','baseline']:['baseline','candidate'],pair=[];for(const kind of order)pair.push(await measure(kind));const row={id,round,pair};rows.push(row);console.log(JSON.stringify(row))
 }
}
if(Bun.argv[2])await Bun.write(Bun.argv[2],JSON.stringify({classification:'controlled CPU hash attribution over identical frozen R4 scenes; alternating order with pre-call GC; no end-to-end latency claim',rows},null,2))
