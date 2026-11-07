import {describe,expect,test} from 'bun:test'
import {canonical,digest,parseTimeL,quietCpuS,relativeDifference} from './ld01-receipts'
import {TRAJECTORY_SECTIONS,builtS3Cases,environmentMismatch,judgePairs,judgeSpan,median,pinnedPath,resolvePinned} from './ld01-tier'

const TIME_L=`       17.52 real        16.70 user         0.48 sys
           396132352  maximum resident set size
        162664340499  instructions retired
         50098263776  cycles elapsed
        2.19 real         1.39 user         0.73 sys
           189333504  maximum resident set size
         15282404856  instructions retired
`

describe('LD-01 receipt tooling',()=>{
 test('T1LOCK: the median of three paired differences is judged against the 1 % limit',()=>{
  expect(median([4.948e9,4.918e9,4.919e9])).toBe(4.919e9)
  const pin={instructions:4.936e9,digest:'d'}
  const pair=(test:number,control:number,digest='d',controlDigest='d')=>({test:{instructions:test,digest},control:{instructions:control,digest:controlDigest}})
  // The machine lifts both runs 2.6 % above the pin: no rise.
  const lifted=judgePairs(pin,[pair(5.07e9,5.06e9),pair(5.04e9,5.05e9),pair(5.06e9,5.06e9)])
  expect(lifted.verdict).toBe('pass')
  expect(lifted.instructions_relative_difference).toBe(0)
  // One outlying pair does not decide; a rise in the median does.
  expect(judgePairs(pin,[pair(5.2e9,4.95e9),pair(4.95e9,4.95e9),pair(4.96e9,4.95e9)]).verdict).toBe('pass')
  expect(judgePairs(pin,[pair(5.01e9,4.95e9),pair(5.00e9,4.95e9),pair(4.96e9,4.95e9)]).verdict).toBe('fail')
  expect(judgePairs(pin,[pair(5.06e9,4.95e9)]).verdict).toBe('fail')
  expect(judgePairs(pin,[pair(4.87e9,4.95e9)]).verdict).toBe('fail')
  // Every digest counts, the control's too.
  expect(judgePairs(pin,[pair(4.95e9,4.95e9),pair(4.95e9,4.95e9,'x'),pair(4.95e9,4.95e9)]).verdict).toBe('fail')
  expect(judgePairs(pin,[pair(4.95e9,4.95e9),pair(4.95e9,4.95e9,'d','x'),pair(4.95e9,4.95e9)]).verdict).toBe('fail')
  expect(judgePairs(undefined,[pair(1,1)]).verdict).toBe('no pin')
 })
 test('a pin file names no machine: its paths are relative to the receipts, and an absolute one is refused',()=>{
  const receipts='/r/candidates/spine/resume'
  expect(pinnedPath(`${receipts}/lane/t1/control-s3_cases`,receipts)).toBe('lane/t1/control-s3_cases')
  expect(pinnedPath('/r/candidates/water-1',receipts)).toBe('../../water-1')
  for(const path of [`${receipts}/lane/t1/control-s3_cases`,'/r/candidates/water-1'])expect(resolvePinned(pinnedPath(path,receipts),receipts)).toBe(path)
  expect(()=>resolvePinned('/somewhere/control-s3_cases',receipts)).toThrow('relative to $LD01_RECEIPTS')
 })
 test('T1 takes the test binary from cargo\'s --no-run report and refuses without one',()=>{
  expect(builtS3Cases('  Executable tests/matrix_rebuild.rs (/t/deps/matrix_rebuild-1)\n  Executable tests/s3_cases.rs (/t/deps/s3_cases-2)\n')).toBe('/t/deps/s3_cases-2')
  expect(()=>builtS3Cases('Finished')).toThrow('no tests/s3_cases.rs')
 })
 test('time -l reports are summed over the test binaries of one cargo invocation',()=>{
  const r=parseTimeL(TIME_L)
  expect(r.processes).toBe(2)
  expect(r.instructions).toBe(162664340499+15282404856)
  expect(r.userS).toBeCloseTo(18.09,9)
  expect(r.maxRssBytes).toBe(396132352)
  expect(quietCpuS(14.32e9)).toBe(1)
 })
 test('the canonical form and the digest ignore key order and refuse a missing section',()=>{
  expect(canonical({b:[1,{d:2,c:1}],a:null})).toBe('{"a":null,"b":[1,{"c":1,"d":2}]}')
  const a={frames:[{t_s:548,p:1.5}],segments:[],stock_totals:{steps:1},counts_by_class:{},protection_log:[],timeline:{},cpu:{s:1}}
  const b={cpu:{s:2},timeline:{},protection_log:[],counts_by_class:{},stock_totals:{steps:1},segments:[],frames:[{p:1.5,t_s:548}]}
  expect(digest(a,TRAJECTORY_SECTIONS)).toBe(digest(b,TRAJECTORY_SECTIONS))
  expect(digest({...a,frames:[{t_s:548,p:1.5000000000000002}]},TRAJECTORY_SECTIONS)).not.toBe(digest(a,TRAJECTORY_SECTIONS))
  const {frames:_,...noFrames}=a
  expect(()=>digest(noFrames,TRAJECTORY_SECTIONS)).toThrow('frames')
 })
 test('a span passes only within 1 % of its pinned instructions and with its digest',()=>{
  const pin={instructions:100e9,digest:'x'}
  expect(judgeSpan(pin,{instructions:100.9e9,digest:'x'}).verdict).toBe('pass')
  expect(judgeSpan(pin,{instructions:101.1e9,digest:'x'}).verdict).toBe('fail')
  expect(judgeSpan(pin,{instructions:98.9e9,digest:'x'}).verdict).toBe('fail')
  expect(judgeSpan(pin,{instructions:100e9,digest:'y'}).verdict).toBe('fail')
  expect(judgeSpan(undefined,{instructions:1,digest:'y'}).verdict).toBe('no pin')
  expect(relativeDifference(0,0)).toBe(0)
 })
 test('a pin judges only the tuple it was recorded on',()=>{
  expect(environmentMismatch({packet_sha256:'a',state_sha256:'b'},{packet_sha256:'a',state_sha256:'b',extra:'c'})).toEqual([])
  expect(environmentMismatch({packet_sha256:'a'},{packet_sha256:'z'})).toEqual([{key:'packet_sha256',pinned:'a',current:'z'}])
 })
})
