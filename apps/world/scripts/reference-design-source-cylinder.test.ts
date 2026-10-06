import {beforeAll,describe,expect,test} from 'bun:test'
import {join} from 'node:path'
import {readFileSync} from 'node:fs'
import {compileCylinderInputs,parseConverterResponse} from './reference-design-source-cylinder'
import {compileOriginalPassiveGeometry} from './reference-design-source-passive'
import {parsePrimaryWaterInputs,primaryWaterOwnerFiles} from './reference-design-source-water'
import {compileSourcePartition} from './reference-design-source-partition'
import {compileSourceFaces} from './reference-design-source-faces'
import {compileColdSourceMaterial,parseOperatingFuelCohorts} from './reference-design-source-material'
import {parseNuclearObservation} from './reference-design-nuclear-observation'
import {parseColdNuclear} from './reference-design-cold-nuclear'
const wiki=process.env.LEITBILD_REFERENCE_WIKI
describe.skipIf(!wiki)('actual ORIGINAL cylinder/converter input',()=>{
 let d:ReturnType<typeof parsePrimaryWaterInputs>,p:ReturnType<typeof compileSourcePartition>,m:ReturnType<typeof compileColdSourceMaterial>,
  passive:ReturnType<typeof compileOriginalPassiveGeometry>,apparatus:ReturnType<typeof parseNuclearObservation>,source:string,result:ReturnType<typeof compileCylinderInputs>
 beforeAll(()=>{
  const read=(name:string)=>readFileSync(join(wiki!,name),'utf8')
  d=parsePrimaryWaterInputs(primaryWaterOwnerFiles.map(read));p=compileSourcePartition(d)
  apparatus=parseNuclearObservation(read('systems/instrumentation/nuclear-observation-apparatus.md'))
  source=read('systems/reactor/configuration-source-and-history.md')
  m=compileColdSourceMaterial(p,{fuel:d.fuel,handling:d.handling,grid:parseOperatingFuelCohorts(read('systems/reactor/radial-energy-transient.md')),
   apparatus,source:{birthEmission_neutrons_s:parseColdNuclear(read('systems/reactor/cold-source-and-startup.md')).source.birthEmission_neutrons_s}})
  passive=compileOriginalPassiveGeometry(p,d,m,compileSourceFaces(p,d.gates,[0,0]).faces,source)
  result=compileCylinderInputs(p,d,m,passive,apparatus,source)
 },20_000) // Opt-in full ORIGINAL geometry compilation, not a runtime budget.
 test('52 physical bodies and one finite converter retain identity and original references',()=>{
  expect(result.targets).toHaveLength(53);expect(new Set(result.globalTargetIds).size).toBe(53)
  expect(result.targets.slice(0,52).every(t=>t.multiplicity===24&&t.inner_radius===0&&t.escape_depth===0&&t.collection===0)).toBe(true)
  for(const t of result.targets){expect(t.atoms).toBe(t.reference_atoms);expect(t.atoms).toBeGreaterThan(0);expect(t.products).toBe(0)}
  const converter=result.targets[result.converterTarget]!
  expect(converter.id).toBe('CONVERTER/B10');expect(converter.thermalRecipientId).toBe('COLLECTOR')
  expect(converter.escape_depth).toBe(1e-6);expect(converter.collection).toBe(0.5)
 })
 test('source cuts distribute physical response without adding end caps or changing outer black limit',()=>{
  for(let i=0;i<result.targets.length;i++)expect(result.intersections.filter(e=>e.target===i).reduce((s,e)=>s+e.share,0)).toBeCloseTo(1,12)
  const c=result.converterGeometry
  expect(c.outerFilmArea_m2).toBeGreaterThan(c.carrierArea_m2)
  expect(c.outerBlackCoefficient_m2).toBe(c.outerFilmArea_m2/4)
  const shares=result.intersections.filter(e=>e.target===result.converterTarget).map(e=>e.share)
  expect(shares).toHaveLength(2);for(const share of shares)expect(share).toBeCloseTo(0.5,12)
  expect(result.completeReactorOperator).toBe(false);expect(result.acquiredInstrument).toBe(false)
 })
 test('missing finite body/converter incidence and unowned response choices refuse',()=>{
  expect(()=>compileCylinderInputs(p,d,m,{...passive,stocks:passive.stocks.filter(s=>s.captureMode!=='cylinder')},apparatus,source)).toThrow('identity')
  expect(()=>compileCylinderInputs(p,d,{...m,converter:{...m.converter,incidence:m.converter.incidence.slice(1)}},passive,apparatus,source)).toThrow('coverage')
  expect(()=>parseConverterResponse(source.replace('"collectionFraction":0.5','"collectionFraction":2'))).toThrow()
 })
})
