import {expect,test} from 'bun:test'
import {createHash} from 'node:crypto'
import {parseNormalPhase} from './reference-design-pressurizer-normal-phase'
import {calculation} from './reference-design-wall-boiling'

const input={dropletDiameter_m:.0005,postBreakupVelocity_m_s:.2,fallHeight_m:5.75,
  heaterElements:32,heaterDiameter_m:.02,heaterLength_m:1,heaterPatchRadius_m:.03,
  normalBankCapacity_W:120000,surfaceFactor:1}
const doc=(x:unknown)=>'```reference-pressurizer-normal-phase\n'+JSON.stringify(x)+'\n```\n'
test('one explicit normal phase basis, no hidden phase or live-model options',()=>{
  expect(parseNormalPhase(doc(input))).toEqual(input)
  expect(()=>parseNormalPhase('')).toThrow()
  expect(()=>parseNormalPhase(doc(input)+doc(input))).toThrow()
  for(const change of [{dropletDiameter_m:0},{fallHeight_m:-1},{postBreakupVelocity_m_s:0},
    {heaterElements:1.5},{heaterPatchRadius_m:.01},{heaterPatchRadius_m:.005},
    {normalBankCapacity_W:0},{surfaceFactor:0},{requiredGamma_kg_s:.045873},{liveAdmission:true}])
    expect(()=>parseNormalPhase(doc({...input,...change}))).toThrow()
})
test('shared pool extraction preserves the previously executed complete wall calculation',()=>{
  expect(createHash('sha256').update(calculation).digest('hex'))
    .toBe('c912a27cf253182353b6595454dfd892a7b62e9f179ddb7427854f41996d527f')
})
