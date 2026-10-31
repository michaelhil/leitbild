// Reusable parametric symbol tooling extracted from accepted MIT-licensed trial. No per-plant placements.
import type {Box,Equipment} from './model.ts';
const esc=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const rect=(b:Box,c:string,extra='')=>`<rect class="${c}" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" ${extra}/>`;
const R=(x:number,y:number,w:number,h:number,c:string,r=0)=>rect({x,y,w,h},c,r?`rx="${r}"`:'');
const P=(d:string,c='fine',extra='')=>`<path class="${c}" d="${d}" ${extra}/>`;
const L=(x:number,y:number,xx:number,yy:number,c='fine')=>P(`M${x} ${y}L${xx} ${yy}`,c);
const T=(x:number,y:number,s:string,c='label',extra='')=>`<text x="${x}" y="${y}" class="${c}" ${extra}>${esc(s)}</text>`;
const C=(x:number,y:number,r:number,c='fine')=>`<circle cx="${x}" cy="${y}" r="${r}" class="${c}"/>`;
const E=(x:number,y:number,rx:number,ry:number,c='fine')=>`<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" class="${c}"/>`;
const G=(id:string,label:string,content:string,extra='')=>`<g id="${id}" aria-label="${esc(label)}" ${extra}><title>${esc(label)}</title>${content}</g>`;
function dimH(a:number,b:number,y:number,from:number,label:string){return L(a,from,a,y-180,'extension')+L(b,from,b,y-180,'extension')+L(a,y,b,y,'dim')+L(a-150,y+200,a+150,y-200,'dim')+L(b-150,y+200,b+150,y-200,'dim')+T((a+b)/2,y-340,label,'dimension');}
function dimV(a:number,b:number,x:number,from:number,label:string){return L(from,a,x+180,a,'extension')+L(from,b,x+180,b,'extension')+L(x,a,x,b,'dim')+L(x-200,a+150,x+200,a-150,'dim')+L(x-200,b+150,x+200,b-150,'dim')+T(x+350,(a+b)/2,label,'dimension',`transform="rotate(-90 ${x+350} ${(a+b)/2})"`);}
function bolts(w:number,h:number,step:number){let s='';for(let x=650;x<w-400;x+=step)s+=C(x,200,70,'bolt')+C(x,h-200,70,'bolt');for(let y=1000;y<h-600;y+=step)s+=C(200,y,70,'bolt')+C(w-200,y,70,'bolt');return s;}
function bearing(x:number,y:number){return R(x-600,y-900,1200,1800,'plinth',90)+R(x-390,y-600,780,1200,'bearing',120)+L(x-330,y,x+330,y,'center');}
function motor(x:number,y:number,w:number,h:number){let s=R(x-200,y+100,w+400,h-200,'plinth',50)+R(x,y,w,h,'motor',220);for(let p=x+400;p<x+w-300;p+=330)s+=L(p,y+120,p,y+h-120,'rib');return s+R(x+w-650,y-250,620,500,'terminal',40)+R(x-260,y+h*.27,400,h*.46,'equipment',80)+E(x+w-200,y+h/2,100,h*.35,'fine')+C(x+w-200,y+h/2,80,'bolt');}
function pump(e:Equipment){const{w,h}=e;const big=e.kind==='feed-pump',py=h/2;let s=R(-180,-150,w+360,h+300,'plinth',80);
 if(big){
  s+=P(`M300 ${py-700}L800 ${py-1050}H4400L4900 ${py-650}V${py+650}L4400 ${py+1050}H800L300 ${py+700}Z`,'pump');
  for(let x=1150;x<=4150;x+=460)s+=L(x,py-900,x,py+900,'rib');
  s+=R(900,py-1250,600,500,'nozzle')+R(3750,py+750,650,600,'nozzle')+C(1200,py-1000,130,'flange')+C(4075,py+1000,130,'flange');
  s+=R(4900,py-330,1300,660,'guard',140)+L(4900,py,6200,py,'center')+motor(6500,200,5200,h-400);
  s+=R(150,py-500,300,1000,'bearing',60)+L(150,py,450,py,'center');
 }else{
  s+=P(`M300 ${py-550}C100 ${py-1250} 2050 ${py-1350} 2200 ${py-250}C2400 ${py+1050} 900 ${py+1250} 400 ${py+500}L200 ${py+500}V${py-550}Z`,'pump')+C(1250,py,560,'fine')+C(1250,py,150,'hub')+R(550,0,550,450,'nozzle')+R(0,py-300,500,600,'nozzle')+R(2200,py-250,650,500,'guard',100)+motor(2950,400,2150,h-800);
 }
 return s;
}
export function equipmentBody(e:Equipment){const{w,h}=e;let s='';switch(e.kind){
 case 'hp':{
  s=R(-300,700,w+600,h-1400,'plinth',60)+P(`M0 ${h*.35}L900 ${h*.15}Q${w/2} ${-h*.12} ${w-900} ${h*.15}L${w} ${h*.35}V${h*.65}L${w-900} ${h*.85}Q${w/2} ${h*1.12} 900 ${h*.85}L0 ${h*.65}Z`,'casing');
  for(let x=1400;x<w-900;x+=650)s+=L(x,650,x,h-650,'rib');s+=L(0,h/2,w,h/2,'split')+R(700,0,900,700,'nozzle',90)+R(w-1600,h-700,900,700,'nozzle',90);break;}
 case 'lp':{
  s=R(-350,800,w+700,h-1600,'plinth',70)+P(`M900 0H${w-900}L${w} 1000V${h-1000}L${w-900} ${h}H900L0 ${h-1000}V1000Z`,'casing');
  s+=R(800,850,w-1600,h-1700,'exhaust-outline',550)+P(`M1400 ${h/2-1400}Q${w/2} ${h/2-2900} ${w-1400} ${h/2-1400}V${h/2+1400}Q${w/2} ${h/2+2900} 1400 ${h/2+1400}Z`,'hood');
  s+=L(350,h/2,w-350,h/2,'split')+L(w/2,450,w/2,h-450,'rib')+R(w/2-650,250,1300,700,'nozzle',80)+R(w/2-650,h-950,1300,700,'nozzle',80)+bolts(w,h,850);break;}
 case 'generator':{
  s=R(-250,-400,w+500,h+800,'plinth',80)+R(650,0,w-1300,h,'generator',600)+R(50,500,1200,h-1000,'equipment',180)+R(w-1250,500,1200,h-1000,'equipment',180);
  for(let x=1800;x<w-1300;x+=650)s+=L(x,150,x,h-150,'rib');
  s+=R(w*.42,h-500,3000,1300,'terminal',100)+R(w*.45,h+800,2300,800,'bus-duct',70)+L(w*.45+250,h+850,w*.45+250,h+1530,'rib')+L(w*.45+1000,h+850,w*.45+1000,h+1530,'rib')+L(w*.45+1750,h+850,w*.45+1750,h+1530,'rib');break;}
 case 'exciter':s=R(-200,400,w+400,h-800,'plinth',50)+R(0,0,w,h,'motor',400)+E(850,h/2,450,h*.38,'fine')+E(w-600,h/2,250,h*.38,'fine');for(let x=1500;x<w-700;x+=380)s+=L(x,180,x,h-180,'rib');break;
 case 'msr':s=R(1000,200,w-2000,h-400,'plinth')+R(0,0,w,h,'vessel',h/2)+L(1100,100,1100,h-100,'rib')+L(w-1100,100,w-1100,h-100,'rib')+R(1500,h-200,600,700,'nozzle')+R(w-2200,-500,600,700,'nozzle')+E(w/2,h/2,w/2-160,h/2-180,'fine')+C(w*.75,h/2,350,'flange');break;
 case 'stop-valve':s=P(`M100 ${h/2-550}L${w-100} ${h/2+550}V${h/2-550}L100 ${h/2+550}Z`,'casing')+L(w/2,h/2,w/2,200,'heavy')+C(w/2,250,420,'flange')+L(w/2-420,250,w/2+420,250,'fine')+L(w/2,-170,w/2,670,'fine');break;
 case 'condenser':{
  s=R(0,0,w,h,'condenser-shell',180)+R(300,1800,w-600,h-3600,'equipment',60)+R(400,150,w-800,1400,'waterbox',80)+R(400,h-1550,w-800,1400,'waterbox',80);
  for(let x=800;x<w-500;x+=420)s+=L(x,2100,x,h-2100,'tube');
  s+=R(1300,3600,w-2600,h-7200,'neck')+P(`M1300 3600L${w-1300} ${h-3600}M${w-1300} 3600L1300 ${h-3600}`,'hidden')+R(w-1700,h*.45,2400,2400,'hotwell',160);
  for(const y of [1000,h-1000])for(const x of [w*.3,w*.7])s+=C(x,y,390,'flange')+C(x,y,180,'fine');s+=bolts(w,h,950);break;}
 case 'feed-pump':case 'condensate-pump':s=pump(e);break;
 }
 return s;
}
