import{test,expect}from'bun:test'
import scenario from'../src/scenarios/halden-normal-operation.scenario.json'
import{scenarioDefinitionSchema}from'../src/core/scenarios/definition.ts'
import{compileScenarioDefinition}from'../src/core/scenarios/compiler.ts'
import{processPlantPack}from'../src/packs/process-plant/pack.ts'
import{electricGridPack}from'../src/packs/electric-grid/pack.ts'
import{weatherPack}from'../src/packs/weather/pack.ts'
import{physicalLayoutPack}from'../src/packs/physical-layout/pack.ts'
import{createDirectRoutingAdapter}from'../src/routing/direct-adapter.ts'
import{draftingLayoutDataSchema,physicalDesignManifest}from'../src/packs/physical-layout/model.ts'
import{physicalContentHash,physicalSceneShapeHash}from'../src/packs/physical-layout/source-validation.ts'
import{physicalApplicabilityContent}from'../src/packs/physical-layout/applicability.ts'
import{compileRetainedPhysicalSource}from'../src/packs/physical-layout/source-compile.ts'
const run=await compileScenarioDefinition(scenarioDefinitionSchema.parse(scenario),[processPlantPack,electricGridPack,weatherPack,physicalLayoutPack],{routing:createDirectRoutingAdapter()})
const data=()=>draftingLayoutDataSchema.parse(structuredClone(run.initialObjects.find(object=>object.id==='layout:halden-1')!.packData))
test('the once-validated source path preserves actual R4 geometry identity and refuses a wrong admitted shape',async()=>{
 const value=data(),scene=await compileRetainedPhysicalSource(value);expect(await physicalSceneShapeHash(scene.objects)).toBe(value.physicalApplicability.geometryDigest)
 const wrong=data();wrong.physicalApplicability.geometryDigest='f'.repeat(64);wrong.physicalApplicability.digest=await physicalContentHash(physicalApplicabilityContent({...wrong,modelRequirement:{modelRef:wrong.owner.modelRef,modelDigest:wrong.owner.modelDigest}}));wrong.design.digest=await physicalContentHash(physicalDesignManifest(wrong));await expect(compileRetainedPhysicalSource(wrong)).rejects.toThrow('shape recipe differs')
 const malformed=data();malformed.source.elements[0]!.pose.position[0]=NaN;await expect(compileRetainedPhysicalSource(malformed)).rejects.toThrow()
})
