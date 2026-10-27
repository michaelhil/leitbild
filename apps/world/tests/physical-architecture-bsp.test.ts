import { expect, test } from 'bun:test'
import { orderedPhysicalArchitectureFragments as ordered, preparePhysicalArchitectureBsp as prepare } from '../src/ui/map/physical-scene/architecture-bsp.ts'
import type { PhysicalArchitectureBsp, PhysicalArchitectureBspSource } from '../src/ui/map/physical-scene/architecture-bsp-types.ts'
const identity = new Float64Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1])
const source=(id:string,positions:readonly number[],extra:Partial<PhysicalArchitectureBspSource>={}):PhysicalArchitectureBspSource=>({id,sceneId:id,assetKey:'asset',meshIndex:0,occurrenceId:id,matrix:identity,vertices:positions.flatMap((v,i)=>i%3===0?[v,positions[i+1]!,positions[i+2]!,0,0,1,0]:[]),lines:[],materials:['material'],...extra})
const quad=(id:string,x0:number,y0:number,x1:number,y1:number,z=0,reverse=false)=>source(id,reverse?[x0,y0,z,x1,y0,z,x0,y1,z,x1,y0,z,x1,y1,z,x0,y1,z]:[x0,y0,z,x1,y0,z,x1,y1,z,x0,y0,z,x1,y1,z,x0,y1,z])
const area=(bsp:PhysicalArchitectureBsp,owner:number,visible=new Set(bsp.owners.map((_,i)=>i)))=>ordered(bsp,[0,0,10,1],visible).reduce((sum,id)=>{const f=bsp.fragments[id]!;if(f.kind!=='triangle'||f.ownerIndex!==owner)return sum;for(let v=f.first;v<f.first+f.count;v+=3){const p=bsp.vertices,a=v*9,b=(v+1)*9,c=(v+2)*9;sum+=Math.abs((p[b]!-p[a]!)*(p[c+1]!-p[a+1]!)-(p[c]!-p[a]!)*(p[b+1]!-p[a+1]!))/2}return sum},0)
const owners=(bsp:PhysicalArchitectureBsp,eye:readonly[number,number,number,number])=>ordered(bsp,eye,new Set(bsp.owners.map((_,i)=>i))).map(id=>bsp.fragments[id]!.ownerIndex)

test('global placement depth order is camera dependent and homogeneous, without changing source buffers',()=>{
 const back=quad('back',-1,-1,1,1),front=quad('front',-1,-1,1,1);const matrix=identity.slice();matrix[14]=2;const input={key:'cohort',sources:[{...front,matrix},back]},before=JSON.stringify(input),bsp=prepare(input)
 expect(owners(bsp,[0,0,10,1])).toEqual([1,1,0,0]);expect(owners(bsp,[0,0,-10,1])).toEqual([0,0,1,1]);expect(owners(bsp,[0,0,-20,-2])).toEqual(owners(bsp,[0,0,10,1]));expect(owners(bsp,[0,0,1,0])).toEqual([1,1,0,0]);expect(JSON.stringify(input)).toBe(before)
})

test('partial coincident overlap retains alternatives and source-first ownership across independent placements',()=>{
 const first=quad('first',-.6,-.6,.6,.6),later=quad('later',-.8,-.3,.8,.3,0,true),bsp=prepare({key:'overlap',sources:[first,later]})
 expect(area(bsp,0)).toBeCloseTo(1.44,12);expect(area(bsp,1)).toBeCloseTo(.24,12);expect(area(bsp,1,new Set([1]))).toBeCloseTo(.96,12);expect(bsp.diagnostics.coplanarOverlaps).toBeGreaterThan(0);expect(bsp.diagnostics.retainedAlternatives).toBeGreaterThan(0)
})

test('holes and reversed winding preserve actual uncovered area',()=>{
 const ring=[quad('top',-.8,.3,.8,.8),quad('bottom',-.8,-.8,.8,-.3),quad('left',-.8,-.3,-.3,.3),quad('right',.3,-.3,.8,.3)],background=quad('background',-.9,-.9,.9,.9,0,true)
 const vertices=Array.from(background.vertices);for(let at=0;at<vertices.length;at+=21){const b=vertices.slice(at+7,at+14);vertices.copyWithin(at+7,at+14,at+21);vertices.splice(at+14,7,...b)}
 const bsp=prepare({key:'holes',sources:[...ring,{...background,vertices}]});expect(area(bsp,4)).toBeCloseTo(1.04,12)
})

test('same-owner coplanar triangle overlap resolves the original last-vertex material without double blending',()=>{
 const a=quad('one',-.6,-.6,.6,.6),b=quad('unused',-.8,-.3,.8,.3,0,true),vertices=[...Array.from(a.vertices),...Array.from(b.vertices)];for(let at=Array.from(a.vertices).length+6;at<vertices.length;at+=7)vertices[at]=1
 // The original flat GLSL material comes from the provoking LAST vertex.
 vertices[6]=1;vertices[13]=1;vertices[20]=0
 const bsp=prepare({key:'compound',sources:[{...a,vertices,materials:['earlier','later']}]});expect(area(bsp,0)).toBeCloseTo(1.68,12)
 const roles=new Set(bsp.fragments.map(f=>f.material));expect(roles).toEqual(new Set(['earlier','later']));expect(bsp.fragments.some(f=>f.occludedBy.includes(f.ownerIndex))).toBe(false)
})

const sampleDepths=(bsp:PhysicalArchitectureBsp,x:number,y:number):number[]=>{
 const depths:number[]=[];for(const id of ordered(bsp,[0,0,1,0],new Set(bsp.owners.map((_,i)=>i)))){const f=bsp.fragments[id]!;if(f.kind!=='triangle')continue;for(let at=f.first;at<f.first+f.count;at+=3){const v=bsp.vertices,a=at*9,b=(at+1)*9,c=(at+2)*9,den=(v[b+1]!-v[c+1]!)*(v[a]!-v[c]!)+(v[c]!-v[b]!)*(v[a+1]!-v[c+1]!);if(den===0)continue;const u=((v[b+1]!-v[c+1]!)*(x-v[c]!)+(v[c]!-v[b]!)*(y-v[c+1]!))/den,w=((v[c+1]!-v[a+1]!)*(x-v[c]!)+(v[a]!-v[c]!)*(y-v[c+1]!))/den,t=1-u-w;if(u>0&&w>0&&t>0)depths.push(u*v[a+2]!+w*v[b+2]!+t*v[c+2]!)} }return depths
}
test('intersecting cyclic architecture splits into a correct global painter order at every sampled ray',()=>{
 const positions=[-2,-2,0,2,-2,0,0,2,0],surfaces=[(x:number,y:number)=>x,(x:number,y:number)=>y,(x:number,y:number)=>-x-y],sources=surfaces.map((height,i)=>source(String(i),positions.map((v,j)=>j%3===2?height(positions[j-2]!,positions[j-1]!):v))),bsp=prepare({key:'crossing',sources})
 let rays=0;for(let x=-1.7;x<1.7;x+=.137)for(let y=-1.7;y<1.7;y+=.193){const depths=sampleDepths(bsp,x,y);for(let i=1;i<depths.length;i++)expect(depths[i]!).toBeGreaterThanOrEqual(depths[i-1]!-1e-12);if(depths.length===3)rays++}expect(rays).toBeGreaterThan(100);expect(bsp.diagnostics.splitPolygons).toBeGreaterThan(0)
})

test('splitting preserves affine source positions, original normal interpolation, material and authored line intent',()=>{
 const wall=source('wall',[0,-2,-2,0,2,-2,0,0,2]),floor=source('floor',[-2,-1,0,2,-1,0,0,2,0],{lines:[-2,.2,0,2,.2,0],lineMaterials:['ink'],lineStyles:['section']}),matrix=identity.slice();matrix[0]=2;matrix[5]=3;matrix[12]=10;matrix[13]=-4
 const bsp=prepare({key:'attributes',sources:[{...wall,matrix},{...floor,matrix}]})
 for(let at=0;at<bsp.vertices.length;at+=9){expect(bsp.vertices[at]!).toBeCloseTo(bsp.vertices[at+6]!*2+10,12);expect(bsp.vertices[at+1]!).toBeCloseTo(bsp.vertices[at+7]!*3-4,12);expect(bsp.vertices[at+2]!).toBeCloseTo(bsp.vertices[at+8]!,12)}
 const lines=bsp.fragments.filter(f=>f.kind==='line');expect(lines.length).toBeGreaterThan(1);let length=0;for(const f of lines){expect(f.material).toBe('ink');expect(f.strokeStyle).toBe('section');expect(f.count).toBe(2);const at=f.first*9;expect(bsp.vertices[at+7]!).toBeCloseTo(.2,12);expect(bsp.vertices[at+16]!).toBeCloseTo(.2,12);length+=Math.abs(bsp.vertices[at+9]!-bsp.vertices[at]!)}expect(length).toBeCloseTo(8,12)
})

test('on-plane faces paint before authored feature lines and hidden faces do not create new cut strokes',()=>{
 const a=quad('wall',-1,-1,1,1),bsp=prepare({key:'strokes',sources:[{...a,lines:[-1,0,0,1,0,0]}]}),order=ordered(bsp,[0,0,2,1],new Set([0]))
 expect(order.map(id=>bsp.fragments[id]!.kind)).toEqual(['triangle','triangle','line']);expect(bsp.fragments.filter(f=>f.kind==='line')).toHaveLength(1)
})

test('near-but-distinct planes remain distinct at large representable coordinates without metric epsilon',()=>{
 const a=quad('a',-1,-1,1,1),b=quad('b',-1,-1,1,1,1e-8),matrix=identity.slice();matrix[12]=1e6;matrix[13]=1e6;matrix[14]=1e6;const bsp=prepare({key:'close',sources:[{...a,matrix},{...b,matrix}]})
 expect(bsp.diagnostics.coplanarOverlaps).toBe(0);expect(owners(bsp,[1e6,1e6,1e6+10,1])).toEqual([0,0,1,1])
})

test('empty and line-only cohorts are real supported inputs; malformed identity/numbers fail explicitly',()=>{
 const empty=prepare({key:'empty',sources:[]});expect(empty.root).toBe(-1);expect(ordered(empty,[0,0,1,0],new Set())).toEqual([])
 const lines=prepare({key:'lines',sources:[source('near',[],{lines:[0,0,2,1,0,2]}),source('far',[],{lines:[0,0,0,1,0,0]})]});expect(owners(lines,[0,0,1,0])).toEqual([1,0])
 const one=quad('id',0,0,1,1);expect(()=>prepare({key:'bad',sources:[one,one]})).toThrow('provenance');expect(()=>prepare({key:'bad',sources:[{...one,vertices:[NaN]}]})).toThrow('numeric');expect(()=>prepare({key:'bad',sources:[{...one,matrix:[1]}]})).toThrow('affine');expect(()=>ordered(empty,[0,0,NaN,1],new Set())).toThrow('camera')
})


test('repeatedly split authored lines retain their support plane and exact zero remnants create no false stroke',()=>{
 const x=Number.MIN_VALUE,wall=source('wall',[x,0,0,x,1,0,x,0,1]),line=source('line',[],{lines:[1,.2,.2,0,.2,.2]}),bsp=prepare({key:'rounded-line-remnant',sources:[wall,line]}),fragments=bsp.fragments.filter(f=>f.kind==='line')
 expect(fragments).toHaveLength(1);expect(fragments[0]!.count).toBe(2);expect(bsp.vertices[(fragments[0]!.first+1)*9]).toBe(0)
})

test('homogeneous camera comparison avoids division by a tiny finite w',()=>{
 const bsp=prepare({key:'camera-at-infinity',sources:[quad('far',-1,-1,1,1),quad('near',-1,-1,1,1,2)]})
 expect(owners(bsp,[1,0,1,Number.MIN_VALUE])).toEqual(owners(bsp,[1,0,1,0]));expect(()=>ordered(bsp,[0,0,0,0],new Set())).toThrow('camera')
})
