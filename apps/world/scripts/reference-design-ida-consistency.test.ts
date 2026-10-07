import {expect,test} from 'bun:test'
import {c99Hex,idaControlledFixture,idaFixtureOutcome,pinnedIdaSourceSHA256,replayIdaHistoryTrace} from './reference-design-ida-consistency'
import {nativeIdasConsistencyFixture} from './reference-design-idas-consistency'

test('IDA port changes exactly one shared-API header, not fixture laws or gates',()=>{
 const fixture=idaControlledFixture()
 expect(fixture.replace('#include <ida/ida.h>','#include <idas/idas.h>')).toBe(nativeIdasConsistencyFixture)
 expect(fixture).toContain('stageResidualError<=1e-5')
 expect(fixture).toContain('candidate)check(x[i]==a[i]')
 expect(fixture).not.toContain('derivativeDifference<=')
 expect(()=>idaControlledFixture('')).toThrow()
 expect(()=>idaControlledFixture(nativeIdasConsistencyFixture+'\n#include <idas/idas.h>')).toThrow()
 expect(pinnedIdaSourceSHA256).toMatch(/^[a-f0-9]{64}$/)
})
test('controlled output retains refusal and rejects wrong/multiple role records',()=>{
 const passed={passed:true,candidateRole:true,steps:125,minimumStepSeconds:1e-5,maximumStepSeconds:.01,
  maximumAnalyticStateError:1e-7,maximumGenuineStageResidualError:1e-6,maximumInterpolantDerivativeError:1e-6,
  maximumStageHistoryDerivativeDifferenceInStepAtolUnits:.25,maximumReturnedHistoryStateDifferenceInAtolUnits:0,
  freshStageOutputs:120,interpolantOutputs:5,observedOrderStepCounts:[1,3,10,50,61],wallSeconds:.1}
 expect(idaFixtureOutcome('{"passed":false,"candidateRole":false}','control').passed).toBe(false)
 expect(idaFixtureOutcome(JSON.stringify(passed),'candidate').passed).toBe(true)
 expect(()=>idaFixtureOutcome(JSON.stringify({...passed,maximumGenuineStageResidualError:null}),'candidate')).toThrow()
 expect(()=>idaFixtureOutcome(JSON.stringify({...passed,maximumReturnedHistoryStateDifferenceInAtolUnits:1e-9}),'candidate')).toThrow()
 expect(()=>idaFixtureOutcome('{"passed":true,"candidateRole":false}','candidate')).toThrow()
 expect(()=>idaFixtureOutcome('{}\n{}','control')).toThrow()
 expect(()=>idaFixtureOutcome('not json','control')).toThrow()
})
test('C99 hex parsing preserves finite binary64 normal/subnormal values and signed zero',()=>{
 expect(Object.is(c99Hex('-0x0p+0'),-0)).toBe(true)
 expect(Object.is(c99Hex('0x0p+0'),0)).toBe(true)
 expect(c99Hex('0x1.8p+0')).toBe(1.5)
 expect(c99Hex('0x0.0000000000001p-1022')).toBe(Number.MIN_VALUE)
 expect(c99Hex('0x1p-348')).toBe(2**-348)
 for(const value of ['nan','inf','1.5','0x1p+1024','0x1p-2000'])expect(()=>c99Hex(value)).toThrow()
})
test('stock history replay retains nonmasked controls and refuses inconsistent trace',()=>{
 const row={role:'first-violation',row:0,constraint:'0x1p+0',rawFailedMask:true,target:'0x0p+0',ewt:'0x1p+0',
  predictor:'0x1.999999999999ap-2',rawY:'-0x1.9999999999998p-4',rawYP:'0x0p+0',
  eeBeforeConstraint:'-0x1p-1',eeAfterConstraint:'-0x1.999999999999ap-2',correctedEndpoint:'0x0p+0',
  predictedPhi0:'-0x1p-55',retainedPhi0:'-0x1p-55',predictionMatches:true,
  oldPhi:['0x1.999999999999ap-4','0x1.3333333333333p-2']},
  control={...row,role:'unconstrained-control',row:1,constraint:'0x0p+0',rawFailedMask:false,predictor:'0x1p+0',rawY:'0x1p+0',
   eeBeforeConstraint:'0x0p+0',eeAfterConstraint:'0x0p+0',correctedEndpoint:'0x1p+0',predictedPhi0:'0x1p+0',
   retainedPhi0:'0x1p+0',oldPhi:['0x1p+0','0x0p+0']},
  record={kind:'ida-history-constraint-trace',dimension:2,step:1,order:1,time:'0x1p-4',hUsed:'0x1p-4',cj:'0x1p+4',violatedCoordinates:1,rows:[row,control]}
 const result=replayIdaHistoryTrace(JSON.stringify(record))[0]!
 expect(result.rows[0]!.replayedRetained).toBe(-(2**-55))
 expect(result.rows[0]!.maskedNonStrictExactZero).toBe(true)
 expect(result.rows[1]!.repairedEndpoint).toBe(1)
 const negativeControl={...control,constraint:'-0x1p+0',role:'interior-control',target:'-0x0p+0',
  predictor:'-0x1p+0',rawY:'-0x1p+0',correctedEndpoint:'-0x1p+0',predictedPhi0:'-0x1p+0',
  retainedPhi0:'-0x1p+0',oldPhi:['-0x1p+0','0x0p+0']}
 expect(Object.is(replayIdaHistoryTrace(JSON.stringify({...record,rows:[row,negativeControl]}))[0]!.rows[1]!.target,-0)).toBe(true)
 expect(()=>replayIdaHistoryTrace(JSON.stringify({...record,rows:[{...row,retainedPhi0:'0x0p+0'}]}))).toThrow()
 expect(()=>replayIdaHistoryTrace(JSON.stringify({...record,rows:[{...row,predictionMatches:false}]}))).toThrow()
 expect(()=>replayIdaHistoryTrace(JSON.stringify({...record,rows:[{...row,correctedEndpoint:'0x1p-55'}]}))).toThrow()
 expect(()=>replayIdaHistoryTrace('{"kind":"ida-history-trace-error","error":"clone"}')).toThrow()
})
