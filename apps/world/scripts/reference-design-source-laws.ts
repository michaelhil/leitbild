/** One consumed material/kinetics authority shared by native source components. */
import {z} from 'zod'
const positive=z.number().finite().positive(),nonnegative=z.number().finite().nonnegative(),
 seven=z.array(nonnegative).length(7),matrix=z.array(seven).length(7)
const materialSchema=z.object({units:z.literal('cm^-1'),
 fuel:z.object({absorption:seven,fission:seven,nu:z.array(positive).length(7),chi:seven,scatter:matrix}).strict()
  .refine(v=>v.chi.some(x=>x>0)&&v.absorption.every((a,g)=>a>=v.fission[g]!), 'Invalid fission/capture/spectrum table'),
 water:z.object({absorption:seven,scatter:matrix}).strict()}).strict()
const kineticsSchema=z.object({energies_eV:z.array(positive).length(7),neutronMass_kg:positive,
 delayedFractions:z.array(nonnegative).length(6),halfLives_s:z.array(positive).length(6),fD:z.number().finite().min(0).max(1)}).strict()
 .refine(v=>v.delayedFractions.reduce((a,b)=>a+b,0)<1,'Invalid delayed fraction')
export function configurationBlock(doc:string,name:string){
 const rows=[...doc.matchAll(new RegExp('^```'+name+'\\s*\\n([\\s\\S]*?)^```\\s*$','gm'))]
 if(rows.length!==1)throw Error('Expected one '+name+' block')
 return JSON.parse(rows[0]![1]!)
}
export function parseConfigurationMaterial(document:string){
 const material=materialSchema.parse(configurationBlock(document,'reference-configuration-material')),
  kinetics=kineticsSchema.parse(configurationBlock(document,'reference-configuration-kinetics')),
  SI=(xs:number[])=>xs.map(x=>x*100)
 return {fuel:{...material.fuel,absorption:SI(material.fuel.absorption),fission:SI(material.fuel.fission),
   scatter:material.fuel.scatter.map(SI)},
  water:{absorption:SI(material.water.absorption),scatter:material.water.scatter.map(SI)},kinetics,
  speed:kinetics.energies_eV.map(E=>Math.sqrt(2*E*1.602176634e-19/kinetics.neutronMass_kg))}
}
