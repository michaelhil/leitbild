/** Offline LD-01 engineering response. No runtime, EOS, transport or nuclear-data calibration. */
import {readFileSync} from 'node:fs'
import {z} from 'zod'

export type OperationalFeedbackBasis = {
  waterWorth:number; absorberWorth_pcm_ppmEq:number; fuelWorth_pcm_K:number
  bankWorth:number; bankReference:number; xenonWorth:number; beta:number
  fuelRange_K:[number,number]; waterWorthSensitivity:number[]
  residualEffectiveness:number; residualEffectivenessSensitivity:number[]
}
export type FeedbackReference = {
  waterMass_kg:number; fuelTemperature_K:number; absorberDensity_ppmEq:number
  xenonNumberDensity_m3:number
}
export type FeedbackRegion = {liquid_kg:number;steam_kg:number;dissolved_kgEq:number;retained_kgEq:number}
export type FeedbackState = {
  regions:FeedbackRegion[];fuelTemperature_K:number;bankPosition:number;xenonNumberDensity_m3:number
}
/** Model preparation screen, not a transient clamp or certified shutdown margin. */
export const dryLimitReactivity = (basis:OperationalFeedbackBasis,reference:FeedbackReference) =>
  -basis.waterWorth-basis.absorberWorth_pcm_ppmEq*1e-5*reference.absorberDensity_ppmEq+
  basis.bankWorth*(1-basis.bankReference)+basis.fuelWorth_pcm_K*1e-5*(basis.fuelRange_K[0]-reference.fuelTemperature_K)-basis.xenonWorth
export const admitOperationalFeedback = (basis:OperationalFeedbackBasis,reference:FeedbackReference) => {
  validateBasis(basis)
  validateReference(basis,reference)
  const limits=[...new Set([basis.waterWorth,...basis.waterWorthSensitivity])].map(waterWorth=>({waterWorth,reactivity:dryLimitReactivity({...basis,waterWorth},reference)}))
  if(limits.some(row=>!Number.isFinite(row.reactivity)||row.reactivity>=0))throw new Error('Feedback basis fails unmoderated-core admission screen')
  return limits
}
const finite = (values:number[]) => values.every(Number.isFinite)
const positive=z.number().finite().positive(),negative=z.number().finite().negative(),fraction=z.number().finite().min(0).max(1)
const basisSchema=z.object({
  waterWorth:positive,absorberWorth_pcm_ppmEq:negative,fuelWorth_pcm_K:negative,
  bankWorth:positive,bankReference:fraction,xenonWorth:negative,beta:positive.max(1),
  fuelRange_K:z.tuple([positive,positive]).refine(v=>v[1]>v[0],'Fuel range must increase'),
  waterWorthSensitivity:z.array(positive).min(1),residualEffectiveness:fraction,
  residualEffectivenessSensitivity:z.array(fraction).min(1),
}).strict()
export const parseOperationalFeedback = (document:string):OperationalFeedbackBasis => {
  const matches=[...document.matchAll(/^```reference-operational-feedback\s*\n([\s\S]*?)^```\s*$/gm)]
  if(matches.length!==1)throw new Error('Expected one operational feedback record')
  return basisSchema.parse(JSON.parse(matches[0]![1]!))
}
export const readOperationalFeedback = (path:string) => parseOperationalFeedback(readFileSync(path,'utf8'))
const validateBasis = (b:OperationalFeedbackBasis) => {
  basisSchema.parse(b)
}
const validateReference = (basis:OperationalFeedbackBasis,reference:FeedbackReference) => {
  if(!finite([reference.waterMass_kg,reference.fuelTemperature_K,reference.absorberDensity_ppmEq,reference.xenonNumberDensity_m3])||reference.waterMass_kg<=0||reference.xenonNumberDensity_m3<=0||reference.absorberDensity_ppmEq<0||
    reference.fuelTemperature_K<basis.fuelRange_K[0]||reference.fuelTemperature_K>basis.fuelRange_K[1])throw new Error('Invalid immutable feedback reference')
}
/** Caller prepares the basis once with admitOperationalFeedback; carrier/tracer owners admit region states. */
export const operationalFeedback = (basis:OperationalFeedbackBasis,reference:FeedbackReference,state:FeedbackState) => {
  validateBasis(basis)
  validateReference(basis,reference)
  if(!Array.isArray(state.regions)||state.regions.length===0||!finite([state.fuelTemperature_K,state.bankPosition,state.xenonNumberDensity_m3])||state.fuelTemperature_K<basis.fuelRange_K[0]||state.fuelTemperature_K>basis.fuelRange_K[1]||state.bankPosition<0||state.bankPosition>1||state.xenonNumberDensity_m3<0)throw new Error('Invalid feedback state')
  let liquid=0,steam=0,dissolved=0,retained=0
  for(const r of state.regions){
    const values=[r.liquid_kg,r.steam_kg,r.dissolved_kgEq,r.retained_kgEq]
    if(!finite(values)||values.some(v=>v<0)||(r.liquid_kg===0&&r.dissolved_kgEq!==0))throw new Error('Invalid region material')
    liquid+=r.liquid_kg;steam+=r.steam_kg;dissolved+=r.dissolved_kgEq;retained+=r.retained_kgEq
  }
  const waterRatio=(liquid+steam)/reference.waterMass_kg
  const absorberDensity_ppmEq=1e6*(dissolved+basis.residualEffectiveness*retained)/reference.waterMass_kg
  const water=basis.waterWorth*(waterRatio-1)
  const absorber=basis.absorberWorth_pcm_ppmEq*1e-5*(absorberDensity_ppmEq-reference.absorberDensity_ppmEq)
  const fuel=basis.fuelWorth_pcm_K*1e-5*(state.fuelTemperature_K-reference.fuelTemperature_K)
  const bank=basis.bankWorth*(state.bankPosition-basis.bankReference)
  const xenon=basis.xenonWorth*(state.xenonNumberDensity_m3/reference.xenonNumberDensity_m3-1)
  const total=water+absorber+fuel+bank+xenon
  if(!finite([waterRatio,absorberDensity_ppmEq,total]))throw new Error('Nonfinite feedback result')
  return {water,absorber,fuel,bank,xenon,total,coreLiquidConcentration_ppmEq:liquid===0?null:1e6*dissolved/liquid,waterRatio,absorberDensity_ppmEq,promptCritical:total>=basis.beta}
}

/** Fixed inventory states exercise the constitutive decision, not a prepared whole plant. */
export const operationalFeedbackComparison = (basis:OperationalFeedbackBasis) => {
  const reference:FeedbackReference={waterMass_kg:100,fuelTemperature_K:832.642613,absorberDensity_ppmEq:1000,xenonNumberDensity_m3:1}
  const state=(liquid:number,steam:number,dissolved:number,retained:number,bank=.7,fuel=reference.fuelTemperature_K):FeedbackState=>({regions:[{liquid_kg:liquid,steam_kg:steam,dissolved_kgEq:dissolved,retained_kgEq:retained}],fuelTemperature_K:fuel,bankPosition:bank,xenonNumberDensity_m3:1})
  const inputs=[
    {name:'nominal',state:state(100,0,.1,0)},
    {name:'same-water-phase-redistribution',state:state(10,90,.1,0)},
    {name:'steam-only-retained',state:state(0,5,0,.1)},
    {name:'empty-water-retained',state:state(0,0,0,.1)},
    {name:'cold-dilute-inserted',state:state(135,0,0,0,0,500)},
    {name:'cold-dilute-failed-release',state:state(135,0,0,0,.7,500)},
    {name:'hot-partly-inventoried',state:state(10,5,.1,0,.7,1600)},
  ]
  return {basis,reference,admittedDryLimits:admitOperationalFeedback(basis,reference),rejectedDryLimits:[.05,.10].map(waterWorth=>({waterWorth,reactivity:dryLimitReactivity({...basis,waterWorth},reference)})),scope:'Frozen inventory and feedback comparison; not an EOS-admissible trajectory or shutdown-margin qualification',cases:inputs.map(c=>({...c,result:operationalFeedback(basis,reference,c.state)})),sensitivity:basis.waterWorthSensitivity.flatMap(waterWorth=>basis.residualEffectivenessSensitivity.map(residualEffectiveness=>{
    const variant={...basis,waterWorth,residualEffectiveness}
    return {waterWorth,residualEffectiveness,dry:operationalFeedback(variant,reference,state(0,0,0,.1)),coldDiluteInserted:operationalFeedback(variant,reference,inputs[4]!.state)}
  }))}
}
if(import.meta.main){
  const path=process.argv[2]
  if(!path)throw new Error('Usage: bun reference-design-operational-feedback.ts <kinetics.md>')
  console.log(JSON.stringify(operationalFeedbackComparison(readOperationalFeedback(path)),null,2))
}
