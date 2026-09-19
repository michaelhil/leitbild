import {describe,expect,it} from 'bun:test'
import {lossBudget,motorBudget,readSignedSelection,signedMachine} from './reference-design-rhr-signed-pump'

const k={a:.01,b:2,resistance:5000},rho=900,C=1/1000
describe('signed RHR single-incidence machine',()=>{
  it('has continuous head and finite torque on both axes',()=>{
    const rest=signedMachine(k,rho,0,0,1,C)
    expect(rest.shaftPower).toBe(0)
    expect(rest.torque).toBe(0)
    for(const m of [-100,100]){
      const stopped=signedMachine(k,rho,m,0,1,C)
      expect(stopped.shaftPower===0).toBe(true)
      expect(Number.isFinite(stopped.torque)).toBe(true)
      expect(Math.sign(-stopped.torque)).toBe(Math.sign(m))
      expect(stopped.dissipationProxy).toBeGreaterThan(0)
      for(const omega of [-1e-8,1e-8])expect(signedMachine(k,rho,m,omega,1,C).torque).toBeCloseTo(stopped.torque,5)
    }
    const zero=signedMachine(k,rho,0,300,1,C)
    expect(zero.torque).toBe(0)
    for(const m of [-1e-8,1e-8])expect(signedMachine(k,rho,m,300,1,C).rise).toBeCloseTo(zero.rise,3)
  })
  it('uses the same stage for pressure and signed shaft work',()=>{
    for(const m of [-100,100])for(const omega of [-300,300])for(const factor of [0,.5,1]){
      const s=signedMachine(k,rho,m,omega,factor,C)
      expect(s.shaftPower).toBeCloseTo(m*s.euler*C+s.brakePower,8)
      expect(s.brakePower).toBeGreaterThanOrEqual(0)
      if(m<0&&omega>0)expect(s.torque).toBeGreaterThanOrEqual(0)
      expect(s.dissipationProxy).toBeGreaterThanOrEqual(0)
      if(factor===0){expect(s.torque===0).toBe(true);expect(s.shaftPower===0).toBe(true);expect(s.rise).toBe(-s.loss)}
    }
  })
  it('retains extra deadhead heat and signed drag without a second pressure-loss heat',()=>{
    for(const omega of [-300,300]){
      const wet=lossBudget(omega,300,120000,1,0,1),dry=lossBudget(omega,300,120000,.01,0,0)
      expect(wet.extraTorque*omega).toBe(wet.extra)
      expect(wet.caseHeat).toBe(1200)
      expect(dry.metalHeat).toBe(12)
      expect(wet.dragPower).toBe(1200)
      expect(lossBudget(omega,300,120000,1,2000,1).extra).toBe(0)
    }
    expect(lossBudget(0,300,120000,1,0,1).extraTorque).toBe(0)
    expect(lossBudget(1e-6,300,120000,1,0,1).extraTorque).toBeCloseTo(0,10)
  })
  it('brakes reverse rotation into finite metal with no electric export',()=>{
    for(const omega of [-300,0,300]){
      const b=motorBudget(100,omega,.92)
      expect(b.electric-b.shaft-b.heat).toBeCloseTo(0,10)
      expect(b.electric).toBeGreaterThanOrEqual(0)
      expect(b.heat).toBeGreaterThanOrEqual(0)
    }
    expect(motorBudget(100,-300,.92)).toEqual({shaft:-30000,electric:0,heat:30000})
    expect(motorBudget(100,0,.92)).toEqual({shaft:0,electric:0,heat:0})
  })
  it('rejects malformed reference choices and invalid local inputs',()=>{
    const record={sigma:.2,sigmaSensitivity:[.1,.2,.3],rpm:3000,motorEfficiency:.92,coastdown_s:3,tracking_s:2,maximumTorqueFactor:1.5,entry_MPa:.97,headerTrip_MPa:1.05,headerRelief_MPa:1.08,headerReseat_MPa:1}
    const text='```reference-rhr-signed-machine\n'+JSON.stringify(record)+'\n```'
    expect(readSignedSelection(text)).toEqual(record)
    expect(()=>readSignedSelection(text+text)).toThrow()
    expect(()=>readSignedSelection(text.replace('"sigma":0.2','"sigma":1'))).toThrow()
    expect(()=>signedMachine(k,0,1,1,1,C)).toThrow()
    expect(()=>signedMachine(k,rho,1,1,1,-C)).toThrow()
    expect(()=>motorBudget(-1,300,.92)).toThrow()
  })
})
