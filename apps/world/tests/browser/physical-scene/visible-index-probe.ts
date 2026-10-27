import type { PackPhysicalScene } from '../../../src/core/packs/scene.ts'
import { createPhysicalBackend, type PhysicalDraw } from '../../../src/ui/map/physical-scene/backend.ts'
import { createPhysicalBackend as createReference } from './visible-index-reference.ts'
import { createPhysicalRenderPass } from '../../../src/ui/map/physical-scene/render-pass.ts'
import { createPhysicalArchitectureBackend } from '../../../src/ui/map/physical-scene/architecture-backend.ts'
import { preparePhysicalArchitectureBsp } from '../../../src/ui/map/physical-scene/architecture-bsp.ts'
import { preparePhysicalGeometry } from '../../../src/ui/map/physical-scene/preparation.ts'
import { defaultPhysicalSceneView } from '../../../src/ui/map/physical-scene/types.ts'
import { captureSceneGlState, restoreSceneGlState } from '../../../src/ui/map/physical-scene/gl-state.ts'
import { fullGlState, stateDifferences } from './gl-probes.ts'

const canvas = document.querySelector('canvas')!, gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true })!
if (!gl) throw Error('Visible-index differential fixture needs WebGL2')
canvas.width = canvas.height = 160 * devicePixelRatio
const unit = new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1])
const palette = { materials: { red: [1,0,0] as const, green: [0,1,0] as const, blue: [0,0,1] as const }, defaultMaterial: [.1,.2,.3] as const, line: [.1,.1,.1] as const, lineOpacity: .37, contextLineOpacity: .19 }
const source = (id: string, architecture = false): PackPhysicalScene => ({
  id, revision: 'test-only-visible-index', targetObjectId: id, anchor: [0,0], bearing: 0,
  bounds: { min: [-1,-1,-1], max: [1,1,1] }, levels: [{id:'ground',label:'Ground',elevation:-1,cutHeight:2}],
  objects: ['red','green','blue'].map((material, index) => {
    const x = -.88 + index * .51, right = x + .7, z = .3 - index * .2
    return { id: `${id}/${material}`, label: material, kind: architecture ? index === 0 ? 'wall' as const : index === 1 ? 'slab' as const : 'equipment' as const : 'equipment' as const,
      levelId:'site', subjectIds:[`${id}/${material}`], materials:[material],
      positions:[x,-.66,z,right,-.66,z,right,.66,z,x,-.66,z,right,.66,z,x,.66,z], normals:Array.from({length:6},()=>[0,0,1]).flat(),
      edgePolicy:'authored' as const, featureLines:[{material:'line',positions:[x,-.66,z,right,-.66,z,right,-.66,z,right,.66,z,right,.66,z,x,.66,z,x,.66,z,x,-.66,z,x,-.66,z,right,.66,z]}] }
  }),
})
const prepare = (scene: PackPhysicalScene) => preparePhysicalGeometry(scene, {...defaultPhysicalSceneView(scene.levels),mode:'3d',levelId:'all',cutaway:false},scene.id,scene.id)
const asset = prepare(source('family')), foreign = prepare(source('foreign')), archAsset = prepare(source('architecture',true))
const actual = createPhysicalBackend(gl,palette), reference = createReference(gl,palette), ordered = createPhysicalArchitectureBackend(gl,palette), pass = createPhysicalRenderPass(gl)
const indexMetrics=()=>actual.metrics as typeof actual.metrics & {visibilityUploads?:number;indexBytes?:number}
const expectIndices=Boolean((window as any).visibleIndexConfig?.expectIndices)
const host = fullGlState(gl), results: unknown[] = []
const matrix = (x=0,y=0,scale=1):Float32Array => {const value=unit.slice();value[0]=value[5]=scale;value[12]=x;value[13]=y;return value}
const draw = (key:string, selected:readonly number[], offset=matrix(), from=asset):PhysicalDraw => ({sceneId:key,asset:from,meshes:selected.map(index=>from.meshes[index]!),styles:[],matrix:offset,flat:true,architecture:{wallOpacity:1,floorOpacity:1}})
const all = [0,1,2]
const capture = (backend:ReturnType<typeof createPhysicalBackend>,draws:readonly PhysicalDraw[], fractional=false):Uint8Array => {
  const saved=captureSceneGlState(gl)
  try {
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.disable(gl.SCISSOR_TEST);gl.colorMask(true,true,true,true);gl.clearColor(1,1,1,1);gl.clear(gl.COLOR_BUFFER_BIT)
    pass.begin(canvas.width,canvas.height)
    backend.draw(fractional?ordered.opaqueDraws(draws):draws)
    if(fractional)ordered.draw(draws,0,unit)
    pass.composite(null,null,[0,0,canvas.width,canvas.height])
    const pixels=new Uint8Array(canvas.width*canvas.height*4);gl.bindFramebuffer(gl.READ_FRAMEBUFFER,null);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels)
    return pixels
  }finally{restoreSceneGlState(gl,saved)}
}
const compare = (name:string,draws:readonly PhysicalDraw[],fractional=false,allowEmpty=false) => {
  const before=fullGlState(gl), a=capture(reference,draws,fractional),b=capture(actual,draws,fractional)
  let differentPixels=0,maximum=0,painted=0
  for(let at=0;at<a.length;at+=4){let different=false;for(let channel=0;channel<4;channel++){const d=Math.abs(a[at+channel]!-b[at+channel]!);if(d)different=true;maximum=Math.max(maximum,d)}if(different)differentPixels++;if(a[at]!==255||a[at+1]!==255||a[at+2]!==255)painted++}
  const state=stateDifferences(before,fullGlState(gl)),error=gl.getError()
  results.push({name,differentPixels,maximum,painted,state,error,passed:differentPixels===0&&(allowEmpty||painted>0)&&!state.length&&!error})
}
// Enumerating all subsets of this three-mesh fixture is exact topology coverage,
// not a production count or quality cap.
for(let mask=0;mask<8;mask++)compare(`every-visible-subset-${mask}`,[draw('one',all.filter(index=>mask&(1<<index)))],false,mask===0)
compare('contiguous-instances-different-masks',[draw('A',[0],matrix(-.42,0,.54)),draw('B',[1,2],matrix(.42,0,.54))])
compare('contiguous-instances-same-union-reversed-masks',[draw('A',[1,2],matrix(-.42,0,.54)),draw('B',[0],matrix(.42,0,.54))])
compare('A1-foreign-B-A2-native-coplanar-order',[draw('A1',[0,2]),draw('foreign-B',[0,1,2],matrix(),foreign),draw('A2',[1,2])])
compare('A2-foreign-B-A1-native-coplanar-order',[draw('A2',[1,2]),draw('foreign-B',[0,1,2],matrix(),foreign),draw('A1',[0,2])])
compare('offscreen-and-clipped-native-lines',[draw('left',[0,2],matrix(-.7,.2,1.3)),draw('right',[1],matrix(.9,-.2,.6))])
const stable=[draw('warm',all)],uploads=actual.metrics.statusUploads
compare('warm-current-metadata',stable)
const warmedUploads=actual.metrics.statusUploads
const warmedVisibility=indexMetrics().visibilityUploads,warmedIndexBytes=indexMetrics().indexBytes
compare('camera-only-stable-metadata',[{...stable[0]!,matrix:matrix(.05,.03,.91)}])
const cameraUploads=actual.metrics.statusUploads
const cameraVisibility=indexMetrics().visibilityUploads,cameraIndexBytes=indexMetrics().indexBytes
results.push({name:'camera-does-not-upload-owner-metadata-or-indices',uploads,warmedUploads,cameraUploads,warmedVisibility,cameraVisibility,warmedIndexBytes,cameraIndexBytes,residentCpuBytes:actual.metrics.residentCpuBytes,expectIndices,passed:cameraUploads===warmedUploads&&(!expectIndices||typeof warmedVisibility==='number'&&cameraVisibility===warmedVisibility&&typeof warmedIndexBytes==='number'&&warmedIndexBytes>0&&cameraIndexBytes===warmedIndexBytes)})
compare('status-only-original-authored-contours',[{...stable[0]!,styles:asset.meshes.map(()=>({color:[.8,.1,.6] as const,emphasis:.65}))}])
compare('highlight-occurrence-and-colour',[{...stable[0]!,highlight:{sceneId:'warm',occurrenceId:asset.meshes[1]!.object.id,color:[.2,.8,.9]}}])
compare('highlight-colour-changes-on-same-occurrence',[{...stable[0]!,highlight:{sceneId:'warm',occurrenceId:asset.meshes[1]!.object.id,color:[.9,.8,.2]}}])
const dusk={...palette,materials:{red:[.42,.12,.1] as const,green:[.1,.35,.2] as const,blue:[.1,.2,.49] as const},line:[.8,.85,.7] as const,defaultMaterial:[.6,.7,.8] as const}
actual.setPalette(dusk);reference.setPalette(dusk);compare('palette-theme-and-fallback',stable);actual.setPalette(palette);reference.setPalette(palette)
const architectural=[draw('architecture',all,unit,archAsset)]
compare('architecture-full-opacity',architectural)
compare('ordinary-alpha-uses-actual-Float32-row',[{...architectural[0]!,architecture:{wallOpacity:1-2**-26,floorOpacity:1}}])
compare('architecture-zero-opacity',[{...architectural[0]!,architecture:{wallOpacity:0,floorOpacity:0}}])
const archOwners=archAsset.meshes.flatMap((mesh,meshIndex)=>mesh.object.kind==='wall'||mesh.object.kind==='slab'?[{mesh,meshIndex}]:[])
ordered.setAsset(preparePhysicalArchitectureBsp({key:'visible-index-cohort',sources:archOwners.map(({mesh,meshIndex})=>({id:`owner/${meshIndex}`,sceneId:'architecture',assetKey:archAsset.key,meshIndex,occurrenceId:mesh.object.id,matrix:new Float64Array(unit),vertices:mesh.vertices,lines:mesh.lines,materials:mesh.materials??mesh.object.materials??[],lineMaterials:mesh.lineMaterials??Array.from({length:mesh.lines.length/6},()=> 'line'),...(mesh.lineStyles?{lineStyles:mesh.lineStyles}:{})}))}))
compare('fractional-global-architecture-handoff',[{...architectural[0]!,architecture:{wallOpacity:.4,floorOpacity:1}}],true)
compare('fractional-and-zero-global-architecture-handoff',[{...architectural[0]!,architecture:{wallOpacity:0,floorOpacity:.4}}],true)
const beforeWithdrawal={...indexMetrics()}
compare('withdraw-all-current-instance-runs',[],false,true)
results.push({name:'withdrawn-run-releases-current-index-packets',before:beforeWithdrawal.indexBytes,after:indexMetrics().indexBytes,residentCpuBytes:actual.metrics.residentCpuBytes,expectIndices,passed:!expectIndices||indexMetrics().indexBytes===0})
const metrics={actual:{...actual.metrics},beforeWithdrawal,reference:{...reference.metrics},ordered:ordered.metrics(),pass:pass.metrics()}
actual.dispose();reference.dispose();ordered.dispose();pass.dispose()
const disposal={actual:{buffers:actual.metrics.liveBuffersAfterDisposal,programs:actual.metrics.liveProgramsAfterDisposal,textures:actual.metrics.liveTexturesAfterDisposal,residentCpuBytes:actual.metrics.residentCpuBytes,indexBytes:indexMetrics().indexBytes??0},reference:{buffers:reference.metrics.liveBuffersAfterDisposal,programs:reference.metrics.liveProgramsAfterDisposal,textures:reference.metrics.liveTexturesAfterDisposal},ordered:ordered.metrics(),pass:pass.metrics()}
const released=Object.values(disposal.actual).every(value=>value===0)&&Object.values(disposal.reference).every(value=>value===0)&&disposal.ordered.liveBuffersAfterDisposal===0&&disposal.ordered.liveProgramsAfterDisposal===0&&disposal.ordered.liveTexturesAfterDisposal===0&&disposal.pass.liveTextures===0&&disposal.pass.livePrograms===0&&disposal.pass.liveFramebuffers===0&&disposal.pass.liveRenderbuffers===0
const hostState=stateDifferences(host,fullGlState(gl))
;(window as any).visibleIndexProof={passed:(results as {passed:boolean}[]).every(value=>value.passed)&&released&&!hostState.length,results,metrics,disposal,hostState,dpr:devicePixelRatio,samples:metrics.pass.samples}
