// Authoring only: robust Boolean operations never enter the scene/browser compiler.
import polygonClipping from 'polygon-clipping'
import { circulationNetworkSchema, type CirculationNetwork } from '../native/explorer/circulation.ts'

type Point = [number, number]
type Road = { id: string; path: Point[]; width: number; class: 'service' | 'access' | 'pedestrian'; turnRadius: number }
const key = (p: Point): string => p.map(value => Math.round(value * 1e6) / 1e6).join(',')
const distance = (a: Point, b: Point): number => Math.hypot(b[0] - a[0], b[1] - a[1])
const pointAt = (a: Point, b: Point, t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
const cross = (a: Point, b: Point): number => a[0] * b[1] - a[1] * b[0]

/** Split centreline intersections into explicit shared physical junction identities. */
export const circulationFromPaths = (roads: readonly Road[], entrance: Point, surfaceTolerance = .05): CirculationNetwork => {
  const cuts = roads.map(road => new Map<number, Point>([[0, road.path[0]!], [road.path.length - 1, road.path.at(-1)!]]))
  roads.forEach((road,r)=>{for(let i=0;i<road.path.length-1;i++){
    const a=road.path[i]!,b=road.path[i+1]!,ab:Point=[b[0]-a[0],b[1]-a[1]],ap:Point=[entrance[0]-a[0],entrance[1]-a[1]]
    const t=(ap[0]*ab[0]+ap[1]*ab[1])/(ab[0]*ab[0]+ab[1]*ab[1])
    if(Math.abs(cross(ap,ab))<1e-7&&t>=0&&t<=1)cuts[r]!.set(i+t,entrance)
  }})
  for (let r = 0; r < roads.length; r++) for (let s = r + 1; s < roads.length; s++) {
    // A pedestrian crossing is not a vehicle-road junction or a vehicle bend.
    if ((roads[r]!.class === 'pedestrian') !== (roads[s]!.class === 'pedestrian')) continue
    const aPath = roads[r]!.path, bPath = roads[s]!.path
    for (let i = 0; i < aPath.length - 1; i++) for (let j = 0; j < bPath.length - 1; j++) {
      const a = aPath[i]!, b = aPath[i + 1]!, c = bPath[j]!, d = bPath[j + 1]!
      const ab: Point = [b[0] - a[0], b[1] - a[1]], cd: Point = [d[0] - c[0], d[1] - c[1]], ac: Point = [c[0] - a[0], c[1] - a[1]], denominator = cross(ab, cd)
      if (Math.abs(denominator) < 1e-10) {
        // Collinear endpoint-on-route cases are shared junctions too.
        if (Math.abs(cross(ac, ab)) > 1e-7) continue
        for (const p of [a,b,c,d]) {
          const ta = ((p[0]-a[0])*ab[0]+(p[1]-a[1])*ab[1])/(ab[0]*ab[0]+ab[1]*ab[1])
          const tb = ((p[0]-c[0])*cd[0]+(p[1]-c[1])*cd[1])/(cd[0]*cd[0]+cd[1]*cd[1])
          if (ta >= -1e-8 && ta <= 1+1e-8 && tb >= -1e-8 && tb <= 1+1e-8) { cuts[r]!.set(i+Math.min(1,Math.max(0,ta)),p); cuts[s]!.set(j+Math.min(1,Math.max(0,tb)),p) }
        }
        continue
      }
      const ta = cross(ac, cd) / denominator, tb = cross(ac, ab) / denominator
      if (ta < -1e-8 || ta > 1+1e-8 || tb < -1e-8 || tb > 1+1e-8) continue
      const p = pointAt(a,b,Math.min(1,Math.max(0,ta)))
      cuts[r]!.set(i+Math.min(1,Math.max(0,ta)),p); cuts[s]!.set(j+Math.min(1,Math.max(0,tb)),p)
    }
  }
  const nodes = new Map<string, CirculationNetwork['nodes'][number]>()
  const node = (position: Point): string => {
    const id = `junction:${key(position)}`
    if (!nodes.has(id)) nodes.set(id,{id,position:position.map(v=>Math.round(v*1e6)/1e6) as Point,kind:key(position)===key(entrance)?'entrance':'terminal'})
    return id
  }
  const edges: CirculationNetwork['edges'] = []
  roads.forEach((road,index)=>{
    const splits=[...cuts[index]!.entries()].sort(([a],[b])=>a-b)
    for(let s=0;s<splits.length-1;s++){
      const [start,a]=splits[s]!,[end,b]=splits[s+1]!
      if(distance(a,b)<1e-7 && end-start<1e-7)continue
      const from=node(a),to=node(b),middle=road.path.filter((_,i)=>i>start+1e-8&&i<end-1e-8)
      edges.push({id:`${road.id}/${s}`,from,to,width:road.width,class:road.class,turnRadius:road.turnRadius,path:[nodes.get(from)!.position,...middle,nodes.get(to)!.position]})
    }
  })
  for(const n of nodes.values())if(n.kind!=='entrance'&&edges.filter(edge=>edge.from===n.id||edge.to===n.id).length>1)n.kind='junction'
  return circulationNetworkSchema.parse({surfaceTolerance,nodes:[...nodes.values()],edges})
}

/** Circular tangent bends are authored in metres; precision follows a chord-error tolerance. */
export const roundedCentreline = (path: readonly Point[], radius: number, tolerance: number): Point[] => {
  const tangentAt=(i:number):number=>{
    if(i===0||i===path.length-1)return 0
    const a=path[i-1]!,b=path[i]!,c=path[i+1]!,u=distance(a,b),v=distance(b,c)
    return radius*Math.tan(Math.acos(Math.max(-1,Math.min(1,((b[0]-a[0])*(c[0]-b[0])+(b[1]-a[1])*(c[1]-b[1]))/u/v)))/2)
  }
  for(let i=0;i<path.length-1;i++)if(tangentAt(i)+tangentAt(i+1)>distance(path[i]!,path[i+1]!)+1e-7)throw new Error('The authored turning radius does not fit its centreline; revise the route')
  const result: Point[]=[path[0]!]
  for(let i=1;i<path.length-1;i++){
    const a=path[i-1]!,b=path[i]!,c=path[i+1]!,inLength=distance(a,b),outLength=distance(b,c)
    const u:Point=[(b[0]-a[0])/inLength,(b[1]-a[1])/inLength],v:Point=[(c[0]-b[0])/outLength,(c[1]-b[1])/outLength]
    const angle=Math.acos(Math.max(-1,Math.min(1,u[0]*v[0]+u[1]*v[1]))),direction=Math.sign(cross(u,v))
    if(angle<1e-7){result.push(b);continue}
    if(!direction||angle>Math.PI-1e-7)throw new Error('A circulation path cannot reverse at a corner')
    const tangent=radius*Math.tan(angle/2)
    const start:Point=[b[0]-u[0]*tangent,b[1]-u[1]*tangent],end:Point=[b[0]+v[0]*tangent,b[1]+v[1]*tangent]
    const centre:Point=[start[0]-u[1]*radius*direction,start[1]+u[0]*radius*direction],first=Math.atan2(start[1]-centre[1],start[0]-centre[0])
    const steps=Math.max(1,Math.ceil(angle/(2*Math.acos(Math.max(-1,1-tolerance/radius)))))
    for(let step=0;step<=steps;step++){const t=first+direction*angle*step/steps;result.push([centre[0]+radius*Math.cos(t),centre[1]+radius*Math.sin(t)])}
    result[result.length-1]=end
  }
  result.push(path.at(-1)!)
  return result.filter((p,i)=>!i||distance(p,result[i-1]!)>1e-8)
}
const ribbon = (path: readonly Point[], width: number): polygonClipping.Polygon => {
  const side=(direction:number):Point[]=>path.map((p,i)=>{
    const before=path[Math.max(0,i-1)]!,after=path[Math.min(path.length-1,i+1)]!
    const previous=i?[(p[0]-before[0])/distance(before,p),(p[1]-before[1])/distance(before,p)]:[(after[0]-p[0])/distance(p,after),(after[1]-p[1])/distance(p,after)]
    const next=i<path.length-1?[(after[0]-p[0])/distance(p,after),(after[1]-p[1])/distance(p,after)]:previous
    const nx=-previous[1]!-next[1]!,ny=previous[0]!+next[0]!,length=Math.hypot(nx,ny),denominator=(nx/length)*(-previous[1]!)+(ny/length)*previous[0]!
    if(!Number.isFinite(denominator)||denominator<=0)throw new Error('Invalid circulation offset; centreline folds back')
    return[p[0]+nx/length*width/2/denominator*direction,p[1]+ny/length*width/2/denominator*direction]
  })
  const ring=[...side(1),...side(-1).reverse()];ring.push([...ring[0]!] as Point)
  return[ring]
}
const disc=(point:Point,radius:number,tolerance:number):polygonClipping.Polygon=>{
  const steps=Math.max(3,Math.ceil(Math.PI/Math.acos(Math.max(-1,1-tolerance/radius))))
  const ring=Array.from({length:steps},(_,i):Point=>[point[0]+radius*Math.cos(i*2*Math.PI/steps),point[1]+radius*Math.sin(i*2*Math.PI/steps)])
  ring.push([...ring[0]!] as Point);return[ring]
}
/** One unioned surface per class; no individual segment solids or internal road seams. */
export const circulationSurfaces = (network: CirculationNetwork): Record<'roads'|'pedestrian',polygonClipping.MultiPolygon> => {
  const surface=(pedestrian:boolean):polygonClipping.MultiPolygon=>{
    const edges=network.edges.filter(edge=>(edge.class==='pedestrian')===pedestrian)
    if(!edges.length)return[]
    const polygons=edges.map(edge=>{try{return ribbon(roundedCentreline(edge.path,edge.turnRadius,network.surfaceTolerance),edge.width)}catch(error){throw new Error(`Circulation ${edge.id}: ${error instanceof Error?error.message:String(error)}`)}})
    for(const node of network.nodes){const touching=edges.filter(edge=>edge.from===node.id||edge.to===node.id);if(touching.length)polygons.push(disc(node.position,Math.max(...touching.map(edge=>edge.width))/2,network.surfaceTolerance))}
    // Use the declared civil drawing precision before Boolean predicates.
    // Nearly coincident transcendental arc endpoints otherwise produce numeric
    // slivers despite the road intent being identical at sub-millimetre scale.
    const quantum=network.surfaceTolerance/100
    const normalized=polygons.map(polygon=>polygon.map(ring=>{
      const points=ring.map(([x,y]):Point=>[Math.round(x/quantum)*quantum,Math.round(y/quantum)*quantum]).filter((p,i,a)=>!i||p[0]!==a[i-1]![0]||p[1]!==a[i-1]![1])
      if(points[0]![0]!==points.at(-1)![0]||points[0]![1]!==points.at(-1)![1])points.push([...points[0]!] as Point)
      return points
    }))
    return polygonClipping.union(normalized[0]!,...normalized.slice(1))
  }
  return{roads:surface(false),pedestrian:surface(true)}
}
