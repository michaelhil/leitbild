// Test-only metadata observers. Weak resource keys never retain product geometry.
(() => {
  type Store = { id:number; context:number; alive:boolean; width:number; height:number; samples:number; format:number }
  type Framebuffer = { id:number; context:number; alive:boolean; depth?:number|undefined; color?:number|undefined; texture?:number|undefined; resolveTexture?:number|undefined }
  const ids=new WeakMap<object,number>(),stores=new Map<number,Store>(),frames=new Map<number,Framebuffer>()
  const surfaces=new Map<number,string>(),contexts=new WeakMap<WebGL2RenderingContext,{id:number;surface:string;renderbuffer:number|null;draw:number|null;read:number|null;unit:number;array:WebGLBuffer|null;vao:WebGLVertexArrayObject|null;textures:Map<number,number|null>}>()
  let sequence=0
  const q:any={frames:[],tasks:[],texts:new Set<string>(),textAngles:new Map<string,{min:number;max:number;count:number}>(),fillTextCalls:0,annotationObserverMs:0,planSubmissionMs:0,planSubmissions:0,planClears:0,planClearTimes:[],planMethodCounts:{},planFrame:0,planPaintFrames:new Map<number,number>(),planTransformCounts:new Map<string,number>(),path2DConstructed:0,token:0,previous:0,started:performance.now(),pending:0,bspPending:0,bspMessages:[],bspResponses:[],responses:[],workerMessages:[],declaredSources:[],physicalDraws:new Map(),baseDraws:{calls:0,triangleVertices:0,lineVertices:0},orderedDraws:{frames:0,calls:0,indices:0,firstAt:null,lastAt:null},activeWorkers:new Set<number>(),errors:[]}
  ;(window as any).__nativeMapProductProof=q
  const id=(object:object|null):number|null=>{if(!object)return null;let value=ids.get(object);if(value===undefined){value=++sequence;ids.set(object,value)}return value}
  const state=(gl:WebGL2RenderingContext)=>{let value=contexts.get(gl);if(!value){value={id:++sequence,surface:'',renderbuffer:null,draw:null,read:null,unit:gl.TEXTURE0,array:null,vao:null,textures:new Map()};contexts.set(gl,value)}value.surface=gl.canvas instanceof HTMLCanvasElement?gl.canvas.className:'offscreen';surfaces.set(value.id,value.surface);return value}
  const storage=(gl:WebGL2RenderingContext,resource:number|null,width:number,height:number,samples:number,format:number)=>{if(resource!==null)stores.set(resource,{id:resource,context:state(gl).id,alive:true,width,height,samples,format})}
  const framebuffer=(gl:WebGL2RenderingContext,target:number)=>{const s=state(gl),key=target===gl.READ_FRAMEBUFFER?s.read:s.draw;return key===null?undefined:frames.get(key)}
  const census=Boolean((window as any).__nativeMapDiagnosticConfiguration?.visibilityCensus),meshCounts=new Map<string,{solid:number[];lines:number[]}>(),tableData=new Map<number,WeakRef<Float32Array>>();q.visibilityCensus=[]
  const capturePose=Boolean((window as any).__nativeMapDiagnosticConfiguration?.pose),instanceVaos=new WeakMap<WebGLVertexArrayObject,{buffer:WebGLBuffer;firstFloat:number}>(),instanceBuffers=new WeakSet<WebGLBuffer>(),instanceValues=new WeakMap<WebGLBuffer,Float32Array>();q.latestNativeMvp=new Map();q.inputButtons=new Map();q.activeButtons=0;q.readPixels={calls:0,cpuMs:0,whileHeld:0,heldCpuMs:0};q.latestPlanProjection=null;q.pointerEvents=[]
  if(capturePose)for(const type of ['pointerdown','pointermove','pointerup','pointercancel','mousemove','mousedown','mouseup'])window.addEventListener(type,event=>{const input=event as MouseEvent;q.activeButtons=input.buttons;if(q.token&&input.isTrusted&&type.startsWith('pointer'))q.pointerEvents.push({type,at:performance.now(),timeStamp:input.timeStamp,x:input.clientX,y:input.clientY,buttons:input.buttons});const key=`${type}/${input.buttons}/${input.isTrusted}`;q.inputButtons.set(key,(q.inputButtons.get(key)??0)+1)},true)
  const readPixels=WebGL2RenderingContext.prototype.readPixels
  WebGL2RenderingContext.prototype.readPixels=function(this:WebGL2RenderingContext,...args:any[]){if(!capturePose||!q.token)return Reflect.apply(readPixels,this,args);const at=performance.now(),result=Reflect.apply(readPixels,this,args),ms=performance.now()-at;q.readPixels.calls++;q.readPixels.cpuMs+=ms;if(q.activeButtons){q.readPixels.whileHeld++;q.readPixels.heldCpuMs+=ms}return result} as typeof readPixels
  const preparedArrays=new WeakMap<object,string>(),vertexBuffers=new WeakMap<WebGLBuffer,string>(),vertexArrays=new WeakMap<WebGLVertexArrayObject,WebGLBuffer>()
  const bindArray=WebGL2RenderingContext.prototype.bindBuffer
  WebGL2RenderingContext.prototype.bindBuffer=function(target,buffer){if(target===this.ARRAY_BUFFER)state(this).array=buffer;return bindArray.call(this,target,buffer)}
  const bindVertex=WebGL2RenderingContext.prototype.bindVertexArray
  WebGL2RenderingContext.prototype.bindVertexArray=function(vao){state(this).vao=vao;return bindVertex.call(this,vao)}
  const bufferData=WebGL2RenderingContext.prototype.bufferData
  WebGL2RenderingContext.prototype.bufferData=function(this:WebGL2RenderingContext,...args:any[]){const buffer=state(this).array,key=args[1]&&typeof args[1]==='object'?preparedArrays.get(args[1]):undefined;if(buffer&&key&&args[0]===this.ARRAY_BUFFER)vertexBuffers.set(buffer,key);if(capturePose&&buffer&&instanceBuffers.has(buffer)&&args[1] instanceof Float32Array)instanceValues.set(buffer,new Float32Array(args[1]));return Reflect.apply(bufferData,this,args)} as typeof bufferData
  const pointer=WebGL2RenderingContext.prototype.vertexAttribPointer
  WebGL2RenderingContext.prototype.vertexAttribPointer=function(...args:Parameters<WebGL2RenderingContext['vertexAttribPointer']>){const s=state(this);if(args[0]===0&&s.vao&&s.array)vertexArrays.set(s.vao,s.array);if(capturePose&&args[0]===5&&s.vao&&s.array&&vertexBuffers.has(vertexArrays.get(s.vao)!)){instanceVaos.set(s.vao,{buffer:s.array,firstFloat:args[5]/4});instanceBuffers.add(s.array)}return pointer.apply(this,args)}
  const physicalDraw=(gl:WebGL2RenderingContext,mode:number,vertices:number,instances:number)=>{const program=currentPrograms.get(gl);if(vertices>0&&program&&physicalPrograms.has(program)&&!orderedPrograms.get(program)){q.baseDraws.calls++;if(mode===gl.TRIANGLES)q.baseDraws.triangleVertices+=vertices*instances;else if(mode===gl.LINES)q.baseDraws.lineVertices+=vertices*instances}const s=state(gl),buffer=s.vao?vertexArrays.get(s.vao):undefined,key=buffer?vertexBuffers.get(buffer):undefined;if(mode===gl.TRIANGLES&&vertices>0&&key){let current=q.physicalDraws.get(key);if(!current){current={key,instances:0,lastAt:0};q.physicalDraws.set(key,current)}current.instances=Math.max(current.instances,instances);current.lastAt=performance.now();if(capturePose&&s.vao){const instance=instanceVaos.get(s.vao),values=instance?instanceValues.get(instance.buffer):undefined;if(values)q.latestNativeMvp.set(key.slice(0,key.lastIndexOf('/[')),{key,at:current.lastAt,instances,firstFloat:instance!.firstFloat,values})}}}
  const draw=WebGL2RenderingContext.prototype.drawArraysInstanced
  WebGL2RenderingContext.prototype.drawArraysInstanced=function(...args:Parameters<WebGL2RenderingContext['drawArraysInstanced']>){const result=draw.apply(this,args);physicalDraw(this,args[0],args[2],args[3]);return result}
  const currentPrograms=new WeakMap<WebGL2RenderingContext,WebGLProgram|null>(),physicalPrograms=new WeakSet<WebGLProgram>(),orderedPrograms=new WeakMap<WebGLProgram,boolean>(),orderedLocations=new WeakMap<WebGLUniformLocation,WebGLProgram>()
  const useProgram=WebGL2RenderingContext.prototype.useProgram,location=WebGL2RenderingContext.prototype.getUniformLocation,uniform=WebGL2RenderingContext.prototype.uniform1i,orderedDraw=WebGL2RenderingContext.prototype.drawElementsInstanced
  WebGL2RenderingContext.prototype.useProgram=function(program){currentPrograms.set(this,program);return useProgram.call(this,program)}
  WebGL2RenderingContext.prototype.getUniformLocation=function(program,name){const result=location.call(this,program,name);if(result&&name==='uDepthNear')physicalPrograms.add(program);if(result&&name==='uOrdered')orderedLocations.set(result,program);return result}
  WebGL2RenderingContext.prototype.uniform1i=function(target,value){const program=target?orderedLocations.get(target):null;if(program){orderedPrograms.set(program,Boolean(value));if(value===1&&physicalPrograms.has(program))q.orderedDraws.frames++}return uniform.call(this,target,value)}
  WebGL2RenderingContext.prototype.drawElementsInstanced=function(...args:Parameters<WebGL2RenderingContext['drawElementsInstanced']>){const result=orderedDraw.apply(this,args);physicalDraw(this,args[0],args[1],args[4]);const program=currentPrograms.get(this);if(program&&physicalPrograms.has(program)&&orderedPrograms.get(program)){const at=performance.now();q.orderedDraws.calls++;q.orderedDraws.indices+=args[1]*args[4];q.orderedDraws.firstAt??=at;q.orderedDraws.lastAt=at}return result}
  if(census){
    const drawCensus=WebGL2RenderingContext.prototype.drawArraysInstanced
    WebGL2RenderingContext.prototype.drawArraysInstanced=function(...args:Parameters<WebGL2RenderingContext['drawArraysInstanced']>){
      const result=drawCensus.apply(this,args),s=state(this),buffer=s.vao?vertexArrays.get(s.vao):undefined,key=buffer?vertexBuffers.get(buffer):undefined
      if(!key)return result
      const counts=meshCounts.get(key),instance=s.vao?instanceVaos.get(s.vao):undefined,values=instance?instanceValues.get(instance.buffer):undefined,texture=s.textures.get(this.TEXTURE1),table=texture===null||texture===undefined?undefined:tableData.get(texture)?.deref(),sizes=args[0]===this.TRIANGLES?counts?.solid:args[0]===this.LINES?counts?.lines:undefined
      if(!counts||!instance||!values||!table||!sizes){q.visibilityCensus.push({key,valid:false,reason:'missing real mesh/instance/object-table witness'});return result}
      const words=new Uint32Array(values.buffer,values.byteOffset,values.length),starts=Array.from({length:args[3]},(_,i)=>words[instance.firstFloat+i*17+16]!*4),union=new Uint8Array(sizes.length)
      let eligible=0
      for(const start of starts)for(let object=0;object<sizes.length;object++)if(table[start+object*12+7]!>=1){eligible+=sizes[object]!;union[object]=1}
      let unionVertices=0;for(let object=0;object<sizes.length;object++)if(union[object])unionVertices+=sizes[object]!
      const full=sizes.reduce((sum,count)=>sum+count,0);q.visibilityCensus.push({key,valid:args[1]===0&&args[2]===full,mode:args[0]===this.TRIANGLES?'triangles':'lines',instances:args[3],objects:sizes.length,submitted:args[2]*args[3],individuallyEligible:eligible,runUnion:unionVertices*args[3]})
      return result
    }
  }
  const bindRb=WebGL2RenderingContext.prototype.bindRenderbuffer
  WebGL2RenderingContext.prototype.bindRenderbuffer=function(target,object){state(this).renderbuffer=id(object);return bindRb.call(this,target,object)}
  const rb=WebGL2RenderingContext.prototype.renderbufferStorage
  WebGL2RenderingContext.prototype.renderbufferStorage=function(target,format,width,height){const result=rb.call(this,target,format,width,height);storage(this,state(this).renderbuffer,width,height,0,format);return result}
  const ms=WebGL2RenderingContext.prototype.renderbufferStorageMultisample
  WebGL2RenderingContext.prototype.renderbufferStorageMultisample=function(target,samples,format,width,height){const result=ms.call(this,target,samples,format,width,height);storage(this,state(this).renderbuffer,width,height,samples,format);return result}
  const deleteRb=WebGL2RenderingContext.prototype.deleteRenderbuffer
  WebGL2RenderingContext.prototype.deleteRenderbuffer=function(object){const key=id(object),value=key===null?undefined:stores.get(key);if(value)value.alive=false;return deleteRb.call(this,object)}
  const bindFb=WebGL2RenderingContext.prototype.bindFramebuffer
  WebGL2RenderingContext.prototype.bindFramebuffer=function(target,object){const s=state(this),key=id(object);if(key!==null&&!frames.has(key))frames.set(key,{id:key,context:s.id,alive:true});if(target===this.FRAMEBUFFER||target===this.DRAW_FRAMEBUFFER)s.draw=key;if(target===this.FRAMEBUFFER||target===this.READ_FRAMEBUFFER)s.read=key;return bindFb.call(this,target,object)}
  const deleteFb=WebGL2RenderingContext.prototype.deleteFramebuffer
  WebGL2RenderingContext.prototype.deleteFramebuffer=function(object){const key=id(object),value=key===null?undefined:frames.get(key);if(value)value.alive=false;return deleteFb.call(this,object)}
  const attachRb=WebGL2RenderingContext.prototype.framebufferRenderbuffer
  WebGL2RenderingContext.prototype.framebufferRenderbuffer=function(target,attachment,kind,object){const value=framebuffer(this,target),key=id(object);if(value){if(attachment===this.DEPTH_ATTACHMENT)value.depth=key??undefined;if(attachment===this.COLOR_ATTACHMENT0)value.color=key??undefined}return attachRb.call(this,target,attachment,kind,object)}
  const active=WebGL2RenderingContext.prototype.activeTexture
  WebGL2RenderingContext.prototype.activeTexture=function(unit){state(this).unit=unit;return active.call(this,unit)}
  const bindTex=WebGL2RenderingContext.prototype.bindTexture
  WebGL2RenderingContext.prototype.bindTexture=function(target,object){if(target===this.TEXTURE_2D){const s=state(this);s.textures.set(s.unit,id(object))}return bindTex.call(this,target,object)}
  const image=WebGL2RenderingContext.prototype.texImage2D
  WebGL2RenderingContext.prototype.texImage2D=function(this:WebGL2RenderingContext,...args:any[]){const result=Reflect.apply(image,this,args);if(args.length>=9&&typeof args[3]==='number'&&typeof args[4]==='number'){const s=state(this);storage(this,s.textures.get(s.unit)??null,args[3],args[4],0,args[2]);const texture=s.textures.get(s.unit);if(census&&texture!==null&&texture!==undefined&&args[8] instanceof Float32Array)tableData.set(texture,new WeakRef(args[8]))}return result} as typeof image
  if(census){const sub=WebGL2RenderingContext.prototype.texSubImage2D;WebGL2RenderingContext.prototype.texSubImage2D=function(this:WebGL2RenderingContext,...args:any[]){const result=Reflect.apply(sub,this,args),s=state(this),texture=s.textures.get(s.unit);if(texture!==null&&texture!==undefined&&args[8] instanceof Float32Array)tableData.set(texture,new WeakRef(args[8]));return result} as typeof sub}
  const deleteTex=WebGL2RenderingContext.prototype.deleteTexture
  WebGL2RenderingContext.prototype.deleteTexture=function(object){const key=id(object),value=key===null?undefined:stores.get(key);if(value)value.alive=false;return deleteTex.call(this,object)}
  const attachTex=WebGL2RenderingContext.prototype.framebufferTexture2D
  WebGL2RenderingContext.prototype.framebufferTexture2D=function(target,attachment,kind,object,level){const value=framebuffer(this,target);if(value&&attachment===this.COLOR_ATTACHMENT0)value.texture=id(object)??undefined;return attachTex.call(this,target,attachment,kind,object,level)}
  const blit=WebGL2RenderingContext.prototype.blitFramebuffer
  WebGL2RenderingContext.prototype.blitFramebuffer=function(...args:Parameters<WebGL2RenderingContext['blitFramebuffer']>){const s=state(this),source=s.read===null?undefined:frames.get(s.read),destination=s.draw===null?undefined:frames.get(s.draw);if(source?.depth!==undefined&&stores.get(source.depth)?.format===this.DEPTH_COMPONENT32F)source.resolveTexture=destination?.texture;return blit.apply(this,args)}
  const nativeCanvasMethods=Object.fromEntries(['fill','stroke','fillText','strokeText','clearRect'].map(name=>[name,(CanvasRenderingContext2D.prototype as any)[name]]))
  const fill=CanvasRenderingContext2D.prototype.fillText
  CanvasRenderingContext2D.prototype.fillText=function(...args:Parameters<CanvasRenderingContext2D['fillText']>){if(this.canvas.classList.contains('layout-plan-annotations')){const start=performance.now(),text=String(args[0]),matrix=this.getTransform(),angle=Math.atan2(matrix.b,matrix.a),previous=q.textAngles.get(text);q.fillTextCalls++;q.texts.add(text);q.textAngles.set(text,{min:previous?Math.min(previous.min,angle):angle,max:previous?Math.max(previous.max,angle):angle,count:(previous?.count??0)+1});q.annotationObserverMs+=performance.now()-start}return Reflect.apply(fill,this,args)}
  const NativePath=window.Path2D
  window.Path2D=new Proxy(NativePath,{construct(target,args){q.path2DConstructed++;return Reflect.construct(target,args,target)}})
  for(const name of ['fill','stroke','fillText','strokeText','clearRect'] as const){
    const original=CanvasRenderingContext2D.prototype[name]
    ;(CanvasRenderingContext2D.prototype as any)[name]=function(this:CanvasRenderingContext2D,...args:any[]){
      if(!this.canvas.classList.contains('layout-plan-annotations'))return Reflect.apply(original,this,args)
      q.planMethodCounts[name]=(q.planMethodCounts[name]??0)+1;if(name==='clearRect'){q.planClears++;q.planClearTimes.push(performance.now());q.planPaintFrames.set(q.planFrame,(q.planPaintFrames.get(q.planFrame)??0)+1)}if(capturePose&&name==='clearRect')q.latestPlanProjection=null;if(capturePose&&!q.latestPlanProjection&&(name==='fill'||name==='stroke')){const m=this.getTransform();q.latestPlanProjection={method:name,at:performance.now(),matrix:[m.a,m.b,m.c,m.d,m.e,m.f]};const key=JSON.stringify(q.latestPlanProjection.matrix);q.planTransformCounts.set(key,(q.planTransformCounts.get(key)??0)+1)}
      const start=performance.now(),result=Reflect.apply(original,this,args);q.planSubmissionMs+=performance.now()-start;q.planSubmissions++;return result
    }
  }
  const observedCanvasMethods=Object.fromEntries(['fill','stroke','fillText','strokeText','clearRect'].map(name=>[name,(CanvasRenderingContext2D.prototype as any)[name]]))
  q.minimalCanvasObservation=false;q.minimalPlanClearTimes=[];q.minimalPlanPaints=[];let minimalTarget:CanvasRenderingContext2D|null=null
  q.useMinimalCanvasObservation=()=>{
    const target=document.querySelector<HTMLCanvasElement>('.layout-plan-annotations')?.getContext('2d');if(!target)throw Error('Missing drafting context for minimal observer')
    for(const [name,method]of Object.entries(nativeCanvasMethods))(CanvasRenderingContext2D.prototype as any)[name]=method
    minimalTarget=target;window.Path2D=NativePath
    CanvasRenderingContext2D.prototype.clearRect=function(...args:Parameters<CanvasRenderingContext2D['clearRect']>){
      if(this===target){
        const at=performance.now(),token=q.token,paint:any={began:at,inputOrdinal:q.pointerEvents.length,frame:q.planFrame,transform:null,completed:null};q.minimalPlanClearTimes.push(at);q.minimalPlanPaints.push(paint)
        const first=()=>{const m=target.getTransform();paint.transform=[m.a,m.b,m.c,m.d,m.e,m.f];paint.firstPathAt=performance.now();delete (target as any).fill;delete (target as any).stroke}
        target.fill=function(this:CanvasRenderingContext2D,...args:any[]){first();return Reflect.apply(nativeCanvasMethods.fill,this,args)} as CanvasRenderingContext2D['fill']
        target.stroke=function(this:CanvasRenderingContext2D,...args:any[]){first();return Reflect.apply(nativeCanvasMethods.stroke,this,args)} as CanvasRenderingContext2D['stroke']
        queueMicrotask(()=>{if(q.token===token)paint.completed=performance.now()})
      }
      return Reflect.apply(nativeCanvasMethods.clearRect,this,args)
    }
    q.minimalCanvasObservation=true
  }
  q.restoreCanvasObservation=()=>{if(minimalTarget){delete (minimalTarget as any).fill;delete (minimalTarget as any).stroke};minimalTarget=null;for(const [name,method]of Object.entries(observedCanvasMethods))(CanvasRenderingContext2D.prototype as any)[name]=method;window.Path2D=new Proxy(NativePath,{construct(target,args){q.path2DConstructed++;return Reflect.construct(target,args,target)}});q.minimalCanvasObservation=false}
  const workers=new WeakMap<Worker,{id:number;jobs:Map<number,{started:number;key?:string;kind:string}>;bsp:{started:number;key:string}|null}>(),NativeWorker=Worker,post=NativeWorker.prototype.postMessage,terminate=NativeWorker.prototype.terminate
  const observeWorker=(worker:Worker,response:any):void=>{
    const item=workers.get(worker);if(!item)return
    if(item.bsp&&(response?.kind==='prepared'||response?.kind==='error')){
      const job=item.bsp;item.bsp=null;q.bspPending--;q.bspResponses.push({worker:item.id,started:job.started,responseAt:performance.now(),responseMs:performance.now()-job.started,keyLength:job.key.length,keyMatches:response.value?.key===job.key,responseKind:response.kind,vertexBytes:response.value?.vertices?.byteLength,fragments:response.value?.fragments?.length,nodes:response.value?.nodes?.length});if(response.kind==='error')q.errors.push(response.message);return
    }
    if(response?.id!==undefined){const job=item.jobs.get(response.id);if(job){item.jobs.delete(response.id);q.pending--;q.responses.push({...job,responseAt:performance.now(),responseMs:performance.now()-job.started,responseKind:response.kind})}}
    if(response?.kind==='prepared'&&response.buffers){preparedArrays.set(response.buffers.vertices,response.key);if(census)preparedArrays.set(response.buffers.lines,response.key);if(census)meshCounts.set(response.key,{solid:response.meshes.map((mesh:any)=>mesh.vertices.length/7),lines:response.meshes.map((mesh:any)=>mesh.lines.length/3)})}
    if(response?.kind==='error'||response?.ok===false)q.errors.push(response.message)
  }
  // Install before product onmessage: a successful one-shot BSP worker is
  // terminated synchronously by its product listener, not cancelled.
  ;(window as any).Worker=new Proxy(NativeWorker,{construct(target,args,constructor){const worker=Reflect.construct(target,args,constructor) as Worker;worker.addEventListener('message',event=>observeWorker(worker,event.data));return worker}})
  NativeWorker.prototype.postMessage=function(this:Worker,message:any,transfer:any){
    const bsp=message?.kind==='prepare'&&typeof message?.input?.key==='string'&&Array.isArray(message?.input?.sources),physical=!bsp&&(message?.kind==='register'||message?.kind==='prepare'),source=Boolean(message?.design?.digest&&message?.compiler)
    if(physical||source||bsp){
      let value=workers.get(this);if(!value){value={id:++sequence,jobs:new Map(),bsp:null};workers.set(this,value);q.activeWorkers.add(value.id)}
      if(bsp){value.bsp={started:performance.now(),key:message.input.key};q.bspPending++;q.bspMessages.push({worker:value.id,started:value.bsp.started,keyLength:message.input.key.length,sourceCount:message.input.sources.length})}
      if(message.kind==='register')q.declaredSources.push({sourceKey:message.sourceKey,geometryKey:message.sourceKey.replace(/\/detail$/,''),layers:message.scene.layers??[],meshLayerIds:[...new Set([...message.scene.objects.flatMap((object:any)=>object.layerId?[object.layerId]:[]),...(message.scene.planAnnotations??[]).flatMap((annotation:any)=>annotation.kind==='hatch'&&annotation.layerId?[annotation.layerId]:[])])].sort()})
      if(physical){value.jobs.set(message.id,{started:performance.now(),key:message.key,kind:message.kind});q.pending++}
      if(!bsp)q.workerMessages.push({worker:value.id,kind:message.kind??'source',sourceKey:message.sourceKey??message.design.digest,...(message.kind==='prepare'?{key:message.key,view:message.view}:{})})
    }
    return Reflect.apply(post,this,[message,transfer])
  } as typeof post
  NativeWorker.prototype.terminate=function(){const value=workers.get(this);if(value){q.activeWorkers.delete(value.id);if(value.bsp){q.bspPending--;q.bspResponses.push({worker:value.id,started:value.bsp.started,cancelled:true,keyLength:value.bsp.key.length});value.bsp=null}}return terminate.call(this)}
  new PerformanceObserver(list=>{for(const entry of list.getEntries())q.tasks.push({start:entry.startTime,duration:entry.duration})}).observe({type:'longtask',buffered:true})
  q.reset=()=>{q.readPixels={calls:0,cpuMs:0,whileHeld:0,heldCpuMs:0};q.inputButtons.clear();q.pointerEvents=[];q.physicalDraws.clear();q.baseDraws={calls:0,triangleVertices:0,lineVertices:0};q.visibilityCensus=[];q.orderedDraws={frames:0,calls:0,indices:0,firstAt:null,lastAt:null};q.frames=[];q.tasks=[];q.texts.clear();q.textAngles.clear();q.planSubmissionMs=0;q.planSubmissions=0;q.planClears=0;q.planClearTimes=[];q.minimalPlanClearTimes=[];q.minimalPlanPaints=[];q.planMethodCounts={};q.planFrame=0;q.planPaintFrames.clear();q.planTransformCounts.clear();q.path2DConstructed=0;q.fillTextCalls=0;q.annotationObserverMs=0;q.previous=0;q.started=performance.now();const token=++q.token;const frame=(at:number)=>{if(q.token!==token)return;if(q.previous)q.frames.push(at-q.previous);q.previous=at;q.planFrame++;requestAnimationFrame(frame)};requestAnimationFrame(frame)}
  q.snapshot=()=>{
    const sorted=[...q.frames].sort((a:number,b:number)=>a-b),dom=document,physical=[]
    for(const value of frames.values())if(value.alive&&value.depth!==undefined){const depth=stores.get(value.depth);if(!depth?.alive||depth.format!==0x8cac)continue;const color=value.color===undefined?undefined:stores.get(value.color),texture=stores.get(value.resolveTexture??value.texture??-1);physical.push({context:value.context,surface:surfaces.get(value.context),width:depth.width,height:depth.height,samples:depth.samples,depthBytes:depth.width*depth.height*4*Math.max(1,depth.samples),colorBytes:color?.alive?color.width*color.height*4*Math.max(1,color.samples):0,resolveBytes:texture?.alive?texture.width*texture.height*4:0})}
    return{pointerEvents:q.pointerEvents,inputButtons:[...q.inputButtons].map(([event,count]:[string,number])=>({event,count})),readPixels:{...q.readPixels,buttonObservationValid:q.inputButtons.size>0},firstActualPlanInkTransform:q.latestPlanProjection,nativeCameraProjection:[...q.latestNativeMvp.values()].map(({values,...meta}:any)=>({...meta,matrices:Array.from({length:meta.instances},(_,index)=>Array.from(values.subarray(meta.firstFloat+index*17,meta.firstFloat+index*17+16)))})),physicalDraws:[...q.physicalDraws.values()],baseDraws:q.baseDraws,visibilityCensus:q.visibilityCensus,orderedDraws:q.orderedDraws,declaredSources:q.declaredSources,windowStarted:q.started,durationMs:performance.now()-q.started,frames:sorted.length,rafMedianMs:sorted[Math.floor(sorted.length*.5)],rafP95Ms:sorted[Math.floor(sorted.length*.95)],rafMaxMs:sorted.at(-1),longTasks:q.tasks,fillTextCalls:q.fillTextCalls,drawnTexts:[...q.texts].sort(),drawnTextAngles:[...q.textAngles].map(([text,angle]:[string,unknown])=>({text,...angle as object})),annotationObserverMs:q.annotationObserverMs,planSubmissionMs:q.planSubmissionMs,planSubmissions:q.planSubmissions,minimalCanvasObservation:q.minimalCanvasObservation,minimalPlanClearTimes:q.minimalPlanClearTimes,minimalPlanPaints:q.minimalPlanPaints,planClears:q.planClears,planClearTimes:q.planClearTimes,planMethodCounts:q.planMethodCounts,planPaintFrames:[...q.planPaintFrames].map(([frame,count]:[number,number])=>({frame,count})),planTransformCounts:[...q.planTransformCounts].map(([matrix,count]:[string,number])=>({matrix:JSON.parse(matrix),count})),path2DConstructed:q.path2DConstructed,ownedPhysicalTargets:physical,draftingCanvases:[...document.querySelectorAll<HTMLCanvasElement>('.layout-plan-annotations')].map(canvas=>({width:canvas.width,height:canvas.height,rgbaBytesLowerBound:canvas.width*canvas.height*4})),pending:q.pending,bspPending:q.bspPending,bspMessages:q.bspMessages,bspResponses:q.bspResponses,activePhysicalWorkers:q.activeWorkers.size,errors:q.errors,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio,reportedLogicalCpus:navigator.hardwareConcurrency},status:dom.querySelector('.explorer-controls .evidence')?.textContent}
  }
})()
