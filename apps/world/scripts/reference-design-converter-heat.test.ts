import {describe,expect,test} from 'bun:test'
import {parseCapturePhotonAbsorption} from './reference-design-converter-heat'
const record={energies_MeV:[.5,1],mu_en_m2_kg:Object.fromEntries(['B','C','Fe','Cr','Ni','Mn','Zr','H2O','UO2'].map(k=>[k,[.002,.003]]))}
const doc=(r:unknown)=>'```reference-capture-photon-absorption\n'+JSON.stringify(r)+'\n```'
describe('consumed photon material authority',()=>{
 test('uses exact units and energy classes, not total attenuation',()=>{
  expect(parseCapturePhotonAbsorption(doc(record)).mu_en_m2_kg.H2O).toEqual([.002,.003])
  expect(()=>parseCapturePhotonAbsorption(doc({...record,energies_MeV:[1,.5]}))).toThrow()
 })
 test('missing, duplicated or invalid material authority refuses',()=>{
  expect(()=>parseCapturePhotonAbsorption(doc(record)+doc(record))).toThrow()
  expect(()=>parseCapturePhotonAbsorption(doc({...record,mu_en_m2_kg:{...record.mu_en_m2_kg,H2O:[-.1,.003]}}))).toThrow()
  expect(()=>parseCapturePhotonAbsorption('')).toThrow()
 })
})
