import {expect,test} from 'bun:test'
import {parseGuideSourceInput} from './reference-design-guide-source'
const basis={activeExternalWater_kg:18655,activeGuideWater_kg:1828,activeExternalMobileTracer_kgEq:18.655,
 activeGuideMobileTracer_kgEq:1.828,activeRetainedTracer_kgEq:0,fuelTemperature_K:300 as const,
 freshSourceVector:Array.from({length:17},()=>0 as const),capsule:{identity:'LD01.CORE.SOURCE.CF252' as const,age_year:0}}
test('guide source consumes separate actual native water/tracer and zero fresh histories',()=>{
 expect(parseGuideSourceInput(basis)).toEqual(basis)
 expect(parseGuideSourceInput({...basis,activeGuideMobileTracer_kgEq:0}).activeGuideMobileTracer_kgEq).toBe(0)
})
test('guide source cannot invent source history or capsule identity',()=>{
 for(const bad of [{...basis,extra:1},{...basis,activeGuideWater_kg:0},
  {...basis,freshSourceVector:[1,...Array.from({length:16},()=>0)]},
  {...basis,freshSourceVector:Array.from({length:16},()=>0)},
  {...basis,capsule:{identity:'copied-source',age_year:0}},
  {...basis,capsule:{identity:'LD01.CORE.SOURCE.CF252',age_year:-1}}])expect(()=>parseGuideSourceInput(bad)).toThrow()
})
