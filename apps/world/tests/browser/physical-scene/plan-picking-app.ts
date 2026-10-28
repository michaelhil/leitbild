import type { PackPhysicalScene, PhysicalPlanPrimitive, PhysicalSceneObject } from '../../../src/core/packs/scene.ts'
import { drawPhysicalPlanDrawing, physicalPlanContinuationPaths } from '../../../src/ui/physical-layout/plan-drawing.ts'
import { pickPhysicalPlan, physicalPlanOccurrenceBounds, type PhysicalPlanPickInput } from '../../../src/ui/map/physical-scene/plan-picking.ts'
import { defaultPhysicalSceneView } from '../../../src/ui/map/physical-scene/types.ts'
import { pickPhysicalPlan as previousPick, physicalPlanOccurrenceBounds as previousBounds } from '../../fixtures/physical-layout/plan-picking-before-entry-bounds.ts'

type Point = { x: number; y: number }
const results: unknown[] = [], failures: string[] = [], ratio = devicePixelRatio, canvas = document.createElement('canvas')
type OracleMode = 'before' | 'current' | 'brute'
let oracleMode: OracleMode | null = null, gridQueries = 0
const oracleCalls = { before: { stroke: 0, fill: 0, glyph: 0, metrics: 0 }, current: { stroke: 0, fill: 0, glyph: 0, metrics: 0 }, brute: { stroke: 0, fill: 0, glyph: 0, metrics: 0 } }
const restorers: Array<() => void> = []
for (const prototype of [CanvasRenderingContext2D.prototype, OffscreenCanvasRenderingContext2D.prototype]) {
 for (const [method, counter] of [['isPointInStroke', 'stroke'], ['isPointInPath', 'fill'], ['getImageData', 'glyph'], ['measureText', 'metrics']] as const) {
  const target = prototype as unknown as Record<string, (...args: unknown[]) => unknown>, original = target[method]!
  target[method] = function(this: unknown, ...args: unknown[]) { if (oracleMode !== null) oracleCalls[oracleMode][counter]++; return original.apply(this, args) }
  restorers.push(() => { target[method] = original })
 }
}
canvas.width = 800 * ratio; canvas.height = 600 * ratio; canvas.style.width = '800px'; canvas.style.height = '600px'; document.body.append(canvas)
const context = canvas.getContext('2d', { willReadFrequently: true })!
const object = (id: string, kind: PhysicalSceneObject['kind'] = 'equipment'): PhysicalSceneObject => ({ id, label: id, kind, subjectIds: kind === 'wall' || kind === 'slab' ? [] : [id], positions: [0,0,0,10,0,0,0,10,0], levelId: 'ground', scopeIds: ['room'] })
const box = { min: [0,0] as [number,number], max: [10,10] as [number,number] }
const rectangle = (id: string, owner: string | undefined, low = 1, high = 9): Extract<PhysicalPlanPrimitive, { kind: 'path' }> => ({ id, ...(owner ? { occurrenceId: owner } : {}), scopeIds: ['room'], depiction: 'projection', kind: 'path', bounds: box, fill: owner === 'wall' || owner === 'slab' ? 'architecture' : 'equipment', commands: [['M',low,low],['L',high,low],['L',high,high],['L',low,high],['Z']] })
const source = (primitives: PhysicalPlanPrimitive[], objects = [object('machine'),object('wall','wall'),object('slab','slab'),object('route','pipe')]): PackPhysicalScene => ({ id:'native-ink', revision:'test-only',targetObjectId:'owner',anchor:[0,0],bearing:0,bounds:{min:[0,0,0],max:[10,10,4]},levels:[{id:'ground',label:'Ground',elevation:0,cutHeight:2}],scopes:[{id:'room',label:'Room',kind:'space',bounds:{min:[2,2,0],max:[8,8,4]},levelIds:['ground']}],objects,planDrawing:{views:[{levelId:'ground',bounds:box,primitives}]} })
const sample = (input: PhysicalPlanPickInput, point: readonly [number,number]) => ({ x: input.frame.a*point[0]+input.frame.c*point[1]+input.frame.e, y:input.frame.b*point[0]+input.frame.d*point[1]+input.frame.f })
const input = (scene: PackPhysicalScene, degrees: number, scale: number, patch: Partial<PhysicalPlanPickInput['view']> = {}, scopeId: string | null = null): PhysicalPlanPickInput => { const angle=degrees*Math.PI/180,a=scale*Math.cos(angle),b=scale*Math.sin(angle),c=scale*Math.sin(angle),d=-scale*Math.cos(angle);return{scene,view:{...defaultPhysicalSceneView(scene.levels),...patch,mode:'2d'},scopeId,frame:{a,b,c,d,e:400-(a+c)*5,f:300-(b+d)*5},width:800,height:600,ratio,fontFamily:'Arial'} }
const paint = (value: PhysicalPlanPickInput) => { context.setTransform(1,0,0,1,0,0);context.clearRect(0,0,canvas.width,canvas.height);drawPhysicalPlanDrawing(context,{...value,project:points=>points.map(point=>sample(value,[point[0],point[1]])),palette:{materials:{},planMaterials:{equipment:[0,1,0],architecture:[0,0,1],ink:[1,0,0],pipe:[1,0,0]},defaultMaterial:[0,1,0],line:[0,0,0]},status:new Map()}) }
const comparedInputs = new WeakSet<PhysicalPlanPickInput>()
const compareGrid = (value: PhysicalPlanPickInput): void => {
 if (comparedInputs.has(value)) return
 comparedInputs.add(value)
 for (let y = -1; y <= 11; y += .5) for (let x = -1; x <= 11; x += .5) {
  const point = sample(value, [x, y])
  oracleMode = 'before'; const previous = previousPick(value, point)
  oracleMode = 'brute'; const brute = previousPick(value, point, true)
  oracleMode = 'current'; const current = pickPhysicalPlan(value, point)
  oracleMode = null; gridQueries++
  if (JSON.stringify(previous) !== JSON.stringify(brute) || JSON.stringify(current) !== JSON.stringify(brute)) throw Error('Native grid mismatch: ' + JSON.stringify({ point, local: [x, y], previous, brute, current }))
 }
}
const check = (name: string, value: PhysicalPlanPickInput, local: readonly [number,number], expected: string | null, blocker?: string) => {
 compareGrid(value)
 const point=sample(value,local),hit=pickPhysicalPlan(value,point),pixel=[...context.getImageData(Math.floor(point.x*ratio),Math.floor(point.y*ratio),1,1).data]
 if((hit?.occurrenceId??null)!==expected||(blocker!==undefined&&hit?.ownerOccurrenceId!==blocker))failures.push(name+': '+JSON.stringify({hit,expected,blocker,pixel}))
 results.push({name,hit,expected,blocker,pixel,point})
}
try {
 for(const [degrees,scale]of [[0,30],[73,35],[185,45]] as const){
  let scene=source([{...rectangle('ring','machine'),fillRule:'evenodd',commands:[['M',1,1],['L',9,1],['L',9,9],['L',1,9],['Z'],['M',3,3],['L',7,3],['L',7,7],['L',3,7],['Z']]}]),value=input(scene,degrees,scale);paint(value);check('evenodd filled'+degrees,value,[2,2],'machine');check('evenodd hole'+degrees,value,[5,5],null)
  scene=source([{id:'curve',occurrenceId:'machine',scopeIds:['room'],depiction:'projection',kind:'path',bounds:box,fill:'equipment',commands:[['M',1,1],['C',1,5,5,5,5,1],['L',5,0],['L',1,0],['Z']]}]);value=input(scene,degrees,scale);paint(value);check('curve inside'+degrees,value,[3,2],'machine');check('control hull is not hit'+degrees,value,[3,4.8],null)
  scene=source([{id:'ellipse',occurrenceId:'machine',scopeIds:['room'],depiction:'projection',kind:'ellipse',center:[5,5],radii:[3,1],rotation:45,bounds:box,fill:'equipment'}]);value=input(scene,degrees,scale);paint(value);check('rotated ellipse inside'+degrees,value,[6,6],'machine');check('ellipse bbox is not hit'+degrees,value,[5,7],null)
  scene=source([{id:'dash',occurrenceId:'route',scopeIds:['room'],depiction:'projection',kind:'path',bounds:box,stroke:'ink',width:.3,dash:[1,1],commands:[['M',1,5],['L',9,5]]}]);value=input(scene,degrees,scale);paint(value);check('actual dash'+degrees,value,[1.5,5],'route');check('dash gap'+degrees,value,[2.5,5],null)
  scene=source([rectangle('equipment','machine'),rectangle('wall-overlay','wall',3,7)]);value=input(scene,degrees,scale);paint(value);check('opaque architecture occludes'+degrees,value,[5,5],null,'wall');value=input(scene,degrees,scale,{wallOpacity:.2});paint(value);check('transparent wall admits behind'+degrees,value,[5,5],'machine')
  scene=source([rectangle('equipment','machine'),rectangle('bound-wall-overlay','wall',3,7)],[object('machine'),{...object('wall','wall'),subjectIds:['wall']}]);value=input(scene,degrees,scale,{wallOpacity:.2});paint(value);check('graph bound architecture remains target'+degrees,value,[5,5],'wall')
  value=input(scene,degrees,scale,{wallOpacity:0});paint(value);check('invisible bound architecture admits visible equipment'+degrees,value,[5,5],'machine')
  scene=source([rectangle('equipment','machine'),rectangle('floor-overlay','slab',3,7)]);value=input(scene,degrees,scale,{floorOpacity:.3});paint(value);check('transparent floor admits behind'+degrees,value,[5,5],'machine')
  scene=source([rectangle('equipment','machine'),{...rectangle('anonymous-overlay',undefined,3,7),fill:'architecture'}]);value=input(scene,degrees,scale);paint(value);check('anonymous opaque blocker'+degrees,value,[5,5],null);if(!pickPhysicalPlan(value,sample(value,[5,5]))?.occluded)failures.push('Anonymous ink did not block')
  scene=source([{...rectangle('hatch','machine'),fill:undefined,hatch:{material:'ink',spacing:1,width:.12,angle:0}}]);value=input(scene,degrees,scale);paint(value);check('hatch line'+degrees,value,[4,3],'machine');check('hatch gap'+degrees,value,[4,3.5],null)
  scene=source([{id:'clipped-route',occurrenceId:'route',scopeIds:['room'],depiction:'projection',kind:'path',bounds:box,stroke:'ink',width:.3,commands:[['M',0,5],['L',10,5]]}],[{...object('route','pipe'),clipToScope:true,spatialPath:{points:[[0,5,1],[10,5,1]],radius:.1}}]);value=input(scene,degrees,scale,{},'room');paint(value);check('clipped route inside'+degrees,value,[4,5],'route');check('clipped route outside'+degrees,value,[1,5],null)
  const footprint=physicalPlanOccurrenceBounds(value,'route');if(!footprint||footprint.min[0]<2||footprint.max[0]>8)failures.push('Route bounds escaped actual scope')
  const markers=physicalPlanContinuationPaths(scene,value.view,'room');let markerHit=false
  for(const marker of markers)for(let x=marker.bounds.min[0];x<=marker.bounds.max[0];x+=1/scale)for(let y=marker.bounds.min[1];y<=marker.bounds.max[1];y+=1/scale)if(pickPhysicalPlan(value,sample(value,[x,y]))?.primitiveId.startsWith('continuation/'))markerHit=true
  if(!markerHit)failures.push('No exact continuation marker hit'+degrees)
  const text:PhysicalPlanPrimitive={id:'native-glyph',occurrenceId:'machine',scopeIds:['room'],depiction:'annotation',kind:'text',anchor:[5,5],text:'O',height:3,rotation:0,align:'middle',material:'ink',bounds:box};scene=source([text]);value=input(scene,degrees,scale);paint(value)
  const image=context.getImageData(0,0,canvas.width,canvas.height);let positive:Point|null=null,hole:Point|null=null
  for(let y=0;y<canvas.height&&!hole;y++){let first=-1,last=-1;for(let x=0;x<canvas.width;x++){if(image.data[(y*canvas.width+x)*4+3]!>240){if(first<0)first=x;last=x;positive??={x:(x+.5)/ratio,y:(y+.5)/ratio}}}if(first>=0)for(let x=first+1;x<last;x++)if(image.data[(y*canvas.width+x)*4+3]===0){hole={x:(x+.5)/ratio,y:(y+.5)/ratio};break}}
  if(!positive||!hole)throw Error('Native glyph oracle could not find ink and transparent hole')
  compareGrid(value)
  const hit=pickPhysicalPlan(value,positive),miss=pickPhysicalPlan(value,hole);results.push({name:'native glyph coverage'+degrees,hit,miss,positive,hole});if(hit?.occurrenceId!=='machine'||miss!==null)failures.push('Glyph hit/transparent hole mismatch'+degrees)
  // Source order interleaves distant strokes with the same long-axis centroid;
  // a legitimate SAH leaf therefore contains members away from a query.
  scene=source(Array.from({length:32},(_,id)=>{const y=1+(id*17%32)/4;return{id:'loose-stroke-'+id,occurrenceId:'route',scopeIds:['room'],depiction:'projection' as const,kind:'path' as const,bounds:{min:[1,y] as [number,number],max:[9,y] as [number,number]},stroke:'pipe',width:.04,commands:[['M',1,y],['L',9,y]] as Extract<PhysicalPlanPrimitive,{kind:'path'}>['commands']}}))
  value=input(scene,degrees,scale);paint(value);compareGrid(value)
 }
 const absentSource=source([{id:'only-text',occurrenceId:'machine',scopeIds:['room'],depiction:'annotation',kind:'text',anchor:[5,5],text:'Only text',height:1,rotation:0,align:'middle',material:'ink',bounds:box}],[object('machine'),object('absent')])
 const beforeMetrics=oracleCalls.before.metrics,currentMetrics=oracleCalls.current.metrics
 for(const [degrees,scale]of[[0,15],[73,31],[185,60]]as const){
  const value=input(absentSource,degrees,scale)
  oracleMode='before';const previous=previousBounds(value,'absent')
  oracleMode='current';const current=physicalPlanOccurrenceBounds(value,'absent');oracleMode=null
  if(previous!==null||current!==null)failures.push('Unpainted occurrence acquired a Plan footprint')
 }
 const absenceMetrics={before:oracleCalls.before.metrics-beforeMetrics,current:oracleCalls.current.metrics-currentMetrics}
 if(absenceMetrics.before!==3||absenceMetrics.current!==0)failures.push('Missing owner visited native text metrics: '+JSON.stringify(absenceMetrics))
 for(const [degrees,scale]of[[0,15],[73,31],[185,60]]as const){
  const value=input(absentSource,degrees,scale),before=previousBounds(value,'machine'),current=physicalPlanOccurrenceBounds(value,'machine')
  if(JSON.stringify(before)!==JSON.stringify(current)||current===null)failures.push('Text-only footprint stopped using current camera/font metrics')
 }
 const replacement=source([{id:'replacement',occurrenceId:'absent',scopeIds:['room'],depiction:'annotation',kind:'text',anchor:[5,5],text:'Now present',height:1,rotation:0,align:'middle',material:'ink',bounds:box}],[object('absent')]),replacementInput=input(replacement,0,30)
 if(physicalPlanOccurrenceBounds(replacementInput,'absent')===null)failures.push('An old source absence leaked into replacement source')
 results.push({name:'immutable Plan owner absence and current text-only footprints',absenceMetrics})
 if (!(oracleCalls.current.stroke < oracleCalls.before.stroke)) failures.push('Individual bounds did not reduce native stroke queries')
 ;(window as any).__planInkProof={done:true,passed:failures.length===0,results,failures,ratio,gridQueries,oracleCalls,userAgent:navigator.userAgent}
}catch(error){(window as any).__planInkProof={done:true,passed:false,error:String(error),results,failures,ratio,gridQueries,oracleCalls}}
finally { oracleMode = null; restorers.forEach(restore => restore()) }
