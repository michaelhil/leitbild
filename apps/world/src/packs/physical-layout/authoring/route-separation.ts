type Point=readonly[number,number,number]
const dot=(a:ReadonlyArray<number>,b:ReadonlyArray<number>)=>a.reduce((sum,value,axis)=>sum+value*b[axis]!,0),sub=(a:Point,b:Point)=>a.map((value,axis)=>value-b[axis]!),clamp=(value:number)=>Math.max(0,Math.min(1,value))
/** Closest points on two closed finite segments. No geometric welding or count
 * cutoff: this checks the actual retained centreline chords used by delivery. */
const distance=(p:Point,q:Point,a:Point,b:Point)=>{const u=sub(q,p),v=sub(b,a),w=sub(p,a),A=dot(u,u),B=dot(u,v),C=dot(v,v),D=dot(u,w),E=dot(v,w);if(!A||!C)throw Error('A conductor separation check requires nonzero physical segments');const den=A*C-B*B;let s=den>0?clamp((B*E-C*D)/den):0,t=(B*s+E)/C;if(t<0){t=0;s=clamp(-D/A)}else if(t>1){t=1;s=clamp((B-D)/A)}return Math.hypot(...w.map((value,axis)=>value+s*u[axis]!-t*v[axis]!))}
export const physicalRouteSeparation=(a:ReadonlyArray<Point>,b:ReadonlyArray<Point>):number=>{let minimum=Infinity;for(let i=1;i<a.length;i++)for(let j=1;j<b.length;j++)minimum=Math.min(minimum,distance(a[i-1]!,a[i]!,b[j-1]!,b[j]!));return minimum}
