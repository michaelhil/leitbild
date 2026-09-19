import {describe,expect,it} from 'bun:test'
import {absorberComparison,absorberPartition,transferLiquid} from './reference-design-absorber-retention'

describe('selected passive absorber retention',()=>{
  it('retains every tracer equivalent through complete carrier evaporation and redissolution',()=>{
    const result=absorberComparison()
    for(const row of [...result.evaporating,...result.rewet]){
      expect(row.dissolved+row.retained).toBeCloseTo(.2,14)
      expect(row.dissolved).toBeGreaterThanOrEqual(0)
      expect(row.retained).toBeGreaterThanOrEqual(0)
    }
    expect(result.evaporating.at(-1)).toEqual({liquid:0,dissolved:0,retained:.2,liquidConcentration:null})
    expect(result.rewet.at(-1)!.dissolved).toBe(.2)
    expect(result.sensitivity.map(row=>row.retained)).toEqual([.15000000000000002,.1,0])
  })
  it('moves only dissolved donor tracer, including after direction reversal',()=>{
    const {transfer,reverse}=absorberComparison()
    expect(transfer.transportedTracer).toBe(.05)
    expect(reverse.transportedTracer).toBe(.01)
    // An accepted liquid-origin payload is not deleted by a storage-free face flash;
    // a dry finite receiver retains it instead of pretending the face owns a deposit.
    expect(absorberPartition(0,transfer.receiver.tracer).retained).toBe(.05)
    for(const result of [transfer,reverse]){
      expect(result.donor.liquid+result.receiver.liquid).toBe(30)
      expect(result.donor.tracer+result.receiver.tracer).toBeCloseTo(.2,14)
    }
    expect(transferLiquid({liquid:0,tracer:1},{liquid:0,tracer:0},0).transportedTracer).toBe(0)
    expect(()=>transferLiquid({liquid:1,tracer:0},{liquid:0,tracer:0},2)).toThrow()
    expect(()=>absorberPartition(0,-1)).toThrow()
  })
})
