import unitSource from '../pwr-full-unit.source.json'
import unitBindings from '../pwr-full-unit.bindings.json'
import unitCoverage from '../pwr-full-unit.coverage.json'
import campusSource from '../pwr-campus.source.json'
import campusBindings from '../pwr-campus.bindings.json'
import campusCoverage from '../pwr-campus.coverage.json'
import campusArrangement from '../pwr-campus.arrangement.json'
import { physicalSourceSchema, type Element } from '../native/explorer/source.ts'
import { physicalSourceSchema as previousSourceSchema } from '../native/campus/source.ts'
import { circulationFromPaths, circulationSurfaces } from './pavement.ts'

/** New admitted revision; old JSON and its original/campus compilers stay unchanged. */
export const createPwrExplorerUnitArtifacts = () => ({
  source: physicalSourceSchema.parse({ ...structuredClone(unitSource), rootScope: { id: 'unit', label: 'PWR unit', kind: 'unit' } }),
  bindings: structuredClone(unitBindings), coverage: structuredClone(unitCoverage),
})

export const createPwrExplorerCampusArtifacts = () => {
  const original = previousSourceSchema.parse(structuredClone(campusSource))
  const roads = original.elements.filter(element => element.kind === 'road').map(element => ({
    id: element.id, path: element.path!.map(point => [point[0],point[1]] as [number,number]),
    width: element.dimensions!.width, class: 'service' as 'service'|'access'|'pedestrian', turnRadius: element.dimensions!.width*1.5,
  }))
  // Deliveries use two open service branches, rather than decorative rectangular loops.
  // The common diagonal spine is retained at its proven clear setback.
  for (const road of roads) {
    if (road.id === 'road/common-2') road.path = road.path.slice(0,-1)
    if (/^road\/unit-\d$/.test(road.id)) {
      const [x,y]=road.path[0]!
      road.path=[[x,y],[x+145,y],[x+145,y+105],[x+90,y+105]]
      roads.push({id:`${road.id}-west-service`,path:[[x,y],[x-205,y],[x-205,y+210]],width:7,class:'service',turnRadius:10.5})
    }
  }
  roads.push(
    {id:'road/parking-access',path:[[-480,-205],[-480,-251.4]],width:8,class:'access',turnRadius:12},
    {id:'road/yard-entry',path:[[-215,-25],[-215,-60],[-135,-60],[-135,-10]],width:5,class:'access',turnRadius:7.5},
  )
  const walks: Array<{id:string;path:Array<[number,number]>;width:number}> = [
    {id:'walk/administration',path:[[-427,-165],[-427,-184],[-462,-184]],width:2.4},
    {id:'walk/training',path:[[-427,-100],[-427,-112],[-462,-112]],width:2.4},
    {id:'walk/workshop',path:[[-302,-170],[-302,-180],[-462,-180]],width:2.4},
    {id:'walk/security',path:[[-775,-195],[-775,-199],[-462,-199],[-462,-184]],width:2.4},
    {id:'walk/yard-control',path:[[-187,-20],[-187,-36],[-215,-36],[-215,-25]],width:2.4},
    {id:'parking/pedestrian-strip',path:[[-453,-264],[-453,-184],[-462,-184],[-462,-112]],width:3},
    {id:'walk/central-spine',path:[[-462,-184],[-462,-36],[-215,-36]],width:3},
  ]
  roads.push(...walks.map(walk=>({...walk,class:'pedestrian' as const,turnRadius:walk.width*1.5})))
  const circulation=circulationFromPaths(roads,campusArrangement.entrance.position as [number,number])
  const surfaces=circulationSurfaces(circulation)
  const oldRoadIds=new Set(roads.map(road=>road.id))
  const elements: Element[]=original.elements.filter(element=>!oldRoadIds.has(element.id)).map((element):Element=>{
    const material:Element['material']=element.id==='parking/pavement'?'pavement':element.id.startsWith('parking/line-')||element.id.startsWith('parking/row-')?'marking':element.material
    const path:Element['path']=element.id==='fence/switchyard'?[[-150,-65,0],[-150,-110,0],[150,-110,0],[150,115,0],[-150,115,0],[-150,-55,0]]:element.path
    return {...element,...(material?{material}: {}),...(path?{path}: {})}
  })
  for(const y of [-65,-55])elements.push({id:`gate/switchyard-${y}`,label:'Switchyard maintenance entrance gatepost',kind:'context',levelId:'site',pose:{position:[-150.15,y-.15,0],yaw:0},dimensions:{length:.3,width:.3,height:2.8},material:'steel',disposition:'installed'})
  for(const road of roads)elements.push({id:road.id,label:road.class==='pedestrian'?'Campus pedestrian access':'Plant service and delivery road',kind:'road',levelId:'site',pose:{position:[0,0,0],yaw:0},dimensions:{length:1,width:road.width,height:.04},path:road.path.map(([x,y])=>[x,y,.04]),disposition:'installed'})
  for(const [kind,surface] of Object.entries(surfaces))if(surface.length){
    const points=surface.flat(2),xs=points.map(point=>point[0]),ys=points.map(point=>point[1])
    elements.push({id:`pavement/${kind}`,label:kind==='roads'?'Connected campus road pavement':'Connected pedestrian surfaces',kind:'pavement',levelId:'site',pose:{position:[0,0,kind==='roads'?.045:.065],yaw:0},dimensions:{length:Math.max(...xs)-Math.min(...xs),width:Math.max(...ys)-Math.min(...ys),height:.01},surface,material:kind==='roads'?'pavement':'access',disposition:'installed'})
  }
  const source=physicalSourceSchema.parse({...original,elements,circulation,rootScope:{id:'site',label:'Shared plant campus',kind:'site'}})
  const bindings=structuredClone(campusBindings),bound=new Set(bindings.map(binding=>binding.physicalElementId)),reasons=new Map(campusCoverage.contextElements.map(element=>[element.physicalElementId,element.reason]))
  const coverage={...structuredClone(campusCoverage),contextElements:source.elements.filter(element=>!bound.has(element.id)).map(element=>({physicalElementId:element.id,reason:reasons.get(element.id)??'Authored circulation topology or its joined pavement derivative; no operational road, pedestrian or building state is invented.'}))}
  return{source,bindings,coverage}
}
