import './native-map-route-instrumentation.ts'
// Test-only observations of real Plan ink and actual selection table uploads.
(() => {
 const q=(window as any).__nativeRouteProof
 if(!q)return
 q.planMatrix=null;q.selectionTables=[];q.operationSamples=[];q.requests=[]
 const sources=new Map<string,any>(),prepared=new Map<string,any>()
 const choose=(scene:any,response:any,elementId:string)=>{const index=scene.objects.findIndex((o:any)=>o.subjectIds.includes(elementId));if(index<0)return;const object=scene.objects[index];q.object={id:object.id,label:object.label,subjectIds:[...object.subjectIds],layerId:object.layerId};q.sourceKey=response.sourceKey;q.key=response.key;q.targetMeshIndices=response.meshes.flatMap((m:any,i:number)=>m.objectIndex===index?[i]:[]);q.points=response.meshes.filter((m:any)=>m.objectIndex===index).flatMap((m:any)=>{const values=[];for(let i=0;i+20<m.vertices.length;i+=21)values.push([0,1,2].map(a=>(m.vertices[i+a]+m.vertices[i+7+a]+m.vertices[i+14+a])/3+m.offset[a]));return values})}
 q.selectTarget=(elementId:string)=>{(window as any).__nativeRouteTarget.elementId=elementId;for(const[key,scene]of sources){const response=prepared.get(key);if(response&&scene.objects.some((o:any)=>o.subjectIds.includes(elementId))){choose(scene,response,elementId);return}}throw Error("Target has no actual registered/prepared source: "+elementId)}
 const inspect=Worker.prototype.postMessage
 Worker.prototype.postMessage=function(this:Worker,message:any,transfer:any){
  if(message?.kind==='register'){sources.set(message.sourceKey,message.scene);this.addEventListener('message',(event:MessageEvent<any>)=>{
   const r=event.data;if(r?.kind!=='prepared'||r.sourceKey!==message.sourceKey)return;prepared.set(r.sourceKey,r);choose(message.scene,r,(window as any).__nativeRouteTarget.elementId)
  })}
  return Reflect.apply(inspect,this,[message,transfer])
 } as typeof inspect
 const clear=CanvasRenderingContext2D.prototype.clearRect;CanvasRenderingContext2D.prototype.clearRect=function(...args:Parameters<CanvasRenderingContext2D['clearRect']>){if(this.canvas.classList.contains('layout-plan-annotations'))q.planMatrix=null;return clear.apply(this,args)}
 for(const name of ['fill','stroke'] as const){const original=CanvasRenderingContext2D.prototype[name];CanvasRenderingContext2D.prototype[name]=function(this:CanvasRenderingContext2D,...args:any[]){if(this.canvas.classList.contains('layout-plan-annotations')){const m=this.getTransform();if(!q.planMatrix&&Math.abs(m.a*m.d-m.b*m.c)>0)q.planMatrix=[m.a,m.b,m.c,m.d,m.e,m.f]}return Reflect.apply(original,this,args)} as any}
 for(const name of ['texImage2D','texSubImage2D']as const){const original=WebGL2RenderingContext.prototype[name];WebGL2RenderingContext.prototype[name]=function(this:WebGL2RenderingContext,...args:any[]){const data=args[8];if(data instanceof Float32Array&&q.targetMeshIndices?.length&&data.length>Math.max(...q.targetMeshIndices)*12+11){const selected=q.targetMeshIndices.map((i:number)=>({index:i,color:Array.from(data.subarray(i*12+8,i*12+12))}));if(selected.some((v:any)=>v.color[3]>0))q.selectionTables.push({at:performance.now(),selected})}return Reflect.apply(original,this,args)} as any}
 const projected3d=q.projected
 q.projectedFor=(mode:string)=>{
  if(mode==='3d')return projected3d()
  const m=q.planMatrix,canvas=document.querySelector<HTMLCanvasElement>('.layout-plan-annotations');if(!m||!canvas)return[]
  const box=canvas.getBoundingClientRect(),ratio=canvas.width/box.width,seen=new Set<string>()
  return q.points.flatMap(([x,y]:number[])=>{const px=(m[0]*x!+m[2]*y!+m[4])/ratio,py=(m[1]*x!+m[3]*y!+m[5])/ratio,key=px.toFixed(1)+','+py.toFixed(1);if(px<0||py<0||px>box.width||py>box.height||seen.has(key))return[];seen.add(key);return[{x:box.x+px,y:box.y+py}]})
 }
 const fetchOriginal=window.fetch;window.fetch=Object.assign(async function(...args:Parameters<typeof fetch>){const response=await fetchOriginal(...args),url=typeof args[0]==='string'?args[0]:args[0] instanceof URL?args[0].href:args[0].url;if(/\/displays\/(view|sample)(?:\?|$)/.test(url)){void response.clone().json().then(body=>{const refs=new Set<string>();const walk=(v:any):void=>{if(!v||typeof v!=='object')return;if(typeof v.ref==='string')refs.add(v.ref);for(const x of Object.values(v))if(x&&typeof x==='object')walk(x)};walk(body);q.requests.push({url,input:args[1]?.body,refs:[...refs]})}).catch(error=>q.errors.push(String(error)))}return response},fetchOriginal)
 window.addEventListener('message',event=>{if(event.origin!==location.origin||event.data?.type!=='world:layout-inspection-sample')return;const latest=event.data.snapshot?.latest;if(latest)q.operationSamples.push({scope:latest.scope,subject:latest.subjects[0],observations:latest.sample.observations})})
})()
