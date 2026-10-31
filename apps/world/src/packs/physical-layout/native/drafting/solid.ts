import {solid as architectureSolid} from '../architecture/solid.ts'
import {foundationSolid} from './foundation.ts'
import {orientPhysicalFaces} from './orientation.ts'
import type {Source,Element} from './source.ts'
/** Explicit physical source extensions precede scope/bounds derivation. */
export const solid=(source:Source,element:Element)=>{
 const prior=architectureSolid(source,element.foundation?{...element,material:undefined}:element)
 if(!prior)return prior
 if(!element.foundation)return orientPhysicalFaces(prior)
 const {holes,...base}=element.foundation
 const result=foundationSolid(source,{...element,foundation:{...base,...(holes?{holes}:{})}},prior)
 return orientPhysicalFaces(element.material?{...result,materials:result.materials.map(role=>role==='plinth'?'plinth':element.material!)}:result)
}
