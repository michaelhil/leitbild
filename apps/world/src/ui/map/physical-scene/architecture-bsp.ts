import type { PhysicalSceneBounds } from '../../../core/packs/scene.ts'
import type { Vector3 } from './math.ts'
import { createPhysicalSpatialIndex, visitPhysicalSpatialBounds, physicalSpatialBoundsOverlap } from './spatial-index.ts'
import type { PhysicalArchitectureBsp, PhysicalArchitectureBspFragment, PhysicalArchitectureBspInput, PhysicalArchitectureBspNode } from './architecture-bsp-types.ts'

/** common xyz, source normal xyz, source-local xyz. Discrete attributes live on
 * the primitive: interpolating a flat material/owner would change its meaning. */
type Vertex = readonly [number, number, number, number, number, number, number, number, number]
interface Plane { readonly points: readonly [Vector3, Vector3, Vector3]; readonly normal: Vector3; readonly axes: readonly [number, number] }
interface Polygon { readonly vertices: readonly Vertex[]; readonly plane: Plane; readonly owner: number; readonly material: string; readonly ordinal: number }
interface Line { readonly vertices: readonly [Vertex, Vertex]; readonly owner: number; readonly material: string; readonly style: 'feature' | 'context' | 'section'; readonly ordinal: number }
interface Region { readonly vertices: readonly Vertex[]; readonly blockers: readonly number[] }
const position = (v: Vertex): Vector3 => [v[0], v[1], v[2]]
const cross = (a: Vector3, b: Vector3): Vector3 => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]
const subtract = (a: Vector3,b: Vector3): Vector3 => [a[0]-b[0],a[1]-b[1],a[2]-b[2]]
const makePlane = (a: Vector3,b: Vector3,c: Vector3): Plane | null => {
  const normal=cross(subtract(b,a),subtract(c,a)), magnitude=normal.map(Math.abs), axis=magnitude[0]!>=magnitude[1]!&&magnitude[0]!>=magnitude[2]!?0:magnitude[1]!>=magnitude[2]!?1:2
  if(normal[axis]===0) return null
  if(!normal.every(Number.isFinite)) throw new Error('Architecture BSP plane arithmetic is not finite')
  return {points:[a,b,c],normal,axes:[(axis+1)%3,(axis+2)%3]}
}
/** Same product-relative orient3d uncertainty policy as the admitted display
 * ownership pass. No distance tolerance, plane rounding or geometry snapping. */
const signedDistance = (plane: Plane,p: Vector3): number => {
  const [a,b,c]=plane.points, ax=a[0]-p[0],ay=a[1]-p[1],az=a[2]-p[2],bx=b[0]-p[0],by=b[1]-p[1],bz=b[2]-p[2],cx=c[0]-p[0],cy=c[1]-p[1],cz=c[2]-p[2]
  const p0=bx*cy,p1=cx*by,p2=cx*ay,p3=ax*cy,p4=ax*by,p5=bx*ay
  const determinant=az*(p0-p1)+bz*(p2-p3)+cz*(p4-p5),permanent=Math.abs(az)*(Math.abs(p0)+Math.abs(p1))+Math.abs(bz)*(Math.abs(p2)+Math.abs(p3))+Math.abs(cz)*(Math.abs(p4)+Math.abs(p5))
  if(!Number.isFinite(determinant)||!Number.isFinite(permanent)) throw new Error('Architecture BSP classification arithmetic is not finite')
  return Math.abs(determinant)<=(7+56*Number.EPSILON)*Number.EPSILON*permanent?0:-determinant
}
const distance2 = (a: Vertex,b: Vertex,p: Vertex,axes: readonly [number,number]): number => {
  const [x,y]=axes,left=(b[x]!-a[x]!)*(p[y]!-a[y]!),right=(b[y]!-a[y]!)*(p[x]!-a[x]!),value=left-right
  return Math.abs(value)<=(3+16*Number.EPSILON)*Number.EPSILON*(Math.abs(left)+Math.abs(right))?0:value
}
const polygonArea = (vertices: readonly Vertex[],axes: readonly [number,number]): number => {
  let sum=0,magnitude=0
  for(let i=1;i<vertices.length-1;i++){const value=distance2(vertices[0]!,vertices[i]!,vertices[i+1]!,axes);sum+=value;magnitude+=Math.abs(value)}
  return Math.abs(sum)>(vertices.length*4+2)*Number.EPSILON*magnitude?Math.abs(sum)/2:0
}
const interpolate = (a: Vertex,b: Vertex,fraction: number): Vertex => a.map((value,index)=>value+(b[index]!-value)*fraction) as unknown as Vertex
const splitPolygon = (vertices: readonly Vertex[],distances: readonly number[]): {front: readonly Vertex[];back: readonly Vertex[]} => {
  const front: Vertex[]=[],back: Vertex[]=[]
  for(let index=0;index<vertices.length;index++){
    const a=vertices[index]!,b=vertices[(index+1)%vertices.length]!,da=distances[index]!,db=distances[(index+1)%vertices.length]!
    if(da>=0)front.push(a);if(da<=0)back.push(a)
    if(da>0&&db<0||da<0&&db>0){const cut=interpolate(a,b,da/(da-db));front.push(cut);back.push(cut)}
  }
  return {front,back}
}
const bounds = (vertices: readonly Vertex[]): PhysicalSceneBounds => {
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity]
  for(const v of vertices)for(let axis=0;axis<3;axis++){min[axis]=Math.min(min[axis]!,v[axis]!);max[axis]=Math.max(max[axis]!,v[axis]!)}
  return {min:min as [number,number,number],max:max as [number,number,number]}
}
const partitionRegion = (region: Region,cover: Polygon): {readonly regions: readonly Region[];readonly overlap: boolean} => {
  if(region.blockers.includes(cover.owner))return {regions:[region],overlap:false}
  const axes=cover.plane.axes,orientation=Math.sign(cover.plane.normal[3-axes[0]-axes[1]]!),pieces: Region[]=[]
  let remaining=region.vertices
  for(let edge=0;edge<cover.vertices.length&&remaining.length;edge++){
    const distances=remaining.map(v=>distance2(cover.vertices[edge]!,cover.vertices[(edge+1)%cover.vertices.length]!,v,axes)*orientation)
    if(distances.every(value=>value>=0))continue
    if(distances.every(value=>value<=0))return {regions:[region],overlap:false}
    const result=splitPolygon(remaining,distances)
    if(polygonArea(result.back,axes)>0)pieces.push({vertices:result.back,blockers:region.blockers})
    remaining=result.front
  }
  if(!(polygonArea(remaining,axes)>0))return {regions:[region],overlap:false}
  pieces.push({vertices:remaining,blockers:[...region.blockers,cover.owner]})
  return {regions:pieces,overlap:true}
}
const transformVertex = (source: ArrayLike<number>,at: number,matrix: ArrayLike<number>,normal=true): Vertex => {
  const x=source[at]!,y=source[at+1]!,z=source[at+2]!
  const common=[matrix[0]!*x+matrix[4]!*y+matrix[8]!*z+matrix[12]!,matrix[1]!*x+matrix[5]!*y+matrix[9]!*z+matrix[13]!,matrix[2]!*x+matrix[6]!*y+matrix[10]!*z+matrix[14]!]
  if(!common.every(Number.isFinite))throw new Error('Architecture BSP placement arithmetic is not finite')
  return [common[0]!,common[1]!,common[2]!,normal?source[at+3]!:0,normal?source[at+4]!:0,normal?source[at+5]!:0,x,y,z]
}
const validateInput = (input: PhysicalArchitectureBspInput): void => {
  if(typeof input.key!=='string'||!input.key)throw new Error('Architecture BSP requires an exact cohort key')
  const ids=new Set<string>()
  for(const source of input.sources){
    if(!source.id||ids.has(source.id)||!source.sceneId||!source.assetKey||!source.occurrenceId||!Number.isInteger(source.meshIndex)||source.meshIndex<0)throw new Error('Architecture BSP source provenance is invalid or duplicated')
    ids.add(source.id)
    if(source.matrix.length!==16||!Array.from(source.matrix).every(Number.isFinite)||source.matrix[3]!==0||source.matrix[7]!==0||source.matrix[11]!==0||source.matrix[15]!==1)throw new Error('Architecture BSP requires a finite affine placement matrix')
    if(source.vertices.length%21||source.lines.length%6||!Array.from(source.vertices).every(Number.isFinite)||!Array.from(source.lines).every(Number.isFinite))throw new Error('Architecture BSP source numeric buffers are invalid')
    if(!source.materials.length||source.materials.some(value=>typeof value!=='string'||!value))throw new Error('Architecture BSP source materials are invalid')
    for(let at=6;at<source.vertices.length;at+=7)if(!Number.isInteger(source.vertices[at])||!source.materials[source.vertices[at]!])throw new Error('Architecture BSP material index is invalid')
    if(source.lineMaterials&&source.lineMaterials.length!==source.lines.length/6||source.lineStyles&&source.lineStyles.length!==source.lines.length/6)throw new Error('Architecture BSP authored line metadata is invalid')
    if(source.lineMaterials?.some(value=>typeof value!=='string'||!value)||source.lineStyles?.some(value=>!['feature','context','section'].includes(value)))throw new Error('Architecture BSP authored line role is invalid')
  }
}

/** Pick an actual primitive plane near each coordinate median. The dimension-
 * derived candidates and balance/split work score affect construction cost only:
 * every primitive is partitioned; no object/plane/fragment population is capped. */
const choosePlane = (polygons: readonly Polygon[],lines: readonly Line[]): Plane => {
  if(!polygons.length){
    const [a,b]=lines[0]!.vertices,direction=subtract(position(b),position(a)),magnitudes=direction.map(Math.abs),axis=magnitudes.indexOf(Math.min(...magnitudes)),c=[a[0],a[1],a[2]];c[axis]=a[axis]===0?1:0
    const plane=makePlane(position(a),position(b),c as unknown as Vector3)
    if(!plane)throw new Error('Architecture BSP line cannot define a partition')
    return plane
  }
  const groups: Polygon[][]=[[],[],[]]
  for(const polygon of polygons){const axis=3-polygon.plane.axes[0]-polygon.plane.axes[1];groups[axis]!.push(polygon)}
  let selected=polygons[0]!.plane,score=Infinity
  for(let axis=0;axis<3;axis++){
    const group=groups[axis]!;if(!group.length)continue
    group.sort((a,b)=>{const ac=a.vertices.reduce((s,v)=>s+v[axis]!,0)/a.vertices.length,bc=b.vertices.reduce((s,v)=>s+v[axis]!,0)/b.vertices.length;return ac-bc||a.owner-b.owner||a.ordinal-b.ordinal})
    const candidate=group[Math.floor(group.length/2)]!.plane
    let front=0,back=0,splits=0
    for(const polygon of polygons){let positive=false,negative=false;for(const v of polygon.vertices){const d=polygon.plane===candidate?0:signedDistance(candidate,position(v));positive||=d>0;negative||=d<0}if(positive)front++;if(negative)back++;if(positive&&negative)splits++}
    const candidateScore=Math.max(front,back)+splits
    if(candidateScore<score){score=candidateScore;selected=candidate}
  }
  return selected
}

/** Build one global BSP over the exact active cohort, retaining all placement
 * alternatives. Source geometry and supplied normals are never changed. */
export const preparePhysicalArchitectureBsp = (input: PhysicalArchitectureBspInput): PhysicalArchitectureBsp => {
  validateInput(input)
  const polygons: Polygon[]=[],lines: Line[]=[]
  let inputTriangles=0,inputLines=0,splitPolygons=0,splitLines=0,coplanarOverlaps=0,retainedAlternatives=0
  input.sources.forEach((source,owner)=>{
    for(let at=0;at<source.vertices.length;at+=21){
      const vertices=[transformVertex(source.vertices,at,source.matrix),transformVertex(source.vertices,at+7,source.matrix),transformVertex(source.vertices,at+14,source.matrix)],plane=makePlane(position(vertices[0]!),position(vertices[1]!),position(vertices[2]!))
      inputTriangles++;if(!plane)continue // A zero-area input triangle paints no samples.
      polygons.push({vertices,plane,owner,material:source.materials[source.vertices[at+20]!]!,ordinal:at/21})
    }
    for(let at=0;at<source.lines.length;at+=6){
      const a=transformVertex(source.lines,at,source.matrix,false),b=transformVertex(source.lines,at+3,source.matrix,false);inputLines++
      if(a[0]===b[0]&&a[1]===b[1]&&a[2]===b[2])continue
      lines.push({vertices:[a,b],owner,material:source.lineMaterials?.[at/6]??source.materials[0]!,style:source.lineStyles?.[at/6]??'feature',ordinal:at/6})
    }
  })
  const nodes: PhysicalArchitectureBspNode[]=[],fragments: PhysicalArchitectureBspFragment[]=[],values: number[]=[]
  const append = (vertices: readonly Vertex[],kind: 'triangle'|'line',ownerIndex: number,material: string,occludedBy: readonly number[],strokeStyle?: Line['style']): number => {
    const first=values.length/9
    if(kind==='line')for(const vertex of vertices)values.push(...vertex)
    else for(let corner=1;corner<vertices.length-1;corner++)for(const vertex of [vertices[0]!,vertices[corner]!,vertices[corner+1]!])values.push(...vertex)
    const id=fragments.length;fragments.push({kind,ownerIndex,material,first,count:values.length/9-first,occludedBy,...(strokeStyle?{strokeStyle}:{})});return id
  }
  interface Task {readonly polygons: readonly Polygon[];readonly lines: readonly Line[];readonly parent: number;readonly side: 'front'|'back'}
  const tasks: Task[]=[{polygons,lines,parent:-1,side:'front'}]
  let root=-1
  while(tasks.length){
    const task=tasks.pop()!;if(!task.polygons.length&&!task.lines.length)continue
    const plane=choosePlane(task.polygons,task.lines),front: Polygon[]=[],back: Polygon[]=[],on: Polygon[]=[],frontLines: Line[]=[],backLines: Line[]=[],onLines: Line[]=[]
    const nodeIndex=nodes.length;nodes.push({plane:plane.points,normal:plane.normal,front:-1,back:-1,fragments:[]})
    if(task.parent<0)root=nodeIndex;else nodes[task.parent]={...nodes[task.parent]!,[task.side]:nodeIndex}
    for(const polygon of task.polygons){
      const distances=polygon.vertices.map(v=>polygon.plane===plane?0:signedDistance(plane,position(v))),positive=distances.some(value=>value>0),negative=distances.some(value=>value<0)
      if(!positive&&!negative)on.push(polygon)
      else if(!negative)front.push(polygon)
      else if(!positive)back.push(polygon)
      else{const result=splitPolygon(polygon.vertices,distances);if(polygonArea(result.front,polygon.plane.axes)>0)front.push({...polygon,vertices:result.front});if(polygonArea(result.back,polygon.plane.axes)>0)back.push({...polygon,vertices:result.back});splitPolygons++}
    }
    for(const line of task.lines){
      const a=line.vertices[0],b=line.vertices[1],da=signedDistance(plane,position(a)),db=signedDistance(plane,position(b))
      if(da===0&&db===0)onLines.push(line)
      else if(da>=0&&db>=0)frontLines.push(line)
      else if(da<=0&&db<=0)backLines.push(line)
      else{const cut=interpolate(a,b,da/(da-db));if(da>0){frontLines.push({...line,vertices:[a,cut]});backLines.push({...line,vertices:[cut,b]})}else{backLines.push({...line,vertices:[a,cut]});frontLines.push({...line,vertices:[cut,b]})}splitLines++}
    }
    // Coplanar polygon order is the explicit first-source display tie. Retain
    // later overlap patches with conditional blockers instead of blending twice.
    on.sort((a,b)=>a.owner-b.owner||a.ordinal-b.ordinal)
    const onBounds=on.map(polygon=>bounds(polygon.vertices)),index=createPhysicalSpatialIndex(onBounds,'overlap'),nodeFragments: number[]=[]
    on.forEach((polygon,ordinal)=>{
      const candidates: number[]=[]
      visitPhysicalSpatialBounds(index,onBounds[ordinal]!,candidate=>{if(candidate>=ordinal||!physicalSpatialBoundsOverlap(onBounds[ordinal]!,onBounds[candidate]!))return;const axes=plane.axes,a=onBounds[ordinal]!,b=onBounds[candidate]!;if(axes.some(axis=>Math.min(a.max[axis]!,b.max[axis]!)<=Math.max(a.min[axis]!,b.min[axis]!)))return;candidates.push(candidate)})
      candidates.sort((a,b)=>a-b)
      let regions: readonly Region[]=[{vertices:polygon.vertices,blockers:[]}]
      for(const candidate of candidates){const cover=on[candidate]!,next: Region[]=[];for(const region of regions){const result=partitionRegion(region,cover);if(result.overlap)coplanarOverlaps++;for(const piece of result.regions)if(!piece.blockers.includes(polygon.owner))next.push(piece)}regions=next;if(!regions.length)break}
      for(const region of regions){if(region.blockers.length)retainedAlternatives++;nodeFragments.push(append(region.vertices,'triangle',polygon.owner,polygon.material,region.blockers))}
    })
    onLines.sort((a,b)=>a.owner-b.owner||a.ordinal-b.ordinal)
    for(const line of onLines)nodeFragments.push(append(line.vertices,'line',line.owner,line.material,[],line.style))
    nodes[nodeIndex]={...nodes[nodeIndex]!,fragments:nodeFragments}
    tasks.push({polygons:back,lines:backLines,parent:nodeIndex,side:'back'},{polygons:front,lines:frontLines,parent:nodeIndex,side:'front'})
  }
  const vertices=new Float64Array(values)
  return {key:input.key,owners:input.sources.map(({id,sceneId,assetKey,meshIndex,occurrenceId})=>({id,sceneId,assetKey,meshIndex,occurrenceId})),vertices,fragments,nodes,root,diagnostics:{inputTriangles,inputLines,splitPolygons,splitLines,coplanarOverlaps,retainedAlternatives,vertexBytes:vertices.byteLength}}
}

/** Homogeneous point toward the camera: perspective w != 0, orthographic w=0.
 * Iteration avoids a JS recursion limit for a legitimate deep source partition. */
export const orderedPhysicalArchitectureFragments = (bsp: PhysicalArchitectureBsp,eye: readonly [number,number,number,number],visibleOwners: ReadonlySet<number>): readonly number[] => {
  if(eye.length!==4||!eye.every(Number.isFinite))throw new Error('Architecture BSP requires a finite homogeneous camera')
  const result: number[]=[],stack: Array<{node:number;emit:boolean}>=bsp.root<0?[]:[{node:bsp.root,emit:false}]
  while(stack.length){const task=stack.pop()!,node=bsp.nodes[task.node]!;if(task.emit){for(const id of node.fragments){const fragment=bsp.fragments[id]!;if(visibleOwners.has(fragment.ownerIndex)&&!fragment.occludedBy.some(owner=>visibleOwners.has(owner)))result.push(id)}continue}
    const w=eye[3],a=node.plane[0],direction=w===0?[eye[0],eye[1],eye[2]]:[eye[0]/w-a[0],eye[1]/w-a[1],eye[2]/w-a[2]],side=node.normal[0]*direction[0]!+node.normal[1]*direction[1]!+node.normal[2]*direction[2]!
    const far=side>=0?node.back:node.front,near=side>=0?node.front:node.back
    if(near>=0)stack.push({node:near,emit:false});stack.push({node:task.node,emit:true});if(far>=0)stack.push({node:far,emit:false})
  }
  return result
}
