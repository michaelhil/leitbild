import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import normalOperation from '../src/scenarios/halden-normal-operation.scenario.json'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { scenarioDefinitionSchema } from '../src/core/scenarios/definition.ts'
import { processPlantPack } from '../src/packs/process-plant/pack.ts'
import { electricGridPack } from '../src/packs/electric-grid/pack.ts'
import { weatherPack } from '../src/packs/weather/pack.ts'
import { physicalLayoutPack } from '../src/packs/physical-layout/pack.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { architectureLayoutDataSchema, physicalDesignManifest } from '../src/packs/physical-layout/model.ts'
import { physicalContentHash } from '../src/packs/physical-layout/source-validation.ts'
import { physicalSourceFacts } from '../src/packs/physical-layout/native/architecture/source.ts'
import { physicalApplicabilityContent } from '../src/packs/physical-layout/applicability.ts'
import { loadPhysicalSourceAsset } from '../src/packs/physical-layout/source-loader.ts'
import { loadPhysicalLayoutScene } from '../src/packs/physical-layout/scene.ts'

const scenario = await compileScenarioDefinition(scenarioDefinitionSchema.parse(normalOperation),[processPlantPack,electricGridPack,weatherPack,physicalLayoutPack],{routing:createDirectRoutingAdapter()})
const data = (id: string) => architectureLayoutDataSchema.parse(scenario.initialObjects.find(object=>object.id===id)!.packData)
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
// A distinct, fully admitted Design guarantees the pending test is cold. It
// must not rely on the VM collecting an earlier test's weak cache discovery.
const freshData = async () => {
  const value=data('layout:halden-1')
  value.design.id=value.source.id='source-cache-concurrent-test'
  value.sourceDigest=await physicalContentHash(value.source)
  value.physicalApplicability.sourceDigest=await physicalContentHash(physicalSourceFacts(value.source))
  value.physicalApplicability.digest=await physicalContentHash(physicalApplicabilityContent({...value,modelRequirement:{modelRef:value.owner.modelRef,modelDigest:value.owner.modelDigest}}))
  value.design.digest=await physicalContentHash(physicalDesignManifest(value))
  return architectureLayoutDataSchema.parse(value)
}

test('warm placements preserve the complete intrinsic R3 delivery after only its objects remain retained', async () => {
  const firstData=data('layout:halden-1'),secondData=data('layout:halden-2')
  const retained = await (async () => {
    let first:Awaited<ReturnType<typeof loadPhysicalSourceAsset>>|null=await loadPhysicalSourceAsset(firstData)
    expect(first.planAnnotations!.length).toBeGreaterThan(200)
    const value={objects:first.objects,annotationHash:hash(first.planAnnotations),scopeHash:hash(first.scopes),layerHash:hash(first.layers),inspectionHash:hash(first.objects.map(object=>[object.id,object.inspectionBoundary,object.inspectionLevels]))}
    first=null;return value
  })()
  const placement={...secondData,placement:{...secondData.placement,bearing:90},group:{id:'other-site',label:'Other site'}}
  const warm=await loadPhysicalSourceAsset(placement)
  expect(warm.objects).toBe(retained.objects)
  expect(hash(warm.planAnnotations)).toBe(retained.annotationHash)
  expect(hash(warm.scopes)).toBe(retained.scopeHash)
  expect(hash(warm.layers)).toBe(retained.layerHash)
  expect(hash(warm.objects.map(object=>[object.id,object.inspectionBoundary,object.inspectionLevels]))).toBe(retained.inspectionHash)
  expect(warm.id).toBe(secondData.design.id);expect(warm.revision).toBe(secondData.design.digest)
  expect(warm.targetObjectId).toBe(secondData.owner.objectId);expect(warm.targetObjectId).not.toBe(firstData.owner.objectId)
  expect(warm.anchor).toEqual(secondData.placement.anchor);expect(warm.bearing).toBe(90);expect(warm.group).toEqual(placement.group)
  const secondObject=scenario.initialObjects.find(object=>object.id==='layout:halden-2')!,host=await loadPhysicalLayoutScene({...secondObject,packData:placement})
  expect(host.id).toBe(secondObject.id);expect(host.targetObjectId).toBe(placement.owner.objectId);expect(host.objects).toBe(retained.objects);expect(hash(host.planAnnotations)).toBe(retained.annotationHash)
  const corrupt=structuredClone(placement);corrupt.source.elements[0]!.label='unadmitted edit'
  await expect(loadPhysicalSourceAsset(corrupt)).rejects.toThrow('source/binding digest mismatch')
})

test('cold pending placements share the complete intrinsic delivery and retain distinct headers', async () => {
  const firstData=await freshData(),other=data('layout:halden-2')
  const secondData=architectureLayoutDataSchema.parse({...firstData,owner:other.owner,placement:other.placement,group:other.group,relatedMembers:other.relatedMembers})
  const [first,second]=await Promise.all([loadPhysicalSourceAsset(firstData),loadPhysicalSourceAsset(secondData)])
  expect(first.objects).toBe(second.objects);expect(first.planAnnotations).toBe(second.planAnnotations)
  expect(first.planAnnotations!.length).toBeGreaterThan(200)
  expect(first.targetObjectId).not.toBe(second.targetObjectId);expect(first.anchor).not.toEqual(second.anchor)
  expect(first.scopes).toBe(second.scopes);expect(first.layers).toBe(second.layers)
  expect(first.id).toBe(firstData.design.id);expect(second.revision).toBe(firstData.design.digest)
})
