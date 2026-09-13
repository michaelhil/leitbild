import {describe,expect,test} from 'bun:test'
import {createHash} from 'node:crypto'
import {retainedSgSource,standbyPlan} from './reference-design-prhr-standby'
import {prhrCapacityPython} from './reference-design-prhr-capacity'

const face={owner:'SG.A/B.PRIMARY',p_Pa:14.7e6,h_J_kg:1285000,T_K:563,rho_kg_m3:745,
  s_J_kgK:3135,velocity_m_s:10,z_m:3,totalEnthalpy_J_kg:1285079.41995}
const receipt=()=>({accepted:true,case:{name:'nominal',heatFactor:1},result:{faces:[{owner:'unrelated'}, {...face}]}})
describe('standalone PRHR standby evidence interface',()=>{
  test('retains the actual admitted SG face without nominal substitution',()=>{
    const input=receipt(),actual=retainedSgSource(input)
    expect(actual.p_Pa).toBe(face.p_Pa)
    expect(actual.Ht_J_kg).toBe(face.totalEnthalpy_J_kg)
    expect(actual.u_m_s).toBe(face.velocity_m_s)
    expect(input.result.faces[1]).toEqual(face)
  })
  test('refuses rejected, wrong-case, missing and nonfinite parents',()=>{
    const rejected=receipt();rejected.accepted=false
    const wrong=receipt();wrong.case.heatFactor=.5
    const missing=receipt();missing.result.faces=[]
    const bad=receipt();bad.result.faces[1]={...face,p_Pa:NaN}
    for(const r of [rejected,wrong,missing,bad,{}])expect(()=>retainedSgSource(r)).toThrow()
  })
  test('named extraction preserves the historical capacity calculation exactly',()=>{
    expect(createHash('sha256').update(prhrCapacityPython).digest('hex')).toBe('bfd4b6de5b6dc150ac801425fe2db0b9af56f62e3c4d5e01e053a73b2a82e6b9')
    expect(standbyPlan.entryLoss_K).toBe(.5)
    expect(standbyPlan.loopBracket_kg_s[0]).toBeLessThan(0)
    expect(standbyPlan.loopBracket_kg_s[1]).toBeGreaterThan(0)
    expect(standbyPlan.wallSeconds).toBe(300)
    expect(standbyPlan.missingWorkFraction).toBe(.01)
  })
})
