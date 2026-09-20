import {test,expect} from 'bun:test'
import {parseFeedPool,receivingPort} from './reference-design-feed-pool'
const b={pressure_Pa:101325,gravity_m_s2:9.80665,tankArea_m2:50,tankFloor_m:-2.4,tankHeight_m:4,
 collectionArea_m2:100,collectionFloor_m:0,weirCoefficient:1.7,initialTemperature_C:40,
 initialLiquidVolume_m3:120,condensatePort_m:-2.4,ventPort_m:0,ambientTemperature_C:25}
const text=(x:unknown)=>'```reference-feed-pool\n'+JSON.stringify(x)+'\n```'
test('selected feed geometry has one explicit bottom return and finite capacity',()=>{
 expect(parseFeedPool(text(b))).toEqual(b)
 expect(()=>parseFeedPool(text({...b,unowned:1}))).toThrow()
 expect(()=>parseFeedPool(text({...b,initialLiquidVolume_m3:200}))).toThrow()
 expect(()=>parseFeedPool(text({...b,condensatePort_m:0}))).toThrow()
 expect(()=>parseFeedPool(text({...b,collectionFloor_m:2}))).toThrow()
 expect(()=>parseFeedPool(text(b)+text(b))).toThrow()
})
test('real coverage and one receiving separation plane, not a priming guarantee',()=>{
 expect(receivingPort(0,0)).toEqual({covered:false,separationElevation:0})
 expect(receivingPort(.1,0)).toEqual({covered:true,separationElevation:.1})
 expect(receivingPort(-1,0)).toEqual({covered:false,separationElevation:0})
 expect(receivingPort(0,-2.4)).toEqual({covered:true,separationElevation:0})
 expect(receivingPort(-2.4,-2.4)).toEqual({covered:false,separationElevation:-2.4})
 expect(()=>receivingPort(NaN,0)).toThrow()
})
