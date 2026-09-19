import { expect,test } from 'bun:test'
import { parseSecondaryPreparationParent } from './reference-design-secondary-preparation'
const fixture=()=>({referenceCycle:{inputSha256:'reference'},support:{A:{point:{head_MPa:.3,commonDrop_MPa:.001,temperatures_C:{return:35,coolerOutlet:21},branches:['RCP.A1','RCP.B1','FW.P1','COND.P','CHARGE.P'].map(id=>({id,outlet_C:35}))}}}})
test('finite preparation consumes the named hardware parent and only existing jackets',()=>{
 const result=parseSecondaryPreparationParent(fixture(),'reference')
 expect(result.support.A.point.branches).toHaveLength(5)
 expect(result.support.A.point.head_MPa).toBe(.3)
 expect(()=>parseSecondaryPreparationParent(fixture(),'different')).toThrow()
})
test('unknown or duplicate water owners cannot silently acquire a default volume',()=>{
 const a=fixture();a.support.A.point.branches[0]!.id='EXTRA'
 expect(()=>parseSecondaryPreparationParent(a,'reference')).toThrow()
 const b=fixture();b.support.A.point.branches[0]!.id='COND.P'
 expect(()=>parseSecondaryPreparationParent(b,'reference')).toThrow()
})
test('missing/nonfinite native preparation inputs fail rather than assume a nominal state',()=>{
 expect(()=>parseSecondaryPreparationParent({},'reference')).toThrow()
 const a=fixture();a.support.A.point.head_MPa=NaN
 expect(()=>parseSecondaryPreparationParent(a,'reference')).toThrow()
 const b=fixture();b.support.A.point.branches.pop()
 expect(()=>parseSecondaryPreparationParent(b,'reference')).toThrow()
 const c=fixture();c.support.A.point.commonDrop_MPa=.4
 expect(()=>parseSecondaryPreparationParent(c,'reference')).toThrow()
})
