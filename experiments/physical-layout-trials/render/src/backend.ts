import type {Instance} from './workload';
export type BackendMetrics={renders:number;drawCalls:number;geometryUploads:number;geometryBytes:number;stateUpdates:number;objects:number;disposeCount:number;disposedHandles?:{buffers:number;liveBuffersAfter:number;programs:number;liveProgramsAfter:number}};
export type Backend={draw:(matrix:Float32Array,objects:Instance[],status:ReadonlySet<string>)=>void;dispose:()=>void;metrics:BackendMetrics;ready:()=>boolean};
export const metrics=():BackendMetrics=>({renders:0,drawCalls:0,geometryUploads:0,geometryBytes:0,stateUpdates:0,objects:0,disposeCount:0});
