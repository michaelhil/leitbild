import {sub,cross,norm,add,mul,type V3,type Bounds} from './math';
export type Color=readonly[number,number,number];
export const rgb=(hex:string):Color=>[parseInt(hex.slice(1,3),16)/255,parseInt(hex.slice(3,5),16)/255,parseInt(hex.slice(5,7),16)/255];
export const palette={floor:rgb('#d7d8ca'),wall:rgb('#e0e3d7'),steel:rgb('#637d72'),dark:rgb('#4f665e'),machine:rgb('#8fae9d'),hood:rgb('#acbfaa'),motor:rgb('#91b0b0'),light:rgb('#cad5c7'),plinth:rgb('#afb8a5'),pipe:rgb('#7c9d9f'),steam:rgb('#b5a389'),crane:rgb('#b39b65'),access:rgb('#a4c3a6'),outage:rgb('#c5b388'),waterbox:rgb('#92afa6'),ground:rgb('#e6e9df')};
// Interleaved position / normal / RGB. Meshes are finite, immutable study geometry.
export class Mesh{
 vertices:number[]=[];lines:number[]=[];
 tri(a:V3,b:V3,c:V3,color:Color,normal?:V3){const n=normal??norm(cross(sub(b,a),sub(c,a)));for(const p of[a,b,c])this.vertices.push(...p,...n,...color);}
 quad(a:V3,b:V3,c:V3,d:V3,color:Color){this.tri(a,b,c,color);this.tri(a,c,d,color);}
 line(a:V3,b:V3){this.lines.push(...a,...b);}
 box(x:number,y:number,z:number,w:number,h:number,d:number,c:Color,edges=true){
  if(w<=0||h<=0||d<=0)return;
  const p:V3[]=[[x,y,z],[x+w,y,z],[x+w,y,z+d],[x,y,z+d],[x,y+h,z],[x+w,y+h,z],[x+w,y+h,z+d],[x,y+h,z+d]];
  for(const f of[[0,1,2,3],[4,7,6,5],[0,4,5,1],[1,5,6,2],[2,6,7,3],[3,7,4,0]])this.quad(p[f[0]!]!,p[f[1]!]!,p[f[2]!]!,p[f[3]!]!,c);
  if(edges)for(const[a,b]of[[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]])this.line(p[a!]!,p[b!]!);
 }
 cylinder(a:V3,b:V3,r:number,c:Color,n=24){
  const axis=norm(sub(b,a)),u=norm(cross(axis,Math.abs(axis[1])<.9?[0,1,0]:[0,0,1])),v=cross(axis,u),ring=(p:V3,t:number)=>add(p,add(mul(u,Math.cos(t)*r),mul(v,Math.sin(t)*r)));
  for(let i=0;i<n;i++){const t=i*2*Math.PI/n,tt=(i+1)*2*Math.PI/n,aa=ring(a,t),ab=ring(a,tt),ba=ring(b,t),bb=ring(b,tt);this.quad(aa,ab,bb,ba,c);this.tri(a,ab,aa,c);this.tri(b,ba,bb,c);this.line(aa,ab);this.line(ba,bb);if(i%6===0)this.line(aa,ba);}
 }
 loftX(cx:number,cy:number,cz:number,profile:readonly(readonly[number,number,number])[],c:Color,n=32){
  const p=(j:number,i:number):V3=>{const[x,ry,rz]=profile[j]!;const t=i*2*Math.PI/n;return[cx+x,cy+Math.cos(t)*ry,cz+Math.sin(t)*rz];};
  for(let j=0;j<profile.length-1;j++)for(let i=0;i<n;i++){this.quad(p(j,i),p(j,i+1),p(j+1,i+1),p(j+1,i),c);if(j===0||j===profile.length-2)this.line(p(j+(j===0?0:1),i),p(j+(j===0?0:1),i+1));}
  for(const j of[0,profile.length-1])for(let i=0;i<n;i++)this.tri([cx+profile[j]![0],cy,cz],p(j,j===0?i+1:i),p(j,j===0?i:i+1),c);
 }
 frustum(x:number,y:number,z:number,w:number,d:number,h:number,tw:number,td:number,c:Color){
  const dx=(w-tw)/2,dz=(d-td)/2,p:V3[]=[[x,y,z],[x+w,y,z],[x+w,y,z+d],[x,y,z+d],[x+dx,y+h,z+dz],[x+dx+tw,y+h,z+dz],[x+dx+tw,y+h,z+dz+td],[x+dx,y+h,z+dz+td]];
  for(const f of[[0,1,2,3],[4,7,6,5],[0,4,5,1],[1,5,6,2],[2,6,7,3],[3,7,4,0]])this.quad(p[f[0]!]!,p[f[1]!]!,p[f[2]!]!,p[f[3]!]!,c);
  for(const[a,b]of[[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]])this.line(p[a!]!,p[b!]!);
 }
 plane(x:number,y:number,z:number,w:number,d:number,c:Color){this.quad([x,y,z],[x,y,z+d],[x+w,y,z+d],[x+w,y,z],c);}
 get bounds():Bounds{const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];for(let i=0;i<this.vertices.length;i+=9)for(let k=0;k<3;k++){min[k]=Math.min(min[k]!,this.vertices[i+k]!);max[k]=Math.max(max[k]!,this.vertices[i+k]!);}return {min:min as unknown as V3,max:max as unknown as V3};}
}
