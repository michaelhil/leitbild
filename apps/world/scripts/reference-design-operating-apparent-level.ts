/** Compose the C08 compact apparent-level allocation (S5, S4-D12) into a
 * compiled joined packet: the section of `reference-design-operating-sg-level.ts`
 * (strict blocks only) becomes `secondary.apparentLevel`, where the SG
 * secondary owner appends its distribution coordinates. Nothing else in the
 * packet changes except its scope and provenance, so the S1-S3 packets,
 * which are never composed, stay bitwise and the composed packet differs
 * from its input only by the intended addition.
 *
 * The prepared distribution is the balance's `submerged / (volume - liquid)`;
 * every prepared SG stock must hold that gas volume, so the prepared
 * submerged volume is the balance's nominal one.
 *
 * Usage: bun reference-design-operating-apparent-level.ts <joined packet> <wiki root> */
import {createHash} from 'node:crypto'
import {prepareSgApparentLevel} from './reference-design-operating-sg-level'

type Json=Record<string,any>
type Section=Awaited<ReturnType<typeof prepareSgApparentLevel>>

export function composeApparentLevel(packet:Json,section:Section){
  if(!packet.secondary||!Array.isArray(packet.secondary.steamGenerators))throw Error('The packet has no SG secondary section')
  if('apparentLevel' in packet.secondary)throw Error('The packet already composes an apparent level')
  const d=section.distribution,stocks=packet.thermal?.secondaries as Json[]|undefined
  const ids=(packet.secondary.steamGenerators as Json[]).map(g=>g.id)
  if(!stocks||stocks.map(x=>x.id).join()!==ids.join())throw Error('The prepared SG stocks must follow the secondary section')
  for(const x of stocks){
    const submerged=d.preparedDistribution*(x.volume_m3-x.liquid_volume_m3)
    if(!(Math.abs(submerged-d.nominalSubmergedVolume_m3)<=1e-12*d.nominalSubmergedVolume_m3))
      throw Error(`SG.${x.id}: the prepared gas volume does not hold the balance's submerged volume (${submerged} m³)`)
  }
  const out:Json=structuredClone(packet)
  out.secondary.apparentLevel=section
  out.scope=String(packet.scope)+' With the C08 compact apparent level (one vapor-distribution state per SG) composed.'
  return out
}

if(import.meta.main){
  const [packetPath,wiki]=Bun.argv.slice(2)
  if(!packetPath||!wiki||Bun.argv.length!==4)throw Error('Usage: operating-apparent-level <joined packet> <wiki root>')
  const text=await Bun.file(packetPath).text()
  const composed=composeApparentLevel(JSON.parse(text),await prepareSgApparentLevel(wiki))
  composed.provenance={...composed.provenance,apparentLevel:{inputPacketSha256:createHash('sha256').update(text).digest('hex'),
    sourceSha256:createHash('sha256').update(await Bun.file(import.meta.path).text()).digest('hex')}}
  console.log(JSON.stringify(composed))
}
