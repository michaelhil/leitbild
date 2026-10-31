import { describe, expect, test } from 'bun:test'
import base from '../src/packs/physical-layout/pwr-full-unit.source.json'
import bindings from '../src/packs/physical-layout/pwr-full-unit.bindings.json'
import { physicalSourceSchema } from '../src/packs/physical-layout/native/explorer/source.ts'
import { compilePhysicalObjects, compilePhysicalScene, physicalObjectsBounds } from '../src/packs/physical-layout/native/explorer/compile-scene.ts'
import { solid } from '../src/packs/physical-layout/native/explorer/solid.ts'
import retainedTurbine from '../src/packs/physical-layout/pwr-turbine-island.source.json'
import { physicalSourceSchema as retainedSchema } from '../src/packs/physical-layout/native/source.ts'
import { solid as retainedSolid } from '../src/packs/physical-layout/native/solid.ts'

const source = physicalSourceSchema.parse({ ...base, rootScope: { id: 'unit', label: 'PWR unit', kind: 'unit' } })
const objects = compilePhysicalObjects({ source, bindings })
const byId = new Map(objects.map(object => [object.id,object]))
const roles = (id:string) => new Set(Array.from(byId.get(id)!.materialIndices!,index=>byId.get(id)!.materials![index]))

describe('Explicit explorer machinery and architectural features',()=>{
  test('the original turbine and motor assembly parts keep distinct semantic materials',()=>{
    expect([...roles('tg-hp')].sort()).toEqual(['dark','hood','light','machine','plinth'])
    expect(roles('tg-generator').has('motor')).toBe(true)
    expect(roles('tg-generator').has('light')).toBe(true)
    expect(roles('cp-a').has('machine')).toBe(true)
    expect(roles('cp-a').has('motor')).toBe(true)
    expect(byId.get('tg-generator')!.featureLines![0]!.positions.length/6).toBe(706)
  })
  test('floor-cell triangulation has no authored or inferred illustration edge policy',()=>{
    for(const object of objects.filter(object=>object.kind==='slab')){
      expect(object.edgePolicy).toBe('none')
      expect(object.featureLines).toBeUndefined()
      expect(object.planLines).toBeUndefined()
    }
  })
  test('the LP plinth retains its open exhaust neck rather than a solid box',()=>{
    const element=source.elements.find(element=>element.id==='tg-lp-1')!,mesh=solid(source,element)!
    const x=element.pose.position[0]+4.5,y=element.pose.position[1]+5.6,z=element.pose.position[2]+.15
    const coversNeck=(positions:readonly number[],materialIndices:readonly number[],plinthIndex:number):boolean=>{
      for(let i=0;i<positions.length;i+=9){
        if(materialIndices[i/3]!==plinthIndex)continue
        const points=[positions.slice(i,i+3),positions.slice(i+3,i+6),positions.slice(i+6,i+9)]
        if(!points.every(p=>Math.abs(p[2]!-(z+.15))<1e-7))continue
        const turns=points.map((a,j)=>{const b=points[(j+1)%3]!;return(b[0]!-a[0]!)*(y-a[1]!)-(b[1]!-a[1]!)*(x-a[0]!)})
        if(turns.every(t=>t>=-1e-8)||turns.every(t=>t<=1e-8))return true
      }
      return false
    }
    expect(coversNeck(mesh.positions,mesh.materialIndices,mesh.materials.indexOf('plinth'))).toBe(false)
    const old=retainedSchema.parse(retainedTurbine)
    const prior=retainedSolid(old,old.elements.find(e=>e.id==='tg-lp-1')!)!
    expect(coversNeck(prior.positions,prior.materialIndices,prior.materials.indexOf('context'))).toBe(true)
    expect(mesh.materials).toContain('plinth')
  })
  test('scope and vertical applicability retain housed and spanning component identity',()=>{
    const scene=compilePhysicalScene('layout:unit',{source,bindings,design:{digest:'test'},owner:{objectId:'plant:unit'},placement:{anchor:[11.47,59.087],bearing:0},bounds:physicalObjectsBounds(objects)})
    expect(scene.scopes?.find(scope=>scope.id==='building/turbine-hall')?.parentId).toBe('unit')
    const vessel=scene.objects.find(object=>object.id==='equipment/vessel')!
    expect(vessel.subjectIds).toContain('core')
    expect(vessel.scopeIds).toContain('building/containment')
    expect(vessel.levelIds!.length).toBeGreaterThan(1)
  })
})
