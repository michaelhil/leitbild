import{test,expect}from'bun:test'
import{createHash}from'node:crypto'
import{createPwrDraftingUnitArtifacts,createPwrDraftingCampusArtifacts}from'../src/packs/physical-layout/authoring/pwr-drafting.ts'
import{physicalSourceFacts,parameters}from'../src/packs/physical-layout/native/drafting/source.ts'
import{canonicalPhysicalJson,draftingLayoutDataSchema}from'../src/packs/physical-layout/model.ts'
import{physicalSourceDependencyFailure}from'../src/packs/physical-layout/source-dependencies.ts'
import{physicalLayoutDependencyFailure}from'../src/packs/physical-layout/dependencies.ts'
import scenario from'../src/scenarios/halden-normal-operation.scenario.json'
import{scenarioDefinitionSchema}from'../src/core/scenarios/definition.ts'
import{compileScenarioDefinition}from'../src/core/scenarios/compiler.ts'
import{processPlantPack}from'../src/packs/process-plant/pack.ts'
import{electricGridPack}from'../src/packs/electric-grid/pack.ts'
import{weatherPack}from'../src/packs/weather/pack.ts'
import{physicalLayoutPack}from'../src/packs/physical-layout/pack.ts'
import{createDirectRoutingAdapter}from'../src/routing/direct-adapter.ts'
const hash=(value:unknown)=>createHash('sha256').update(canonicalPhysicalJson(value)).digest('hex')
test('unit-only physical edits cannot silently repin campus geometry derived from the previous source',()=>{
 const unit=createPwrDraftingUnitArtifacts(),campus=createPwrDraftingCampusArtifacts(),witnesses=campus.source.sourceDependencies!,current=witnesses.map(witness=>({role:witness.role,sourceId:unit.source.id,physicalSourceDigest:hash(physicalSourceFacts(unit.source)),physicalShapeDigest:witness.physicalShapeDigest}))
 expect(physicalSourceDependencyFailure(witnesses,current)).toBeNull()
 expect(physicalSourceDependencyFailure([],current)).toContain('no authored source/shape witness')
 const generator=unit.source.elements.find(element=>element.id==='tg-generator')!,old=parameters(unit.source,generator);generator.override={length:old.length+1}
 const changed=current.map(member=>({...member,physicalSourceDigest:hash(physicalSourceFacts(unit.source))}))
 expect(physicalSourceDependencyFailure(witnesses,changed)).toContain('re-author')
 expect(physicalSourceDependencyFailure(witnesses,current.map(member=>({...member,physicalShapeDigest:'d'.repeat(64)})))).toContain('compiled shape')
 const presentation=createPwrDraftingUnitArtifacts();presentation.source.planIntent!.dimensionUnit='m'
 expect(physicalSourceDependencyFailure(witnesses,current.map(member=>({...member,physicalSourceDigest:hash(physicalSourceFacts(presentation.source))})))).toBeNull()
},30_000)
test('runtime refuses a stale source witness even when a caller repins the campus physical dependency to match a new unit',async()=>{
 const result=await compileScenarioDefinition(scenarioDefinitionSchema.parse(scenario),[processPlantPack,electricGridPack,weatherPack,physicalLayoutPack],{routing:createDirectRoutingAdapter()}),layouts=result.initialObjects.filter(object=>object.packId==='physical-layout').map(object=>({object,data:draftingLayoutDataSchema.parse(structuredClone(object.packData))})),campus=layouts.find(layout=>layout.data.design.id==='pwr-campus')!,member=campus.data.relatedMembers[0]!,unit=layouts.find(layout=>layout.data.owner.objectId===member.objectId)!
 expect(physicalLayoutDependencyFailure(campus.data,layouts)).toBeNull()
 unit.data.physicalApplicability.sourceDigest='f'.repeat(64);unit.data.physicalApplicability.digest='e'.repeat(64);member.physicalLayout!.physical.digest=unit.data.physicalApplicability.digest
 expect(physicalLayoutDependencyFailure(campus.data,layouts)).toContain('Derived physical source dependency mismatch')
 unit.data.physicalApplicability.sourceDigest=campus.data.source.sourceDependencies![0]!.physicalSourceDigest;unit.data.physicalApplicability.geometryDigest='d'.repeat(64)
 expect(physicalLayoutDependencyFailure(campus.data,layouts)).toContain('compiled shape')
 campus.data.source.sourceDependencies![0]!.sourceId='another-source'
 expect(draftingLayoutDataSchema.safeParse(campus.data).success).toBe(false)
},30_000)
