import {expect,test} from 'bun:test'
import {createHash} from 'node:crypto'
import {compileTransportGeometry,partialTransparentTransportGeometry} from './reference-design-source-transport'
const region=(id:string,compartment:'UPPER'|'WELL')=>({id,compartment,volume_m3:2,envelopeLength_m:9}),
 partition=JSON.stringify({result:{regions:[region('UPPER','UPPER'),region('WELL/1','WELL')]}}),
 head={left:'UPPER',right:'WELL/1',area_m2:1,leftDistance_m:2,rightDistance_m:3,axis:'z',plane_m:4,
  meanOutwardNormal:[0,0,1],support:{id:'HEAD.MOUTH',kind:'head-mouth'}},
 outer={left:'UPPER',area_m2:2,leftDistance_m:2,axis:'equipment',meanOutwardNormal:[0,0,-1]},
 speed=Array(7).fill(1),receipt=(faces:unknown[],parent=partition)=>JSON.stringify({partitionSHA256:createHash('sha256').update(parent).digest('hex'),result:{faces}})
test('covered geometry requires exact layer incidence, including closed head',()=>{
 const faces=receipt([head,outer])
 expect(()=>compileTransportGeometry(partition,faces,speed,[])).toThrow('Missing optical')
 const g=compileTransportGeometry(partition,faces,speed,[{faceIndex:0,supportId:'HEAD.MOUTH',targetIds:['skin','matrix','skin']}])
 expect(g.faces[0]!.law).toEqual({kind:'optical',targets:[0,1,0]})
 expect(g.faces[1]!.law).toEqual({kind:'escape'})
 expect(g.envelopeLengths).toEqual([9,9]);expect(g.completeReactorOperator).toBe(false)
 expect(g.emissionIsDepositedHeat).toBe(false)
 for(const support of [{id:'RACK/1/E',kind:'rack-panel'},{id:'GATE.WELL',kind:'transfer-gate'}]){
  const a={...head,left:'WELL/1',right:'UPPER',support}
  // This fixture deliberately removes the head interface to test other covers.
  const p=partition.replaceAll('UPPER','LOWER')
  expect(()=>compileTransportGeometry(p,receipt([{...a,right:'LOWER'}, {...outer,left:'LOWER'}],p),speed,[])).toThrow('Missing optical')
 }
})
test('partial fixture names exclusions; it cannot silently turn a cover transparent',()=>{
 const g=partialTransparentTransportGeometry(partition,receipt([head,outer]),speed)
 expect(g.faces.length).toBe(1);expect(g.omittedFaces).toEqual([{faceIndex:0,supportId:'HEAD.MOUTH',kind:'head-mouth',area_m2:1}])
 expect(g.omittedArea_m2).toBe(1);expect(g.envelopeLengths).toEqual([9,9])
})
test('old untagged head and malformed/ambiguous physical incidence refuse',()=>{
 const {support:_,...untagged}=head
 expect(()=>partialTransparentTransportGeometry(partition,receipt([untagged,outer]),speed)).toThrow('head-mouth')
 expect(()=>compileTransportGeometry(partition,receipt([head,outer]),speed,[{faceIndex:0,supportId:'OTHER',targetIds:['a']}])).toThrow()
 expect(()=>compileTransportGeometry(partition,receipt([head,outer]),speed,[{faceIndex:1,supportId:'HEAD.MOUTH',targetIds:['a']}])).toThrow()
 const b={faceIndex:0,supportId:'HEAD.MOUTH',targetIds:['a']}
 expect(()=>compileTransportGeometry(partition,receipt([head,outer]),speed,[b,b])).toThrow('Duplicated')
 expect(()=>partialTransparentTransportGeometry(partition,receipt([outer,outer]),speed)).toThrow('Duplicated')
 expect(()=>partialTransparentTransportGeometry(partition,receipt([{...outer,rightDistance_m:1}]),speed)).toThrow('distance')
 expect(()=>partialTransparentTransportGeometry(partition,receipt([{...outer,left:'MISSING'}]),speed)).toThrow('Unknown')
 expect(()=>partialTransparentTransportGeometry(partition,receipt([{...outer,area_m2:0}]),speed)).toThrow()
 expect(()=>partialTransparentTransportGeometry(partition,receipt([outer],partition+' '),speed)).toThrow('lineage')
 expect(()=>partialTransparentTransportGeometry(partition,receipt([outer]),[1])).toThrow()
})
