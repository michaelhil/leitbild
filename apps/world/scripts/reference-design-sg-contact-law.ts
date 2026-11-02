/** The SG contact law's strict block (`ld01-sg-contact`): the equivalent
 * tube bundle (count, outside and inside diameter, fouling; X4.5 R2.1-R2.8),
 * uniform over the developed fold, and the tube steel's emissivity and
 * material constants. A leaf module, so that the fluid
 * compiler (the SG metal's segment areas) and the SG section compiler read
 * the same parse without importing each other. */
import {z} from 'zod'
import {ownedBlock} from './reference-design-operating-pzr'

const positive=z.number().finite().positive()
export const sgContactOwner={page:'systems/steam-generation/thermodynamics.md',heading:'Selected pure-water secondary contact law',fence:'ld01-sg-contact'} as const
const contactSchema=z.object({tubeCount:z.number().int().positive(),tubeOutsideDiameter_m:positive,tubeInsideDiameter_m:positive,
  foulingResistance_m2K_W:z.number().finite().nonnegative(),emissivity:positive.max(1),steelConductivity_W_mK:positive,
  steelDensity_kg_m3:positive,steelCp_J_kgK:positive}).strict()
  .refine(c=>c.tubeInsideDiameter_m<c.tubeOutsideDiameter_m,'SG tube inside diameter must be below its outside diameter')
/** The SG contact law's tube bundle and wall constants (`ld01-sg-contact`). */
export const parseSgContact=(thermodynamics:string)=>contactSchema.parse(ownedBlock(thermodynamics,sgContactOwner.heading,sgContactOwner.fence))
export type SgContact=ReturnType<typeof parseSgContact>
/** The bundle's derived quantities over the fold's developed length L (X4.5):
 * the outer (secondary) exchange area N pi OD L, the primary area N pi ID L,
 * and the tube film's flow area N pi ID^2/4. The native check recomputes the
 * outer area in the same order. */
export function sgTubeBundle(c:SgContact,developedLength_m:number){
  if(!(Number.isFinite(developedLength_m)&&developedLength_m>0))throw Error('SG tube bundle needs the fold developed length')
  const N=c.tubeCount
  return {exchangeArea_m2:N*Math.PI*c.tubeOutsideDiameter_m*developedLength_m,
    primaryArea_m2:N*Math.PI*c.tubeInsideDiameter_m*developedLength_m,
    filmFlowArea_m2:N*Math.PI*c.tubeInsideDiameter_m**2/4,thermalDiameter_m:c.tubeInsideDiameter_m}
}
/** The packet's contact section: the block with its derived outer area. */
export const sgContactSection=(thermodynamics:string,developedLength_m:number)=>{
  const c=parseSgContact(thermodynamics)
  return {...c,exchangeArea_m2:sgTubeBundle(c,developedLength_m).exchangeArea_m2}
}
