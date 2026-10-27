import { Map as NativeMap, MercatorCoordinate, setWorkerUrl, type CustomLayerInterface, type StyleSpecification } from 'maplibre-gl'
import type { PackPhysicalScene } from '../../../src/core/packs/scene.ts'
import { createPhysicalSceneLayer } from '../../../src/ui/map/physical-scene/layer.ts'
import { createPhysicalSceneLayer as referenceLayer } from './map-phase-reference.ts'
import { preparePhysicalGeometry } from '../../../src/ui/map/physical-scene/preparation.ts'
import { defaultPhysicalSceneView, type PhysicalSceneView } from '../../../src/ui/map/physical-scene/types.ts'
import { physicalArchitectureCohort } from '../../../src/ui/map/physical-scene/architecture-cohort.ts'
import { preparePhysicalArchitectureBsp } from '../../../src/ui/map/physical-scene/architecture-bsp.ts'
import { captureSceneGlState, restoreSceneGlState } from '../../../src/ui/map/physical-scene/gl-state.ts'

// Test-only known geometry. Its packed buffers are shared by both complete
// renderers; native MapLibre sources, symbols and glyphs are drawn normally.
setWorkerUrl('/worker.mjs')
const anchor: [number, number] = [10, 60], local = MercatorCoordinate.fromLngLat(anchor), scale = local.meterInMercatorCoordinateUnits()
const coordinate = (x: number, y: number): [number, number] => { const p = new MercatorCoordinate(local.x + x * scale, local.y - y * scale).toLngLat(); return [p.lng, p.lat] }
const quad = (id: string, kind: 'wall' | 'slab' | 'equipment', material: string, z: number, left: number, right: number) => ({ id, label: id, kind, levelId: 'site', subjectIds: [id], edgePolicy: 'none' as const, material, positions: [left,-10,z,right,-10,z,right,10,z,left,-10,z,right,10,z,left,10,z], normals: Array.from({length:6},()=>[0,0,1]).flat() })
const scene: PackPhysicalScene = { id:'phase', revision:'known-map-phase-fixture',targetObjectId:'plant',anchor,bearing:0,bounds:{min:[-12,-10,0],max:[12,10,7]},levels:[{id:'floor',label:'Floor',elevation:0,cutHeight:8}],objects:[quad('base','equipment','blue',0,-12,12),quad('slab','slab','green',3,-9,9),quad('wall','wall','red',7,-6,6)] }
const palette = {materials:{red:[1,0,0] as const,green:[0,1,0] as const,blue:[0,0,1] as const},defaultMaterial:[.4,.4,.4] as const,line:[0,0,0] as const}
const baseView: PhysicalSceneView = {...defaultPhysicalSceneView(scene.levels),mode:'3d',levelId:'all',cutaway:false}
const asset = preparePhysicalGeometry(scene,baseView,'map-phase','map-phase')
type Phase = {name:'prerender'|'render';queries:number;clears:Array<{mask:number;target:number|null}>;drawTargets:Array<number|null>;entryTarget:number|null;entryViewport:number[]}
const allErrors:string[]=[]
const snapshots = new globalThis.Map<string,Uint8Array>()
const summaries:unknown[]=[]
const read = (gl:WebGL2RenderingContext) => {const old=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);gl.bindFramebuffer(gl.READ_FRAMEBUFFER,null);const bytes=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,bytes);gl.bindFramebuffer(gl.READ_FRAMEBUFFER,old);return bytes}
const style = (): StyleSpecification => ({version:8,glyphs:window.location.origin+'/fonts/{fontstack}/{range}.pbf',sources:{native:{type:'geojson',data:{type:'FeatureCollection',features:[{type:'Feature',properties:{id:'operational',label:'OPERATIONAL TEXT'},geometry:{type:'Point',coordinates:coordinate(0,0)}}]}}},layers:[{id:'ground',type:'background',paint:{'background-color':'#ece9df'}},{id:'native-circle',type:'circle',source:'native',paint:{'circle-radius':13,'circle-color':'#ff00ff','circle-stroke-width':2,'circle-stroke-color':'#ffffff'}},{id:'native-icon',type:'symbol',source:'native',layout:{'icon-image':'operational-icon','icon-offset':[36,0],'icon-allow-overlap':true}},{id:'native-label',type:'symbol',source:'native',layout:{'text-field':['get','label'],'text-font':['Noto Sans Regular'],'text-size':18,'text-offset':[0,2],'text-allow-overlap':true},paint:{'text-color':'#222222','text-halo-color':'#ffffff','text-halo-width':2}}]})
// A real WebGL framebuffer identity is tracked from GL calls. No extra queries
// are inserted per draw or inside either physical callback.
async function run(which:'reference'|'candidate', mode:'opaque'|'fractional', pitch:number,bearing:number) {
  const host=document.getElementById('map')!, errors:string[]=[], phases:Phase[]=[]
  const map=new NativeMap({container:host,style:style(),center:anchor,zoom:19.4,pitch,bearing,fadeDuration:0,attributionControl:false,canvasContextAttributes:{antialias:true,preserveDrawingBuffer:true}})
  map.on('error',event=>errors.push(event.error.message))
  await new Promise<void>(resolve=>map.once('load',()=>resolve()))
  const icon=new Uint8Array(16*16*4);for(let n=0;n<icon.length;n+=4){icon[n]=255;icon[n+1]=165;icon[n+2]=0;icon[n+3]=255}map.addImage('operational-icon',{width:16,height:16,data:icon})
  const gl=map.getCanvas().getContext('webgl2')!, ids=new WeakMap<WebGLFramebuffer,number>();let sequence=0
  const id=(value:WebGLFramebuffer|null)=>value?(ids.get(value)??(ids.set(value,++sequence),sequence)):null
  let currentDraw=gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer|null,viewport=Array.from(gl.getParameter(gl.VIEWPORT) as Int32Array),active:Phase|null=null
  const originals={bindFramebuffer:gl.bindFramebuffer,getParameter:gl.getParameter,viewport:gl.viewport,clear:gl.clear,drawArrays:gl.drawArrays,drawElements:gl.drawElements,drawArraysInstanced:gl.drawArraysInstanced,drawElementsInstanced:gl.drawElementsInstanced}
  gl.bindFramebuffer=function(target,buffer){if(target===gl.FRAMEBUFFER||target===gl.DRAW_FRAMEBUFFER)currentDraw=buffer;return originals.bindFramebuffer.call(gl,target,buffer)}
  gl.getParameter=function(pname){if(active)active.queries++;return originals.getParameter.call(gl,pname)}
  gl.viewport=function(x,y,width,height){viewport=[x,y,width,height];return originals.viewport.call(gl,x,y,width,height)}
  gl.clear=function(mask){active?.clears.push({mask,target:id(currentDraw)});return originals.clear.call(gl,mask)}
  gl.drawArrays=function(...args){active?.drawTargets.push(id(currentDraw));return originals.drawArrays.apply(gl,args)}
  gl.drawElements=function(...args){active?.drawTargets.push(id(currentDraw));return originals.drawElements.apply(gl,args)}
  gl.drawArraysInstanced=function(...args){active?.drawTargets.push(id(currentDraw));return originals.drawArraysInstanced.apply(gl,args)}
  gl.drawElementsInstanced=function(...args){active?.drawTargets.push(id(currentDraw));return originals.drawElementsInstanced.apply(gl,args)}
  const view={...baseView,wallOpacity:mode==='fractional'?.5:1,floorOpacity:mode==='fractional'?.5:1}
  let entries=[{scene,view,asset,meshes:asset.meshes,status:new globalThis.Map()}]
  const handle=(which==='candidate'?createPhysicalSceneLayer:referenceLayer)('physical',()=>entries,palette,error=>errors.push(error.message))
  let lastInput:Parameters<CustomLayerInterface['render']>[1]|null=null
  for(const name of ['prerender','render'] as const){const callback=handle.layer[name];if(!callback)continue;handle.layer[name]=function(context,input){lastInput=input;const phase:Phase={name,queries:0,clears:[],drawTargets:[],entryTarget:id(currentDraw),entryViewport:[...viewport]};phases.push(phase);active=phase;try{return callback.call(this,context,input)}finally{active=null}}}
  if(mode==='fractional'){const cohort=physicalArchitectureCohort(entries)!;handle.setArchitectureBsp(preparePhysicalArchitectureBsp(cohort),cohort.frame)}
  map.addLayer(handle.layer,'native-circle')
  const frame=()=>new Promise<void>(resolve=>{map.once('render',()=>resolve());map.triggerRepaint()})
  await new Promise<void>(resolve=>{map.once('idle',()=>resolve());map.triggerRepaint()});await frame();await frame()
  const before=handle.metrics(), pixels=read(gl), native=map.queryRenderedFeatures({layers:['native-circle','native-icon','native-label']}).map(feature=>feature.layer.id)
  let physicalPixels=0,textPixels=0,iconPixels=0;for(let at=0;at<pixels.length;at+=4){const r=pixels[at]!,g=pixels[at+1]!,b=pixels[at+2]!;if(Math.max(r,g,b)>120&&Math.min(r,g,b)<30&&!(r>240&&b>240))physicalPixels++;if(r<90&&Math.abs(r-g)<5&&Math.abs(g-b)<5)textPixels++;if(r===255&&g===165&&b===0)iconPixels++}
  for(let index=0;index<3;index++)await frame()
  const after=handle.metrics(), latest=phases.slice(-2), key=`${mode}/${pitch}/${bearing}`
  let differentBytes=0
  if(which==='reference')snapshots.set(key,pixels)
  else{const expected=snapshots.get(key)!;if(!expected||expected.length!==pixels.length)throw Error('Reference dimensions differ');for(let at=0;at<pixels.length;at++)differentBytes+=Number(pixels[at]!==expected[at])}
  const image=map.getCanvas().toDataURL('image/png'),phaseLocal:unknown[]=[],glCheckpoints:Array<{name:string,error:number}>=[]
  const check=(name:string)=>glCheckpoints.push({name,error:gl.getError()});check('actual-map-complete')
  if(which==='candidate'&&mode==='opaque'&&pitch===52&&handle.layer.prerender&&lastInput){
    if(devicePixelRatio===1){
      const extension=gl.getExtension('WEBGL_lose_context');if(!extension)throw Error('Required context-loss proof extension unavailable')
      const canvas=map.getCanvas(),lost=new Promise<void>(resolve=>canvas.addEventListener('webglcontextlost',()=>resolve(),{once:true})),restored=new Promise<void>(resolve=>canvas.addEventListener('webglcontextrestored',()=>resolve(),{once:true}))
      extension.loseContext();await lost;await new Promise(resolve=>setTimeout(resolve,0));extension.restoreContext();await restored
      await new Promise<void>(resolve=>{map.once('idle',()=>resolve());map.triggerRepaint()})
      const reinstalled=!map.getLayer('physical');if(reinstalled)map.addLayer(handle.layer,'native-circle');if(!map.hasImage('operational-icon'))map.addImage('operational-icon',{width:16,height:16,data:icon})
      await new Promise<void>(resolve=>{map.once('idle',()=>resolve());map.triggerRepaint()});await frame()
      const restoredPixels=read(gl);let differences=0;for(let at=0;at<pixels.length;at++)differences+=Number(pixels[at]!==restoredPixels[at]);phaseLocal.push({kind:'actual-map-context-restore-public-reinstall-pixels',reinstalled,differences,passed:differences===0});check('context-restored')
    }
    const state=captureSceneGlState(gl),input=lastInput,texture=gl.createTexture()!,target=gl.createFramebuffer()!
    const area=[13,17,gl.drawingBufferWidth,gl.drawingBufferHeight] as const,width=area[2]+40,height=area[3]+40;let disposalBefore=0
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,null)
    gl.bindFramebuffer(gl.FRAMEBUFFER,target);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0)
    if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw Error('Alternate host framebuffer incomplete')
    const reset=()=>{gl.bindFramebuffer(gl.FRAMEBUFFER,target);gl.viewport(...area);gl.disable(gl.SCISSOR_TEST);gl.colorMask(true,true,true,true);gl.clearColor(25/255,50/255,75/255,1);gl.clear(gl.COLOR_BUFFER_BIT)}
    const sample=()=>{gl.bindFramebuffer(gl.READ_FRAMEBUFFER,target);const data=new Uint8Array(width*height*4);gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,data);return data}
    const runPrepare=()=>handle.layer.prerender!.call(handle.layer,gl,input)
    const runComposite=()=>handle.layer.render.call(handle.layer,gl,input)
    try{
      runPrepare();reset();runComposite();const data=sample(),outside=[...data.slice(0,4)],at=((area[1]+Math.floor(area[3]/2))*width+area[0]+Math.floor(area[2]/2))*4,inside=[...data.slice(at,at+4)]
      check('alternate-target-complete');const phase=phases.at(-1)!
      phaseLocal.push({kind:'current-non-null-host-framebuffer-offset-viewport',outside,inside,phase,passed:outside.every((n,i)=>n===[25,50,75,255][i])&&inside.some((n,i)=>n!==[25,50,75,255][i])&&phase.drawTargets.every(n=>n===id(target))&&phase.entryViewport.every((n,i)=>n===area[i])&&phase.clears.length===0&&phase.queries===0})
      for(const kind of ['picks','palette','highlight'] as const){runPrepare();reset();if(kind==='picks')handle.invalidatePicks();else if(kind==='palette')handle.setPalette(palette);else handle.setHighlight(null);const before=handle.metrics()!.renderPass!.composites;runComposite();const after=handle.metrics()!.renderPass!.composites;phaseLocal.push({kind:`between-phase-${kind}-invalidation`,before,after,passed:before===after})}
      entries=[];runPrepare();reset();const emptyBefore=handle.metrics()!.renderPass!.composites;runComposite();phaseLocal.push({kind:'empty-frame-does-not-reuse-old-colour',before:emptyBefore,after:handle.metrics()!.renderPass!.composites,passed:emptyBefore===handle.metrics()!.renderPass!.composites})
      const planScene:PackPhysicalScene={...scene,planDrawing:{views:[{levelId:'floor',bounds:{min:[-12,-10],max:[12,10]},primitives:[{id:'base-plan',kind:'path',bounds:{min:[-12,-10],max:[12,10]},scopeIds:['root'],depiction:'projection',occurrenceId:'base',fill:'blue',commands:[['M',-12,-10],['L',12,-10],['L',12,10],['L',-12,10],['Z']]}]}]}}
      restoreSceneGlState(gl,state);check('before-map-plan-frame');entries=[{scene:planScene,view:{...view,mode:'2d',levelId:'floor'},asset,meshes:[],status:new globalThis.Map()}];map.jumpTo({pitch:0});await frame();await frame()
      check('map-plan-frame');const point=map.project(anchor),hit=handle.pick(point),planQueries=phases.slice(-2).map(p=>({name:p.name,queries:p.queries,draws:p.drawTargets.length,clears:p.clears.length}))
      phaseLocal.push({kind:'ink-only-frame-updates-plan-pick-without-gl-target',hit:hit?.occurrenceId??null,phases:planQueries,passed:hit?.occurrenceId==='base'&&planQueries.every(p=>p.queries===0&&p.draws===0&&p.clears===0)})
      entries=[{scene,view,asset,meshes:asset.meshes,status:new globalThis.Map()}];runPrepare();reset();disposalBefore=handle.metrics()!.renderPass!.composites
    }finally{gl.deleteFramebuffer(target);gl.deleteTexture(texture);restoreSceneGlState(gl,state);check('local-state-restored')}
    const beforeFailure=captureSceneGlState(gl),expectedErrors:string[]=[];let injectFailure=false
    const failure=createPhysicalSceneLayer('intentional-failure',()=>{if(injectFailure)throw Error('Intentional phase preparation refusal');return entries},palette,error=>expectedErrors.push(error.message))
    try{failure.layer.onAdd!.call(failure.layer,map,gl);failure.layer.prerender!.call(failure.layer,gl,input);const uploads=failure.metrics()!.geometryUploads;injectFailure=true;failure.layer.prerender!.call(failure.layer,gl,input);failure.layer.render.call(failure.layer,gl,input);phaseLocal.push({kind:'failed-new-prepare-cannot-composite-old-colour',uploads,errors:expectedErrors,composites:failure.metrics()!.renderPass!.composites,passed:uploads>0&&expectedErrors.length===1&&expectedErrors[0]==='Intentional phase preparation refusal'&&failure.metrics()!.renderPass!.composites===0&&failure.pick({x:320,y:240})===null})}
    finally{failure.dispose();restoreSceneGlState(gl,beforeFailure);check('intentional-failure-cleanup')}
    handle.dispose();runComposite();check('disposed-between-phases');phaseLocal.push({kind:'dispose-between-phases-clears-prepared-colour',before:disposalBefore,after:handle.metrics()!.renderPass!.composites,passed:disposalBefore===handle.metrics()!.renderPass!.composites})
  }
  const glError=gl.getError(), live=handle.metrics(),width=gl.drawingBufferWidth,height=gl.drawingBufferHeight;map.removeLayer('physical');const disposed=handle.metrics()
  Object.assign(gl,originals);map.remove()
  const summary={which,mode,pitch,bearing,devicePixelRatio,width,height,differentBytes,physicalPixels,textPixels,iconPixels,native,latest,phaseLocal,glCheckpoints,phases:phases.length,before,after,live,disposed,errors,glError,image}
  summaries.push(summary);allErrors.push(...errors)
  return summary
}
declare global{interface Window{mapPhaseProbe:Promise<unknown>}}
window.mapPhaseProbe=(async()=>{for(const mode of (new URLSearchParams(window.location.search).has('single')?['opaque']:['opaque','fractional']) as Array<'opaque'|'fractional'>)for(const [pitch,bearing]of(new URLSearchParams(window.location.search).has('single')?[[52,31]]:[[0,0],[52,31],[63,-137]])){await run('reference',mode,pitch!,bearing!);await run('candidate',mode,pitch!,bearing!)}return{summaries,errors:allErrors}})()
