// Test-only metadata observers. Weak resource keys never retain product geometry.
(() => {
  type Store = { id:number; context:number; alive:boolean; width:number; height:number; samples:number; format:number }
  type Framebuffer = { id:number; context:number; alive:boolean; depth?:number|undefined; color?:number|undefined; texture?:number|undefined; resolveTexture?:number|undefined }
  const ids=new WeakMap<object,number>(),stores=new Map<number,Store>(),frames=new Map<number,Framebuffer>()
  const surfaces=new Map<number,string>(),contexts=new WeakMap<WebGL2RenderingContext,{id:number;surface:string;renderbuffer:number|null;draw:number|null;read:number|null;unit:number;textures:Map<number,number|null>}>()
  let sequence=0
  const q:any={frames:[],tasks:[],texts:new Set<string>(),textAngles:new Map<string,{min:number;max:number;count:number}>(),fillTextCalls:0,annotationObserverMs:0,planSubmissionMs:0,planSubmissions:0,path2DConstructed:0,token:0,previous:0,started:performance.now(),pending:0,responses:[],workerMessages:[],activeWorkers:new Set<number>(),errors:[]}
  ;(window as any).__nativeMapProductProof=q
  const id=(object:object|null):number|null=>{if(!object)return null;let value=ids.get(object);if(value===undefined){value=++sequence;ids.set(object,value)}return value}
  const state=(gl:WebGL2RenderingContext)=>{let value=contexts.get(gl);if(!value){value={id:++sequence,surface:'',renderbuffer:null,draw:null,read:null,unit:gl.TEXTURE0,textures:new Map()};contexts.set(gl,value)}value.surface=gl.canvas instanceof HTMLCanvasElement?gl.canvas.className:'offscreen';surfaces.set(value.id,value.surface);return value}
  const storage=(gl:WebGL2RenderingContext,resource:number|null,width:number,height:number,samples:number,format:number)=>{if(resource!==null)stores.set(resource,{id:resource,context:state(gl).id,alive:true,width,height,samples,format})}
  const framebuffer=(gl:WebGL2RenderingContext,target:number)=>{const s=state(gl),key=target===gl.READ_FRAMEBUFFER?s.read:s.draw;return key===null?undefined:frames.get(key)}
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
  WebGL2RenderingContext.prototype.texImage2D=function(this:WebGL2RenderingContext,...args:any[]){const result=Reflect.apply(image,this,args);if(args.length>=9&&typeof args[3]==='number'&&typeof args[4]==='number'){const s=state(this);storage(this,s.textures.get(s.unit)??null,args[3],args[4],0,args[2])}return result} as typeof image
  const deleteTex=WebGL2RenderingContext.prototype.deleteTexture
  WebGL2RenderingContext.prototype.deleteTexture=function(object){const key=id(object),value=key===null?undefined:stores.get(key);if(value)value.alive=false;return deleteTex.call(this,object)}
  const attachTex=WebGL2RenderingContext.prototype.framebufferTexture2D
  WebGL2RenderingContext.prototype.framebufferTexture2D=function(target,attachment,kind,object,level){const value=framebuffer(this,target);if(value&&attachment===this.COLOR_ATTACHMENT0)value.texture=id(object)??undefined;return attachTex.call(this,target,attachment,kind,object,level)}
  const blit=WebGL2RenderingContext.prototype.blitFramebuffer
  WebGL2RenderingContext.prototype.blitFramebuffer=function(...args:Parameters<WebGL2RenderingContext['blitFramebuffer']>){const s=state(this),source=s.read===null?undefined:frames.get(s.read),destination=s.draw===null?undefined:frames.get(s.draw);if(source?.depth!==undefined&&stores.get(source.depth)?.format===this.DEPTH_COMPONENT32F)source.resolveTexture=destination?.texture;return blit.apply(this,args)}
  const fill=CanvasRenderingContext2D.prototype.fillText
  CanvasRenderingContext2D.prototype.fillText=function(...args:Parameters<CanvasRenderingContext2D['fillText']>){if(this.canvas.classList.contains('layout-plan-annotations')){const start=performance.now(),text=String(args[0]),matrix=this.getTransform(),angle=Math.atan2(matrix.b,matrix.a),previous=q.textAngles.get(text);q.fillTextCalls++;q.texts.add(text);q.textAngles.set(text,{min:previous?Math.min(previous.min,angle):angle,max:previous?Math.max(previous.max,angle):angle,count:(previous?.count??0)+1});q.annotationObserverMs+=performance.now()-start}return Reflect.apply(fill,this,args)}
  const NativePath=window.Path2D
  window.Path2D=new Proxy(NativePath,{construct(target,args){q.path2DConstructed++;return Reflect.construct(target,args,target)}})
  for(const name of ['fill','stroke','fillText','strokeText','clearRect'] as const){
    const original=CanvasRenderingContext2D.prototype[name]
    ;(CanvasRenderingContext2D.prototype as any)[name]=function(this:CanvasRenderingContext2D,...args:any[]){
      if(!this.canvas.classList.contains('layout-plan-annotations'))return Reflect.apply(original,this,args)
      const start=performance.now(),result=Reflect.apply(original,this,args);q.planSubmissionMs+=performance.now()-start;q.planSubmissions++;return result
    }
  }
  const workers=new WeakMap<Worker,{id:number;jobs:Set<number>}>(),post=Worker.prototype.postMessage,terminate=Worker.prototype.terminate
  Worker.prototype.postMessage=function(this:Worker,message:any,transfer:any){const physical=message?.kind==='register'||message?.kind==='prepare',source=Boolean(message?.design?.digest&&message?.compiler);if(physical||source){let value=workers.get(this);if(!value){value={id:++sequence,jobs:new Set()};workers.set(this,value);q.activeWorkers.add(value.id);this.addEventListener('message',(event:MessageEvent<any>)=>{const item=workers.get(this);if(!item)return;if(event.data?.id!==undefined&&item.jobs.delete(event.data.id))q.pending--;if(event.data?.kind==='error'||event.data?.ok===false)q.errors.push(event.data.message)})}if(physical){value.jobs.add(message.id);q.pending++}q.workerMessages.push({worker:value.id,kind:message.kind??'source',sourceKey:message.sourceKey??message.design.digest,...(message.kind==='prepare'?{key:message.key,view:message.view}:{})})}return Reflect.apply(post,this,[message,transfer])} as typeof post
  Worker.prototype.terminate=function(){const value=workers.get(this);if(value)q.activeWorkers.delete(value.id);return terminate.call(this)}
  new PerformanceObserver(list=>{for(const entry of list.getEntries())q.tasks.push({start:entry.startTime,duration:entry.duration})}).observe({type:'longtask',buffered:true})
  q.reset=()=>{q.frames=[];q.tasks=[];q.texts.clear();q.textAngles.clear();q.planSubmissionMs=0;q.planSubmissions=0;q.path2DConstructed=0;q.fillTextCalls=0;q.annotationObserverMs=0;q.previous=0;q.started=performance.now();const token=++q.token;const frame=(at:number)=>{if(q.token!==token)return;if(q.previous)q.frames.push(at-q.previous);q.previous=at;requestAnimationFrame(frame)};requestAnimationFrame(frame)}
  q.snapshot=()=>{
    const sorted=[...q.frames].sort((a:number,b:number)=>a-b),dom=document,physical=[]
    for(const value of frames.values())if(value.alive&&value.depth!==undefined){const depth=stores.get(value.depth);if(!depth?.alive||depth.format!==0x8cac)continue;const color=value.color===undefined?undefined:stores.get(value.color),texture=stores.get(value.resolveTexture??value.texture??-1);physical.push({context:value.context,surface:surfaces.get(value.context),width:depth.width,height:depth.height,samples:depth.samples,depthBytes:depth.width*depth.height*4*Math.max(1,depth.samples),colorBytes:color?.alive?color.width*color.height*4*Math.max(1,color.samples):0,resolveBytes:texture?.alive?texture.width*texture.height*4:0})}
    return{durationMs:performance.now()-q.started,frames:sorted.length,rafMedianMs:sorted[Math.floor(sorted.length*.5)],rafP95Ms:sorted[Math.floor(sorted.length*.95)],rafMaxMs:sorted.at(-1),longTasks:q.tasks,fillTextCalls:q.fillTextCalls,drawnTexts:[...q.texts].sort(),drawnTextAngles:[...q.textAngles].map(([text,angle]:[string,unknown])=>({text,...angle as object})),annotationObserverMs:q.annotationObserverMs,planSubmissionMs:q.planSubmissionMs,planSubmissions:q.planSubmissions,path2DConstructed:q.path2DConstructed,ownedPhysicalTargets:physical,draftingCanvases:[...document.querySelectorAll<HTMLCanvasElement>('.layout-plan-annotations')].map(canvas=>({width:canvas.width,height:canvas.height,rgbaBytesLowerBound:canvas.width*canvas.height*4})),pending:q.pending,activePhysicalWorkers:q.activeWorkers.size,errors:q.errors,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio,reportedLogicalCpus:navigator.hardwareConcurrency},status:dom.querySelector('.explorer-controls .evidence')?.textContent}
  }
})()
