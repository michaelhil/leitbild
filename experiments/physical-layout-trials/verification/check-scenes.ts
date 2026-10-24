/** Independent geometry predicates. Does not import either contender's helpers. */
import { resolve } from 'node:path'
type V = [number,number,number]
type ObjectMesh = {id:string;positions:number[];indices:number[];bounds?:{min:number[];max:number[]}}
type Scene = {schema:string;axes:string;units:string;objects:ObjectMesh[]}
const options = Object.fromEntries(Bun.argv.slice(2).map(arg=>{const p=arg.indexOf('=');return[arg.slice(2,p),arg.slice(p+1)]}))
const root=resolve(import.meta.dir,'..'), out=resolve(options.output??`${import.meta.dir}/independent-scenes.json`)
const checks:{candidate:string;name:string;pass:boolean;detail:unknown}[]=[]
const check=(candidate:string,name:string,pass:boolean,detail:unknown={})=>checks.push({candidate,name,pass,detail})
const sub=(a:V,b:V):V=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]]
const dot=(a:V,b:V)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2]
const cross=(a:V,b:V):V=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]
function hit(mesh:ObjectMesh,origin:V,direction:V){
 const v=(i:number):V=>mesh.positions.slice(i*3,i*3+3) as V
 for(let i=0;i<mesh.indices.length;i+=3){const a=v(mesh.indices[i]!),b=v(mesh.indices[i+1]!),c=v(mesh.indices[i+2]!),e1=sub(b,a),e2=sub(c,a),h=cross(direction,e2),det=dot(e1,h);if(Math.abs(det)<1e-9)continue;const inv=1/det,s=sub(origin,a),u=inv*dot(s,h);if(u<0||u>1)continue;const q=cross(s,e1),w=inv*dot(direction,q);if(w<0||u+w>1)continue;if(inv*dot(e2,q)>1e-6)return true}
 return false
}
function bounds(o:ObjectMesh){const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];o.positions.forEach((x,i)=>{const k=i%3;min[k]=Math.min(min[k]!,x);max[k]=Math.max(max[k]!,x)});return{min,max}}
function same(a:ObjectMesh,b:ObjectMesh){return a.positions.length===b.positions.length&&a.positions.every((v,i)=>Math.abs(v-b.positions[i]!)<1e-4)}
const need=(s:Scene,id:string)=>{const o=s.objects.find(o=>o.id===id);if(!o)throw Error(`Missing independent target ${id}`);return o}
for(const candidate of ['ifc','native']){
 const base=resolve(options[candidate]??`${root}/${candidate}/output`)
 const file=(stage:string)=>candidate==='ifc'?`${base}/${stage==='base'?'baseline':stage==='move'?'move-pump':stage==='type'?'pump-type':stage==='variant'?'pump-variant':stage}/scene.json`:`${base}/${stage}/delivery/geometry.json`
 const read=async(stage:string):Promise<Scene>=>{const s=await Bun.file(file(stage)).json();return{...s,objects:s.objects.map((o:ObjectMesh)=>({...o,indices:o.indices??Array.from({length:o.positions.length/3},(_,i)=>i)}))}}
 const b=await read('base'), d=await read('door'), moved=await read('move'), roof=await read('roof'), type=await read('type'), variant=await read('variant')
 check(candidate,'delivery-frame',b.schema==='layout-trial-mesh'&&b.units==='m'&&b.axes==='Z-up')
 check(candidate,'finite-indexed-triangles',b.objects.every(o=>o.positions.length%3===0&&o.indices.length%3===0&&o.positions.every(Number.isFinite)&&o.indices.every(i=>Number.isInteger(i)&&i>=0&&i<o.positions.length/3)))
 const expected=(await Bun.file(`${root}/common/f1-original.json`).json()).equipment.map((e:{id:string})=>e.id)
 check(candidate,'all-sixteen-occurrences',expected.length===16&&expected.every((id:string)=>b.objects.some(o=>o.id===id)),{expected})
 const normal:V=[-.5,Math.sqrt(3)/2,0]
 const origin=(x:number,z:number):V=>[110+Math.cos(Math.PI/6)*x-normal[0],Math.sin(Math.PI/6)*x-normal[1],z]
 check(candidate,'rotated-wall-positive-control',hit(need(b,'edit-wall'),origin(7.7,1.2),normal))
 check(candidate,'actual-door-void',!hit(need(d,'edit-wall'),origin(7.7,1.2),normal))
 check(candidate,'existing-opening-preserved',!hit(need(d,'edit-wall'),origin(1.6,1.2),normal))
 check(candidate,'lintel-and-adjacent-solid',hit(need(d,'edit-wall'),origin(7.7,3.5),normal)&&hit(need(d,'edit-wall'),origin(5,1.2),normal))
 const before=bounds(need(b,'mfw-a')),after=bounds(need(moved,'mfw-a'))
 check(candidate,'pump-actual-two-metre-move',Math.abs(after.min[0]!-before.min[0]!-2)<1e-4&&Math.abs(after.max[0]!-before.max[0]!-2)<1e-4,{before,after})
 check(candidate,'move-preserves-other-pump',same(need(b,'mfw-b'),need(moved,'mfw-b')))
 check(candidate,'roof-preserves-deck-and-pump',same(need(b,'edit-deck'),need(roof,'edit-deck'))&&same(need(b,'mfw-a'),need(roof,'mfw-a')))
 check(candidate,'fixed-vessel-unchanged',same(need(b,'fixed-vessel'),need(roof,'fixed-vessel'))&&same(need(b,'fixed-vessel'),need(d,'fixed-vessel')))
 check(candidate,'type-updates-both-physical-solids',!same(need(b,'mfw-a'),need(type,'mfw-a'))&&!same(need(b,'mfw-b'),need(type,'mfw-b')))
 const variantBase=candidate==='native'?type:b
 check(candidate,'a-only-variant-preserves-b',!same(need(variantBase,'mfw-a'),need(variant,'mfw-a'))&&same(need(variantBase,'mfw-b'),need(variant,'mfw-b')),{declaredVariantBase:candidate==='native'?'after shared-type edit':'baseline; sequential type→variant not independently exercised here'})
}
const report={scope:'Independent exported triangle geometry only, not source/native relationship or engineering qualification',acceptedTriangleEncodings:'Explicit indices or sequential triangle vertices in the shared mesh contract',toleranceMetres:1e-4,checks,passed:checks.every(c=>c.pass)}
await Bun.write(out,JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({checks:checks.length,passed:report.passed,failures:checks.filter(c=>!c.pass),output:out},null,2))
if(!report.passed)process.exitCode=1
