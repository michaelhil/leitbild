import { createPlanWriter, planStyles as S, type Membership, type V2 } from './primitives.ts'
import type { PhysicalPlanPrimitive } from '../../../../core/packs/plan-drawing.ts'
import type { Foundation } from './foundation.ts'

/** Reusable plan symbols, derived from each occurrence's dimensions. These are
 * drawing representations, not extra physical parts or process components. */
export const drawEquipmentPlan = (output: PhysicalPlanPrimitive[], member: Membership, family: string, width: number, height: number, point: (p:V2)=>V2, rotation: number, foundation?:Foundation): void => {
  const begin=output.length
  const nominal:Record<string,V2>={hp:[7,4.8],lp:[9,11.2],generator:[12.5,6],exciter:[4,3.2],msr:[7.4,3],'stop-valve':[1.8,2.1],condenser:[9,15.8],'feed-pump':[12,2.7],'condensate-pump':[5.2,2.6]}
  const [w,h]=nominal[family]??[width,height], originalPoint=point
  point=p=>originalPoint([p[0]*width/w,p[1]*height/h])
  const {path:P,line:L,rect:R,ellipse:E}=createPlanWriter(output,member,point,rotation)
  const bolt=(x:number,y:number)=>E(x,y,.07,.07,S.bolt)
  const bolts=(step:number)=>{for(let x=.65;x<w-.4;x+=step){bolt(x,.2);bolt(x,h-.2)}for(let y=1;y<h-.6;y+=step){bolt(.2,y);bolt(w-.2,y)}}
  if(family==='hp'){
    R(-.3,.7,w+.6,h-1.4,S.plinth,.06)
    P([['M',0,h*.35],['L',.9,h*.15],['Q',w/2,-h*.12,w-.9,h*.15],['L',w,h*.35],['L',w,h*.65],['L',w-.9,h*.85],['Q',w/2,h*1.12,.9,h*.85],['L',0,h*.65],['Z']],S.casing)
    for(let x=1.4;x<w-.9;x+=.65)L(x,.65,x,h-.65,S.rib)
    L(0,h/2,w,h/2,S.split);R(.7,0,.9,.7,S.equipment,.09);R(w-1.6,h-.7,.9,.7,S.equipment,.09)
  }else if(family==='lp'){
    R(-.35,.8,w+.7,h-1.6,S.plinth,.07)
    P([['M',.9,0],['L',w-.9,0],['L',w,1],['L',w,h-1],['L',w-.9,h],['L',.9,h],['L',0,h-1],['L',0,1],['Z']],S.casing)
    R(.8,.85,w-1.6,h-1.7,{stroke:'rib',width:.045},.55)
    P([['M',1.4,h/2-1.4],['Q',w/2,h/2-2.9,w-1.4,h/2-1.4],['L',w-1.4,h/2+1.4],['Q',w/2,h/2+2.9,1.4,h/2+1.4],['Z']],S.hood)
    L(.35,h/2,w-.35,h/2,S.split);L(w/2,.45,w/2,h-.45,S.rib);R(w/2-.65,.25,1.3,.7,S.equipment,.08);R(w/2-.65,h-.95,1.3,.7,S.equipment,.08);bolts(.85)
  }else if(family==='generator'){
    R(-.25,-.4,w+.5,h+.8,S.plinth,.08);R(.65,0,w-1.3,h,S.motor,.6);R(.05,.5,1.2,h-1,S.equipment,.18);R(w-1.25,.5,1.2,h-1,S.equipment,.18)
    for(let x=1.8;x<w-1.3;x+=.65)L(x,.15,x,h-.15,S.rib)
    R(w*.42,h-.5,3,1.3,S.terminal,.1);R(w*.45,h+.8,2.3,.8,{fill:'light',stroke:'rib',width:.05},.07)
    for(const offset of [.25,1,1.75])L(w*.45+offset,h+.85,w*.45+offset,h+1.53,S.rib)
  }else if(family==='exciter'){
    R(-.2,.4,w+.4,h-.8,S.plinth,.05);R(0,0,w,h,S.motor,.4);E(.85,h/2,.45,h*.38,S.fine);E(w-.6,h/2,.25,h*.38,S.fine);for(let x=1.5;x<w-.7;x+=.38)L(x,.18,x,h-.18,S.rib)
  }else if(family==='msr'){
    R(1,.2,w-2,h-.4,S.plinth);R(0,0,w,h,{fill:'light',stroke:'equipment-line',width:.065},h/2);L(1.1,.1,1.1,h-.1,S.rib);L(w-1.1,.1,w-1.1,h-.1,S.rib)
    R(1.5,h-.2,.6,.7,S.equipment);R(w-2.2,-.5,.6,.7,S.equipment);E(w/2,h/2,w/2-.16,h/2-.18,S.fine);E(w*.75,h/2,.35,.35,S.equipment)
  }else if(family==='stop-valve'||family==='valve'){
    P([['M',.1,h/2-h*.26],['L',w-.1,h/2+h*.26],['L',w-.1,h/2-h*.26],['L',.1,h/2+h*.26],['Z']],S.casing)
    L(w/2,h/2,w/2,.2,{stroke:'equipment-line',width:.085});E(w/2,.25,w*.23,w*.23,S.equipment);L(w/2-w*.23,.25,w/2+w*.23,.25,S.fine)
  }else if(family==='condenser'){
    R(0,0,w,h,{fill:'hood',stroke:'equipment-line',width:.08},.18);R(.3,1.8,w-.6,h-3.6,S.equipment,.06);R(.4,.15,w-.8,1.4,{fill:'waterbox',stroke:'rib',width:.055},.08);R(.4,h-1.55,w-.8,1.4,{fill:'waterbox',stroke:'rib',width:.055},.08)
    for(let x=.8;x<w-.5;x+=.42)L(x,2.1,x,h-2.1,{stroke:'rib',width:.028})
    R(1.3,3.6,w-2.6,h-7.2,{stroke:'context-line',width:.045,dash:[.25,.15],hatch:{material:'rib',spacing:.5,width:.025,angle:45}})
    L(1.3,3.6,w-1.3,h-3.6,S.context);L(w-1.3,3.6,1.3,h-3.6,S.context);R(w-1.7,h*.45,2.4,2.4,{fill:'machine',stroke:'rib',width:.055},.16)
    for(const y of [1,h-1])for(const x of [w*.3,w*.7]){E(x,y,.39,.39,S.equipment);E(x,y,.18,.18,S.fine)}bolts(.95)
  }else if(family==='feed-pump'||family==='condensate-pump'||family==='pump'||family==='reactor-coolant-pump'){
    const big=family==='feed-pump',baseW=big?12:5.2,baseH=big?2.7:2.6,sx=w/baseW,sy=h/baseH
    const local=(p:V2)=>point([p[0]*sx,p[1]*sy]),draw=createPlanWriter(output,{...member,id:member.id+'/pump'},local,rotation), py=baseH/2
    draw.rect(-.18,-.15,baseW+.36,baseH+.3,S.plinth,.08)
    if(big){
      draw.path([['M',.3,py-.7],['L',.8,py-1.05],['L',4.4,py-1.05],['L',4.9,py-.65],['L',4.9,py+.65],['L',4.4,py+1.05],['L',.8,py+1.05],['L',.3,py+.7],['Z']],S.casing)
      for(let x=1.15;x<=4.15;x+=.46)draw.line(x,py-.9,x,py+.9,S.rib)
      draw.rect(.9,py-1.25,.6,.5,S.equipment);draw.rect(3.75,py+.75,.65,.6,S.equipment);draw.rect(4.9,py-.33,1.3,.66,{fill:'light',stroke:'rib',width:.05,hatch:{material:'rib',spacing:.23,width:.025,angle:45}},.14)
      draw.rect(.15,py-.5,.3,1,S.bearing,.06);draw.rect(6.5,.2,5.2,baseH-.4,S.motor,.22);for(let x=6.9;x<11.4;x+=.33)draw.line(x,.32,x,baseH-.32,S.rib);draw.rect(11.05,-.05,.62,.5,S.terminal,.04)
    }else{
      draw.path([['M',.3,py-.55],['C',.1,py-1.25,2.05,py-1.35,2.2,py-.25],['C',2.4,py+1.05,.9,py+1.25,.4,py+.5],['L',.2,py+.5],['L',.2,py-.55],['Z']],S.casing)
      draw.ellipse(1.25,py,.56,.56,S.fine);draw.ellipse(1.25,py,.15,.15,S.equipment);draw.rect(.55,0,.55,.45,S.equipment);draw.rect(0,py-.3,.5,.6,S.equipment);draw.rect(2.2,py-.25,.65,.5,S.terminal,.1);draw.rect(2.95,.4,2.15,baseH-.8,S.motor,.22);for(let x=3.35;x<4.8;x+=.33)draw.line(x,.52,x,baseH-.52,S.rib)
    }
  }else if(['tank','reactor-vessel','pressurizer','steam-generator'].includes(family)){
    E(w/2,h/2,w/2,h/2,S.casing);E(w/2,h/2,w*.43,h*.43,S.fine);E(w/2,h/2,w*.09,h*.09,S.equipment);L(w/2,0,w/2,h,S.center);L(0,h/2,w,h/2,S.center)
  }else if(['heat-exchanger','diesel-generator'].includes(family)){
    R(0,0,w,h,S.equipment,Math.min(w,h)*.15);for(let x=w*.1;x<w*.9;x+=w*.07)L(x,h*.1,x,h*.9,S.rib);R(w*.42,-h*.12,w*.16,h*.2,S.equipment)
  }else{
    // An explicit generic equipment-envelope representation, with its terminals
    // and centreline; never a fabricated detailed machinery family.
    R(0,0,w,h,S.equipment,Math.min(w,h)*.06);R(w*.15,h*.15,w*.7,h*.7,S.fine);L(0,h/2,w,h/2,S.center)
  }
  if(foundation){
    const body=output.splice(begin),draw=createPlanWriter(output,{...member,id:member.id+'/foundation'},originalPoint,rotation),[x,y]=foundation.offset
    const commands:import('./primitives.ts').Command[]=[['M',x,y],['L',x+foundation.length,y],['L',x+foundation.length,y+foundation.width],['L',x,y+foundation.width],['Z']]
    for(const h of foundation.holes??[])commands.push(['M',x+h.x,y+h.y],['L',x+h.x+h.length,y+h.y],['L',x+h.x+h.length,y+h.y+h.width],['L',x+h.x,y+h.y+h.width],['Z'])
    draw.path(commands,{...S.plinth,fillRule:'evenodd'})
    output.push(...body.filter(p=>p.kind==='text'||p.fill!=='plinth'))
  }
}
