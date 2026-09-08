import {describe,expect,test} from 'bun:test'
import {createKernelPropertyReader,KernelTrialError,solveKernelLinear,solveKernelNewton} from './reference-design-kernel.ts'

describe('bounded native kernel numerical primitives',()=>{
  test('dense solve pivots rather than inventing diagonal conductance',()=>{
    expect(solveKernelLinear([[0,2],[3,4]],[4,11])).toEqual([1,2])
  })
  test('rejects singular and nonfinite systems',()=>{
    expect(()=>solveKernelLinear([[1,2],[2,4]],[1,2])).toThrow()
    expect(()=>solveKernelLinear([[NaN]],[1])).toThrow()
  })
  test('coupled Newton reaches an actual residual, not a last iterate',()=>{
    const r=solveKernelNewton(x=>[x[0]!**2+x[1]!-5,x[0]!+x[1]!-3],[1.8,1.2])
    expect(r.x[0]).toBeCloseTo(2,8)
    expect(r.x[1]).toBeCloseTo(1,8)
    expect(r.residual).toBeLessThan(2e-10)
  })
  test('line search rejects inadmissible trials without clamping state',()=>{
    let rejected=0
    const r=solveKernelNewton(x=>{if(x[0]!<=0){rejected++;throw new KernelTrialError('liquid domain')};return[Math.log(x[0]!)]},[10])
    expect(r.x[0]).toBeCloseTo(1,8)
    expect(rejected).toBeGreaterThan(0)
  })
  test('nonfinite residual never becomes a converged state',()=>{
    expect(()=>solveKernelNewton(()=>[NaN],[1])).toThrow()
    expect(()=>solveKernelNewton(()=>[0,0],[1])).toThrow()
  })
  test('unexpected callback failures are not disguised as domain rejection',()=>{
    expect(()=>solveKernelNewton(x=>{if(x[0]!<0)throw Error('implementation defect');return[Math.log(x[0]!)]},[10])).toThrow('implementation defect')
  })
  test('property reuse is exact, per-cell and bounded to the last successful value',()=>{
    let calls=0
    const read=createKernelPropertyReader(2,(p,T)=>{calls++;return Object.freeze({p,T})})
    const value=read(0,15,300)
    expect(read(0,15,300)).toBe(value)
    expect(calls).toBe(1)
    read(1,15,300)
    read(0,15+Number.EPSILON*16,300)
    read(0,15,300)
    expect(calls).toBe(4)
    expect(()=>read(2,15,300)).toThrow('Invalid property request')
    expect(()=>read(0,NaN,300)).toThrow('Invalid property request')
  })
  test('failed property evaluation never replaces an accepted tuple',()=>{
    let calls=0
    const read=createKernelPropertyReader(1,(p,T)=>{calls++;if(p<0)throw new KernelTrialError('rejected');return{p,T}})
    const value=read(0,15,300)
    expect(()=>read(0,-1,300)).toThrow('rejected')
    expect(read(0,15,300)).toBe(value)
    expect(calls).toBe(2)
  })
  test('reference comparison can disable reuse without changing requests',()=>{
    let calls=0
    const read=createKernelPropertyReader(1,(p,T)=>{calls++;return p+T},false)
    expect(read(0,15,300)).toBe(315)
    expect(read(0,15,300)).toBe(315)
    expect(calls).toBe(2)
  })
})
