/** The steam bypass's strict blocks on the admission owner's page, shared by
 * the C10 steam compiler (`ld01-bypass-control`) and the SG secondary
 * section's G1 stand-in (`ld01-bypass-no-load`, owner R12-B1). One schema per
 * block; nothing is defaulted. */
import {z} from 'zod'
import {ownedBlock} from './reference-design-operating-pzr'

const pos=z.number().finite().positive(),fraction=pos.max(1)
const page='systems/steam-power/admission-and-protection.md'
export const bypassOwners={
  control:{page,heading:'Compact operating allocation (15 October 2026)',fence:'ld01-bypass-control'},
  noLoad:{page,heading:'Normal control and bypass',fence:'ld01-bypass-no-load'},
} as const
const controlSchema=z.object({bandStart_Pa:pos,bandFull_Pa:pos,sample_s:pos,availableBelow_Pa:pos,headerEvidenceAge_s:pos,
  rating:z.object({fractionOfTotalSteam:fraction,inletPressure_Pa:pos,fluid:z.literal('saturatedVapor'),outlet:z.literal('nominalCondenser')}).strict()}).strict()
  .refine(b=>b.bandStart_Pa<b.bandFull_Pa,'Bypass band must be ordered')
/** R12-B1: the designed no-load average temperature and the IF97 saturation
 * pressure at it (the page shows the derivation; the native SG owner checks
 * it against its runtime saturation). */
const noLoadSchema=z.object({mode:z.literal('noLoadPressureAfterTurbineTrip'),noLoadAverageTemperature_K:pos,noLoadPressure_Pa:pos}).strict()
export const parseBypassControl=(admission:string)=>
  controlSchema.parse(ownedBlock(admission,bypassOwners.control.heading,bypassOwners.control.fence))
export const parseBypassNoLoad=(admission:string)=>
  noLoadSchema.parse(ownedBlock(admission,bypassOwners.noLoad.heading,bypassOwners.noLoad.fence))
