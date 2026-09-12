import {expect,test} from 'bun:test'
import {createHash} from 'node:crypto'
import {normalDeliveryPython} from './reference-design-pressurizer-normal-delivery'
import {sprayTransferPython} from './reference-design-pressurizer-spray-transfer'
import {headCollectionPython} from './reference-design-pressurizer-head-collection'
import {movingPhasePython} from './reference-design-pressurizer-moving-phase'

test('named definitions preserve the complete previously accepted emitted calculations byte for byte',()=>{
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
  expect(hash(normalDeliveryPython)).toBe('4f6c2904dd4d7a9cbe987935bedc3fce83df3fd94f55033a861a8dfcbe81ce3c')
  expect(hash(sprayTransferPython)).toBe('03af3c6c935e4a3fca03eb5b2d05e0a2e06e0be6baca0a867c3cf58207034a3b')
  expect(hash(headCollectionPython)).toBe('24ca42919b526bcb199899d0036bdcd0209a0e7abceec847aeb452362c919cd9')
  expect(hash(movingPhasePython)).toBe('d095a06389d1ac9dc2eaf284e2e0e222a70576c6b8549786d0fc6b6c64005ac6')
})
