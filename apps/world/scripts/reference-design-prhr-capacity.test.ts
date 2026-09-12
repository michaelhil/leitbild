import {expect,test} from 'bun:test'
import {capacityScreens,parsePrhrCapacity} from './reference-design-prhr-capacity'
const basis={primaryPressure_MPa:15,hot_C:320,containmentPressure_MPa:.101325,flowBracket_kg_s:[75,1500] as [number,number],cells:32,cases:[{name:'nominal',pool_C:25,bankEffect:.5,terminalHead_Pa:0}]}
const doc=(b:unknown)=>'```reference-prhr-capacity\n'+JSON.stringify(b)+'\n```\n'
test('capacity basis rejects ambiguous ownership, unphysical input and silent options',()=>{
  expect(parsePrhrCapacity(doc(basis))).toEqual(basis)
  for(const s of [doc(basis)+doc(basis),doc({...basis,unknown:true}),doc({...basis,flowBracket_kg_s:[1500,75]}),doc({...basis,primaryPressure_MPa:0}),doc({...basis,cells:0}),doc({...basis,cases:[]}),doc({...basis,cases:[{...basis.cases[0],bankEffect:0}]}),doc({...basis,cases:[{...basis.cases[0],bankEffect:2}]}),doc({...basis,cases:[{...basis.cases[0],pool_C:320}]}),doc({...basis,cases:[{...basis.cases[0],cells:64,extra:1}]})])expect(()=>parsePrhrCapacity(s)).toThrow()
})
test('numerical convergence cannot conceal a source-domain failure',()=>{
  const s={unscaledCorrelationScreenRatio:.8,insideFilm:{Re:3e6,Pr:2,turbulentNu:500,naturalNu:100,laminarNu:3.66}}
  expect(capacityScreens([s]).outsideBoilingScreen).toBe(false)
  expect(capacityScreens([s]).outsideForcedFilmScreen).toBe(false)
  expect(capacityScreens([{...s,unscaledCorrelationScreenRatio:1.01}]).outsideBoilingScreen).toBe(true)
  expect(capacityScreens([{...s,insideFilm:{...s.insideFilm,Re:1e7}}]).outsideForcedFilmScreen).toBe(true)
  expect(()=>capacityScreens([])).toThrow()
})
