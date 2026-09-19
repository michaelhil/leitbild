import {describe,expect,it} from 'bun:test'
import {absorberPartition,transferLiquid} from './reference-design-absorber-retention'
import {admitOperationalFeedback,dryLimitReactivity,operationalFeedback,operationalFeedbackComparison,parseOperationalFeedback,type FeedbackState,type OperationalFeedbackBasis} from './reference-design-operational-feedback'

// Standalone regression fixture. Engineering CLI comparisons consume the authored wiki record.
const basis:OperationalFeedbackBasis={waterWorth:.15,absorberWorth_pcm_ppmEq:-8,fuelWorth_pcm_K:-2,
  bankWorth:.1,bankReference:.7,xenonWorth:-.002,beta:.00649,fuelRange_K:[500,2000],
  waterWorthSensitivity:[.12,.15,.20],residualEffectiveness:1,residualEffectivenessSensitivity:[0,.5,1]}
const document=(record:unknown)=>'```reference-operational-feedback\n'+JSON.stringify(record)+'\n```\n'
const comparison=operationalFeedbackComparison(basis)
const reference=comparison.reference
const state=(liquid:number,steam:number,tracer:number):FeedbackState=>{
  const p=absorberPartition(liquid,tracer)
  return {regions:[{liquid_kg:liquid,steam_kg:steam,dissolved_kgEq:p.dissolved,retained_kgEq:p.retained}],fuelTemperature_K:reference.fuelTemperature_K,bankPosition:.7,xenonNumberDensity_m3:1}
}
describe('operational inventory feedback decision',()=>{
  it('reads exactly one explicit record without sibling-wiki or hidden-field dependencies',()=>{
    expect(parseOperationalFeedback(document(basis))).toEqual(basis)
    for(const value of ['',document(basis)+document(basis),document({...basis,hiddenPowerClamp:1}),
      document({...basis,fuelRange_K:[2000,500]}),document({...basis,residualEffectiveness:2}),
      document({...basis,waterWorthSensitivity:[]})])expect(()=>parseOperationalFeedback(value)).toThrow()
  })
  it('admits a water-moderated core but rejects inherited coefficient semantics',()=>{
    expect(admitOperationalFeedback(basis,reference)).toHaveLength(3)
    for(const waterWorth of [.05,.10]){
      expect(dryLimitReactivity({...basis,waterWorth},reference)).toBeGreaterThan(0)
      expect(()=>admitOperationalFeedback({...basis,waterWorth},reference)).toThrow('unmoderated')
    }
    expect(()=>admitOperationalFeedback(basis,{...reference,fuelTemperature_K:2000})).toThrow('unmoderated')
  })
  it('has no phase double count, no dry ppm substitution and continuous tracer remobilization',()=>{
    expect(operationalFeedback(basis,reference,state(100,0,.1)).total).toBe(0)
    for(const liquid of [100,10,1,.000001,0]){
      const result=operationalFeedback(basis,reference,state(liquid,100-liquid,.1))
      expect(result.total).toBeCloseTo(0,13)
      expect(result.absorberDensity_ppmEq).toBeCloseTo(1000,13)
      if(liquid===0)expect(result.coreLiquidConcentration_ppmEq).toBeNull()
    }
    expect(operationalFeedback(basis,reference,state(0,0,.1)).total).toBeCloseTo(-basis.waterWorth,13)
  })
  it('preserves additive global inventory meaning while admitting distribution blindness',()=>{
    const single=state(100,0,.1)
    const divided={...single,regions:[{liquid_kg:10,steam_kg:0,dissolved_kgEq:.09,retained_kgEq:0},{liquid_kg:90,steam_kg:0,dissolved_kgEq:.01,retained_kgEq:0}]}
    const splitResult=operationalFeedback(basis,reference,divided),singleResult=operationalFeedback(basis,reference,single)
    expect(splitResult.total).toBeCloseTo(singleResult.total,13)
    expect(splitResult.absorberDensity_ppmEq).toBeCloseTo(singleResult.absorberDensity_ppmEq,10)
    expect(splitResult.waterRatio).toBe(singleResult.waterRatio)
    const moved=transferLiquid({liquid:100,tracer:.1},{liquid:20,tracer:0},10)
    const after=operationalFeedback(basis,reference,state(moved.donor.liquid,0,moved.donor.tracer))
    // Both water and absorber depart: -1500 pcm +800 pcm, not -1500 pcm alone.
    expect(after.total*1e5).toBeCloseTo(-700,9)
  })
  it('retains positive cold-dilute response despite achieved full insertion',()=>{
    const cold=comparison.cases.find(c=>c.name==='cold-dilute-inserted')!
    expect(cold.result.total).toBeGreaterThan(basis.beta)
    expect(cold.result.promptCritical).toBeTrue()
    expect(cold.result.bank).toBeCloseTo(-.07,14)
  })
  it('copies the immutable baseline and reports residue sensitivity without resetting concentration',()=>{
    const dry=state(0,0,.1),copy=JSON.parse(JSON.stringify({basis,reference,dry}))
    expect(operationalFeedback(copy.basis,copy.reference,copy.dry)).toEqual(operationalFeedback(basis,reference,dry))
    expect(operationalFeedback({...basis,residualEffectiveness:0},reference,dry).total).toBeCloseTo(-.07,13)
    expect(()=>operationalFeedback(basis,reference,{...dry,regions:[{liquid_kg:0,steam_kg:0,dissolved_kgEq:.1,retained_kgEq:0}]})).toThrow()
    expect(()=>operationalFeedback(basis,reference,{...dry,fuelTemperature_K:2001})).toThrow()
  })
})
