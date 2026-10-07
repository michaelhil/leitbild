import {expect,test} from 'bun:test'
import {join} from 'node:path'
import {compileColdBarrel,parseColdBarrelSelection} from './reference-design-source-barrel'
import {compileFuelCooling} from './reference-design-fuel-cooling'
import {compilePrimaryWaterGeometry,parsePrimaryWaterInputs,primaryWaterOwnerFiles} from './reference-design-source-water'

const caloric='```reference-304-caloric\n'+JSON.stringify({density_kg_m3:7920,cpConstant_J_kg_K:469.4448,
 cpLinear_J_kg_K2:.13480848,datum_K:300,minimum_K:290,maximum_K:1600})+'\n```'
const source='```reference-cold-barrel-connection\n'+JSON.stringify({wetContact_W_m2_K:250,
 hostPhotonBoundary:'both-cylinders-and-annular-ends',photonContactWeights:'normalized-five-thermal-areas',
 liquidEnvelopes:{'LOWER.EXTERNAL':{kind:'reduced-cylinder',radius_m:1.9},
 'Core.1.EXTERNAL':{kind:'rod-guide-exterior-and-two-liquid-ends',length_m:2},
 'Core.2.EXTERNAL':{kind:'rod-guide-exterior-and-two-liquid-ends',length_m:2},
 'UPPER.EXTERNAL':{kind:'reduced-cylinder',crossSection_m2:16.75},
 DOWN:{kind:'owned-annulus',innerRadius_m:2,length_m:6}}})+'\n```'

test('barrel selections are explicit and reject missing, duplicate, invalid or unknown contracts',()=>{
 expect(parseColdBarrelSelection(source,caloric).caloric.datum_K).toBe(300)
 for(const bad of ['',source+source,source.replace('250','0'),source.replace('owned-annulus','assumed-dry')])
  expect(()=>parseColdBarrelSelection(bad,caloric)).toThrow()
 for(const bad of ['',caloric+caloric,caloric.replace('290','301'),caloric.replace('7920','-1'),
  caloric.replace('"datum_K":300','"datum_K":300,"extra":1')])expect(()=>parseColdBarrelSelection(source,bad)).toThrow()
})

const wiki=process.env.LEITBILD_REFERENCE_WIKI,ownerTest=wiki?test:test.skip
ownerTest('actual five barrel contacts preserve physical photon geometry and thermal recipient identity',async()=>{
 const p=await compileFuelCooling(wiki!),b=p.barrel,
  texts=await Promise.all(primaryWaterOwnerFiles.map(n=>Bun.file(join(wiki!,n)).text())),
  d=parsePrimaryWaterInputs(texts),sourceText=await Bun.file(join(wiki!,'systems/reactor/configuration-source-and-history.md')).text(),
  caloricText=await Bun.file(join(wiki!,'systems/primary-coolant/heater-equipment.md')).text(),
  geometry=compilePrimaryWaterGeometry(p.material.partition,d)
 expect(b.mass_kg).toBeCloseTo(58222.508330448894,7)
 expect(b.contacts).toHaveLength(5)
 expect(new Set(b.contacts.map(c=>c.water_index)).size).toBe(5)
 expect(b.contacts.reduce((s,c)=>s+c.area_m2,0)).toBeCloseTo(2*Math.PI*(1.9+2)*6,11)
 for(const c of b.contacts){
  expect(p.network.water[c.water_index]!.id).toBe(c.cellId)
  expect(c.liquid_chord_m).toBe(4*c.photonVolume_m3/c.photonBoundary_m2)
  expect(c.liquid_chord_m).toBeGreaterThan(0)
 }
 const down=b.contacts.find(c=>c.owner==='DOWN')!,upper=b.contacts.find(c=>c.owner==='UPPER.EXTERNAL')!
 expect(down.photonVolume_m3).toBeCloseTo(20,10) // physical ends are not truncated to neutron support
 expect(upper.photonVolume_m3).toBeLessThan(p.network.water[upper.water_index]!.volume_m3) // housing not a longer photon chord
 expect(b.contacts.find(c=>c.owner==='Core.1.EXTERNAL')!.liquid_chord_m).toBe(
  b.contacts.find(c=>c.owner==='Core.2.EXTERNAL')!.liquid_chord_m)
 const reversed={water:[...p.network.water].reverse()},reordered=compileColdBarrel(d,reversed,geometry,sourceText,caloricText)
 for(const c of reordered.contacts)expect(reversed.water[c.water_index]!.id).toBe(c.cellId)
 expect(reordered.contacts.map(c=>c.liquid_chord_m)).toEqual(b.contacts.map(c=>c.liquid_chord_m))
 expect(()=>compileColdBarrel(d,{water:p.network.water.filter(w=>w.id!=='UPPER')},geometry,sourceText,caloricText)).toThrow('Unresolved')
 expect(()=>compileColdBarrel(d,{water:p.network.water.map(w=>w.id==='DOWNCOMER'?{...w,volume_m3:1}:w)},
  geometry,sourceText,caloricText)).toThrow('exceeds')
 expect(()=>compileColdBarrel(d,p.network,geometry,sourceText.replace('"length_m":6','"length_m":4'),caloricText)).toThrow('length')
},60_000)
