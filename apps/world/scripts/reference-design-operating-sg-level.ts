/** The C08 compact apparent-level input (S5 blocker, lead decision S4-D10
 * (a)): the SG vapor-distribution law's selected values and the NR channels'
 * response, from their owners' strict blocks, unchanged or derived by
 * stated arithmetic. No property, law or state is evaluated here: the Rust
 * owner derives the residence time once on IF97 from the nominal reference,
 * `tau_residence = nominalSubmergedVolume_m3 * rho_g(nominalPressure_Pa) /
 * nominalSteamFlow_kg_s`, as the S2 owner derives its relief area.
 *
 * - `ld01-sg-distribution` (steam-generation/thermodynamics.md, Compact
 *   apparent-level allocation): the equilibrium bound, the distribution
 *   time and the nominal steam flow of the original derivation;
 * - `reference-balance` (numerical-basis.md): the nominal submerged volume,
 *   the nominal (preparation) pressure, and the prepared distribution
 *   `submerged / (volume - liquid)`;
 * - `ld01-sg-level-channels` (steam-generation/instrumentation.md): the NR
 *   lag and span and the indicated-level area, which must equal the
 *   balance's equivalent level area.
 *
 * Consumer: the test-only prototype `water-ffi/tests/c08_sg_level.rs`. It
 * is not composed into the joined packet until the lead lands the
 * allocation (packets stay bitwise unchanged).
 * Usage: bun reference-design-operating-sg-level.ts <wiki root> <section.json> */
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {z} from 'zod'
import {parseBalanceBasis} from './reference-design-balance'
import {parseSgLevelChannels} from './reference-design-operating-ic'
import {ownedBlock} from './reference-design-operating-pzr'

const positive=z.number().finite().positive()
const distributionSchema=z.object({maximumSubmergedVolume_m3:positive,distributionTime_s:positive,nominalSteamFlow_kg_s:positive}).strict()

const root='world/packs/process-plant/reference-designs/ld-01/'
export const sgLevelOwners={
  distribution:{page:'systems/steam-generation/thermodynamics.md',heading:'Compact apparent-level allocation (C08, 15 October 2026)',fence:'ld01-sg-distribution'},
  balance:{page:'numerical-basis.md',fence:'reference-balance'},
  channels:{page:'systems/steam-generation/instrumentation.md',fence:'ld01-sg-level-channels'},
} as const
export const sgLevelPages=['systems/steam-generation/thermodynamics.md','numerical-basis.md','systems/steam-generation/instrumentation.md'] as const
export type SgLevelSources={thermodynamics:string,balance:string,instrumentation:string}

export const parseSgDistribution=(thermodynamics:string)=>distributionSchema.parse(
  ownedBlock(thermodynamics,sgLevelOwners.distribution.heading,sgLevelOwners.distribution.fence))

/** The section: per-unit distribution values and the NR channel response. */
export function compileSgApparentLevel(d:SgLevelSources){
  const block=parseSgDistribution(d.thermodynamics),balance=parseBalanceBasis(d.balance),channels=parseSgLevelChannels(d.instrumentation),
    gas_m3=balance.secondaryVolume_m3-balance.secondaryLiquidVolume_m3
  if(!(balance.submergedVaporVolume_m3<=block.maximumSubmergedVolume_m3))
    throw Error('The nominal submerged volume exceeds the equilibrium bound')
  if(channels.indicatedLevelArea_m2!==balance.equivalentLevelArea_m2)
    throw Error('The NR channels and the balance must use one equivalent indicated-level area')
  return {scope:'C08 compact apparent level: one vapor-distribution state per SG (beta) with the selected first-order closure; apparent level (V_l + V_sub)/A read by the NR channels; contact and pickup unchanged',
    distribution:{nominalSubmergedVolume_m3:balance.submergedVaporVolume_m3,nominalPressure_Pa:balance.secondaryPressure_MPaAbs*1e6,
      nominalSteamFlow_kg_s:block.nominalSteamFlow_kg_s,maximumSubmergedVolume_m3:block.maximumSubmergedVolume_m3,
      distributionTime_s:block.distributionTime_s,preparedDistribution:balance.submergedVaporVolume_m3/gas_m3},
    indication:{indicatedLevelArea_m2:channels.indicatedLevelArea_m2,nrSpan_m:channels.nrSpan_m,nrLag_s:channels.nrLag_s}}
}

const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
/** The section, read from a wiki checkout, with its provenance. */
export async function prepareSgApparentLevel(wikiRoot:string){
  const docs=await Promise.all(sgLevelPages.map(p=>Bun.file(join(wikiRoot,root,p)).text())),
    [thermodynamics,balance,instrumentation]=docs as [string,string,string]
  return {...compileSgApparentLevel({thermodynamics,balance,instrumentation}),
    provenance:{sourceSha256:hash(await Bun.file(import.meta.path).text()),consumed:sgLevelPages.map((p,i)=>({name:root+p,sha256:hash(docs[i]!)}))}}
}

if(import.meta.main){
  const [wiki,output,...rest]=Bun.argv.slice(2)
  if(!wiki||!output||rest.length)throw Error('Usage: reference-design-operating-sg-level <wiki root> <section.json>')
  await Bun.write(output,JSON.stringify(await prepareSgApparentLevel(wiki),null,2)+'\n')
}
