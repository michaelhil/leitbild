import {expect,test} from 'bun:test'
import {createHash} from 'node:crypto'
import {normalDeliveryPython,normalDeliveryFlowDefinitions} from './reference-design-pressurizer-normal-delivery'
import {normalThermalDefinitions} from './reference-design-pressurizer-normal-thermal'
import {sprayTransferPython} from './reference-design-pressurizer-spray-transfer'
import {headCollectionPython} from './reference-design-pressurizer-head-collection'
import {movingPhasePython} from './reference-design-pressurizer-moving-phase'

const hash=(s:string)=>createHash('sha256').update(s).digest('hex')

test('asymmetric join preserves shared thermal, head and finite-phase definitions',()=>{
  expect(hash(normalThermalDefinitions)).toBe('dd9342aa2b40ae6c8930e24c8aeb09196f0f4178ed5ff76b2952435929c48fdc')
  expect(hash(headCollectionPython)).toBe('24ca42919b526bcb199899d0036bdcd0209a0e7abceec847aeb452362c919cd9')
  expect(hash(movingPhasePython)).toBe('d095a06389d1ac9dc2eaf284e2e0e222a70576c6b8549786d0fc6b6c64005ac6')
})

test('reviewed fixed-flow and trial-admission APIs deliberately have new program lineage',()=>{
  // Commit27fb3094 moves the same pressure law into a named fixed-q evaluator,
  // adds source H/entropy checks, and separates unresolved hydraulic spray
  // evaluation from default admission. These complete programs are NOT old bytes.
  // Old programs: research evidence/2026-09-13/primary-asymmetric-prechange-programs.json.
  // Physics/source gate: primary-pzr-normal.json + independent exact replay;
  // default/evaluator behavior: pressurizer-spray-transfer.test.ts routing test.
  const oldDelivery='6140836e1a9bf7e3454bec3e285da1d4ec2a597a8df7bd61a20ffc556736e61e'
  const oldSpray='03af3c6c935e4a3fca03eb5b2d05e0a2e06e0be6baca0a867c3cf58207034a3b'
  expect(hash(normalDeliveryPython)).not.toBe(oldDelivery)
  expect(hash(sprayTransferPython)).not.toBe(oldSpray)
  expect(hash(normalDeliveryPython)).toBe('1dd8e413e657bcd253e1da046da864c106198b946afc43b196fcc75bcd57dd17')
  expect(hash(sprayTransferPython)).toBe('abd5c6d5811341b610a9832f1ffeef07aae7524eb783c18dae31464c08ad3b77')
  expect(normalDeliveryPython.startsWith(normalThermalDefinitions)).toBe(true)
  expect(normalDeliveryPython.split(normalDeliveryFlowDefinitions).length).toBe(2)
})
