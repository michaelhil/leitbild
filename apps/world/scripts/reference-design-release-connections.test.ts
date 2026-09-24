import {expect,test} from 'bun:test'
import {releaseBasis as b,releaseReceiver} from './reference-design-release-connections'

test('actual release opening and covered versus dry receiver',()=>{
 expect(Math.PI*b.msBore_m**2/4).toBeGreaterThan(b.msCdA_m2)
 expect(releaseReceiver(0,-1,100,101325).phase).toBe('gas')
 expect(releaseReceiver(0,0,100,101325).phase).toBe('gas')
 expect(releaseReceiver(0,1,100,101325,1000).pressure_Pa).toBeCloseTo(101325+1000*b.gravity_m_s2,8)
 expect(releaseReceiver(-2,-2,0,101325).phase).toBe('gas')
 expect(releaseReceiver(-2,-1.9,100,101325,1000).phase).toBe('liquid')
})
test('head is datum invariant and a wet port needs actual density',()=>{
 expect(releaseReceiver(100,101,100,101325,1000)).toEqual(releaseReceiver(0,1,100,101325,1000))
 expect(()=>releaseReceiver(0,1,100,101325)).toThrow()
 expect(()=>releaseReceiver(0,1,-1,101325)).toThrow()
})
