import {expect,test} from 'bun:test'
import {parseSubmergedBasis} from './reference-design-pressurizer-submerged'
test('submerged reference declares native initial thermal departure, not an arbitrary HTC',()=>{
  const text=(v:unknown)=>'```reference-pressurizer-submerged\n'+JSON.stringify(v)+'\n```'
  expect(parseSubmergedBasis(text({poolInitialSubcooling_K:2}))).toEqual({poolInitialSubcooling_K:2})
  expect(()=>parseSubmergedBasis(text({poolInitialSubcooling_K:0}))).toThrow()
  expect(()=>parseSubmergedBasis(text({poolInitialSubcooling_K:2,heatTransferCoefficient:500}))).toThrow()
  expect(()=>parseSubmergedBasis(text({poolInitialSubcooling_K:2})+'\n'+text({poolInitialSubcooling_K:2}))).toThrow()
})
