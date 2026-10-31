import{test,expect}from'bun:test'
import type{PackPhysicalScene}from'../src/core/packs/scene.ts'
import{physicalContentHash,physicalSceneShapeFacts,physicalSceneShapeHash}from'../src/packs/physical-layout/source-validation.ts'
import{canonicalPhysicalJson}from'../src/packs/physical-layout/model.ts'
import{physicalShapeFacts}from'../src/packs/physical-layout/applicability.ts'
const object=(positions:PackPhysicalScene['objects'][number]['positions'],indices?:PackPhysicalScene['objects'][number]['indices']):PackPhysicalScene['objects'][number]=>({id:'part/"α🙂',label:'Physical body',kind:'equipment',levelId:'L1',subjectIds:['subject'],positions,...(indices?{indices}:{}),inspectionBoundary:{outward:[0,1,0]},planDisplay:'projection'})
test('specialized shape hashing preserves the exact frozen canonical contract for typed/indexed and plain geometry',async()=>{
 const inputs:PackPhysicalScene['objects'][]=[[],[object([0,-0,1e-7,.0000005,-.0000005,1e25,-1e-25,1.234567891,-5.000000001])],[object(new Float64Array([0,0,0,2,0,0,2,2,0,0,2,0]),new Uint32Array([2,0,3,0,1,2]))],[object([0,0,0,1,0,0,0,1,0]),{...object(new Float64Array([3,0,0,4,0,0,3,1,0])) ,id:'second'}]]
 for(const objects of inputs){const legacy=physicalSceneShapeFacts(objects);expect(await physicalSceneShapeHash(objects)).toBe(await physicalContentHash(legacy));const reference=physicalShapeFacts(objects.map(o=>({id:o.id,kind:o.kind,levelId:o.levelId,positions:o.indices?Array.from(o.indices).flatMap(i=>[o.positions[i*3]!,o.positions[i*3+1]!,o.positions[i*3+2]!]):Array.from(o.positions)})));expect(canonicalPhysicalJson(legacy)).toBe(canonicalPhysicalJson(reference))}
 const a=[object([0,0,0,1,0,0,0,1,0,2,2,0],[0,1,2])],b=[{...a[0]!,indices:[0,1,3]}];expect(await physicalSceneShapeHash(a)).not.toBe(await physicalSceneShapeHash(b));expect(await physicalSceneShapeHash([{...a[0]!,label:'Presentation edit',inspectionBoundary:{outward:[1,0,0]}}])).toBe(await physicalSceneShapeHash(a))
})
