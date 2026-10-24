export type V3=readonly[number,number,number];
export type M4=Float32Array;
export const add=(a:V3,b:V3):V3=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]];
export const sub=(a:V3,b:V3):V3=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
export const mul=(a:V3,s:number):V3=>[a[0]*s,a[1]*s,a[2]*s];
export const dot=(a:V3,b:V3)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
export const cross=(a:V3,b:V3):V3=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
export const norm=(a:V3):V3=>mul(a,1/(Math.hypot(...a)||1));
export function multiply(a:M4,b:M4):M4{const o=new Float32Array(16);for(let c=0;c<4;c++)for(let r=0;r<4;r++)for(let k=0;k<4;k++)o[c*4+r]!+=a[k*4+r]!*b[c*4+k]!;return o;}
export function perspective(fov:number,aspect:number,near:number,far:number):M4{const f=1/Math.tan(fov/2),v=new Float32Array(16);v[0]=f/aspect;v[5]=f;v[10]=(far+near)/(near-far);v[11]=-1;v[14]=2*far*near/(near-far);return v;}
export function orthographic(l:number,r:number,b:number,t:number,n:number,f:number):M4{return new Float32Array([2/(r-l),0,0,0,0,2/(t-b),0,0,0,0,-2/(f-n),0,-(r+l)/(r-l),-(t+b)/(t-b),-(f+n)/(f-n),1]);}
export function lookAt(eye:V3,target:V3,up:V3):M4{const z=norm(sub(eye,target)),x=norm(cross(up,z)),y=cross(z,x);return new Float32Array([x[0],y[0],z[0],0,x[1],y[1],z[1],0,x[2],y[2],z[2],0,-dot(x,eye),-dot(y,eye),-dot(z,eye),1]);}
export function project(p:V3,m:M4){const x=p[0],y=p[1],z=p[2],w=m[3]!*x+m[7]!*y+m[11]!*z+m[15]!;return {x:(m[0]!*x+m[4]!*y+m[8]!*z+m[12]!)/w,y:(m[1]!*x+m[5]!*y+m[9]!*z+m[13]!)/w,z:(m[2]!*x+m[6]!*y+m[10]!*z+m[14]!)/w,w};}
export type Bounds={min:V3;max:V3};
export function rayBox(origin:V3,dir:V3,b:Bounds):number|null{let lo=0,hi=Infinity;for(let i=0;i<3;i++){const d=dir[i]!,a=origin[i]!;if(Math.abs(d)<1e-10){if(a<b.min[i]!||a>b.max[i]!)return null;continue;}let t1=(b.min[i]!-a)/d,t2=(b.max[i]!-a)/d;if(t1>t2)[t1,t2]=[t2,t1];lo=Math.max(lo,t1);hi=Math.min(hi,t2);if(lo>hi)return null;}return lo;}
export function rayTriangle(o:V3,d:V3,a:V3,b:V3,c:V3):number|null{const e1=sub(b,a),e2=sub(c,a),p=cross(d,e2),det=dot(e1,p);if(Math.abs(det)<1e-8)return null;const inv=1/det,t=sub(o,a),u=dot(t,p)*inv;if(u<0||u>1)return null;const q=cross(t,e1),v=dot(d,q)*inv;if(v<0||u+v>1)return null;const hit=dot(e2,q)*inv;return hit>1e-5?hit:null;}
