import{test,expect}from'bun:test'
import scenario from'../src/scenarios/halden-normal-operation.scenario.json'
import{scenarioDefinitionSchema}from'../src/core/scenarios/definition.ts'
import{compileScenarioDefinition}from'../src/core/scenarios/compiler.ts'
import{processPlantPack}from'../src/packs/process-plant/pack.ts'
import{electricGridPack}from'../src/packs/electric-grid/pack.ts'
import{weatherPack}from'../src/packs/weather/pack.ts'
import{physicalLayoutPack}from'../src/packs/physical-layout/pack.ts'
import{createDirectRoutingAdapter}from'../src/routing/direct-adapter.ts'
import{physicalLayoutDataSchema}from'../src/packs/physical-layout/model.ts'
import{physicalSceneShapeHash}from'../src/packs/physical-layout/source-validation.ts'
import{compileRetainedPhysicalSource}from'../src/packs/physical-layout/source-compile.ts'
const run=await compileScenarioDefinition(scenarioDefinitionSchema.parse(scenario),[processPlantPack,electricGridPack,weatherPack,physicalLayoutPack],{routing:createDirectRoutingAdapter()})
const data=()=>physicalLayoutDataSchema.parse(structuredClone(run.initialObjects.find(object=>object.id==='layout:halden-1')!.packData))
test('the once-validated source path preserves current geometry identity and refuses wrong shape or revision',async()=>{
 const value=data(),scene=await compileRetainedPhysicalSource(value);expect(await physicalSceneShapeHash(scene.objects)).toBe(value.physicalApplicability.geometryDigest)
 const wrong=data();wrong.physicalApplicability.geometryDigest='f'.repeat(64);await expect(compileRetainedPhysicalSource(wrong)).rejects.toThrow('retained Design digest mismatch')
 const retired=data();retired.design.revision='pwr-full-unit-20261030-r9';await expect(compileRetainedPhysicalSource(retired)).rejects.toThrow('Unsupported physical Design Revision')
 const malformed=data();malformed.source.elements[0]!.pose.position[0]=NaN;await expect(compileRetainedPhysicalSource(malformed)).rejects.toThrow()
})
