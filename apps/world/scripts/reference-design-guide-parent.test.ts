import {expect,test} from 'bun:test'
import {createHash} from 'node:crypto'
import {freshGuideSource,guideParentCalculation} from './reference-design-guide-parent'
import {coldHydrostaticInventoryPython,coldParentCalculation} from './reference-design-cold-parent'

test('named native extraction leaves original parent physical payload identical',()=>{
 expect(createHash('sha256').update(coldParentCalculation).digest('hex')).toBe('1d5ff8e2d88db23660aca73845b046b37531fcb4f35616fc821c053d7ac67374')
 expect(coldParentCalculation.includes(coldHydrostaticInventoryPython)).toBe(true)
 expect(guideParentCalculation.includes(coldHydrostaticInventoryPython)).toBe(true)
})
test('fresh source vector is an explicit nonsteady preparation, not achieved/copy history',()=>{
 const source:ReturnType<typeof freshGuideSource>={fuelTemperature_K:300,activeRetainedTracer_kgEq:0,freshSourceVector:Array.from({length:17},():0=>0),capsule:{identity:'LD01.CORE.SOURCE.CF252',age_year:0}}
 expect(freshGuideSource(source)).toEqual(source)
 expect(()=>freshGuideSource({...source,freshSourceVector:[1,...source.freshSourceVector.slice(1)]})).toThrow()
 expect(()=>freshGuideSource({...source,activeRetainedTracer_kgEq:1})).toThrow()
 expect(()=>freshGuideSource({...source,fuelTemperature_K:290})).toThrow()
 expect(()=>freshGuideSource({...source,freshSourceVector:source.freshSourceVector.slice(1)})).toThrow()
})
